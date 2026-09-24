// Use-case: orgAcceptOwnerReturn — org accepts an owner-initiated return proposal.
//
// Auth (requireOrgAccessByToken + custody.transfer capability) is handled by
// the caller (action).
//
// Steps in a tx (advisory lock):
//   1. Re-verify pending proposal for this org.
//   2. Verify owner still holds active owner row.
//   3. End any active foster row (fix 4).
//   4. Emit custody_transferred (owner → org shelter_custody).
//   5. End owner's ownership row.
//   6. Open new shelter_custody ownership for the org.
//   7. Notify the owner.

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, notifications, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import {
  ORG_CUSTODY_TAKEN_ERROR,
  findLiveOrgShelterCustody,
  isOrgCustodyCollision,
} from "@/lib/infra/org-custody";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { OrgAcceptOwnerReturnResult } from "../domain/types";
import { fetchPendingOwnerReturnProposalForOrg } from "./proposal-queries";

export async function orgAcceptOwnerReturnUseCase({
  orgId,
  orgDisplayName,
  actingUserId,
  petPublicToken,
}: {
  orgId: string;
  orgDisplayName: string;
  actingUserId: string;
  petPublicToken: string;
}): Promise<OrgAcceptOwnerReturnResult> {
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  // Quick pre-flight outside the tx (fast rejection without taking a lock).
  const preFlight = await fetchPendingOwnerReturnProposalForOrg(pet.id, orgId, db);
  if (!preFlight) {
    return { error: "No hay propuesta de devolución pendiente para esta mascota." };
  }

  // Find the custody_episode case if open (for event attachment).
  const custodyCase = await findOpenCaseForPetAndKind(pet.id, "custody_episode");

  const now = new Date();
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // Serialize concurrent accepts on the same pet with an advisory lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      // Re-verify inside the tx after acquiring the lock.
      const pending = await fetchPendingOwnerReturnProposalForOrg(pet.id, orgId, tx);
      if (!pending) {
        throw new Error("No hay propuesta de devolución pendiente para esta mascota.");
      }
      const { ownerUserId } = pending;

      // Verify the owner still holds their active owner ownership row.
      const [ownerOwnership] = await tx
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.ownerUserId, ownerUserId),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      if (!ownerOwnership) {
        throw new Error(
          "El dueño ya no tiene la custodia activa. No se puede procesar la devolución.",
        );
      }

      // One live ORG custody per pet (0195): step 6 below opens this org's
      // row and nothing in this flow closes another org's. Refuse under the
      // lock with the sentence the member reads, instead of a 23505 at step 6.
      if (await findLiveOrgShelterCustody(pet.id, tx)) {
        throw new Error(ORG_CUSTODY_TAKEN_ERROR);
      }

      // Fix 4: find and end any active foster row before the custody_transferred.
      const [fosterRow] = await tx
        .select({ id: ownerships.id, ownerUserId: ownerships.ownerUserId })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.role, "foster"),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);

      let fosterEndedEventId: string | null = null;
      if (fosterRow?.ownerUserId) {
        const fosterEndedPayload = validateEventPayload("foster_ended", {
          foster_user_id: fosterRow.ownerUserId,
          reason: "other",
          notes: "Tránsito cerrado por devolución al refugio aceptada por el refugio.",
        });
        const [fEnded] = await tx
          .insert(petEvents)
          .values({
            petId: pet.id,
            eventType: "foster_ended",
            occurredAt: now,
            recordedAt: now,
            recordedByUserId: actingUserId,
            authorRole: "shelter",
            authorOrganizationId: orgId,
            payload: fosterEndedPayload,
            caseId: custodyCase?.id ?? null,
          })
          .returning({ id: petEvents.id });
        fosterEndedEventId = fEnded.id;
        await tx.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, fosterRow.id));
      }

      // 1. Emit custody_transferred: owner → org shelter_custody.
      const transferPayload = validateEventPayload("custody_transferred", {
        from_user_id: ownerUserId,
        from_organization_id: null,
        to_user_id: null,
        to_organization_id: orgId,
        from_role: "owner",
        to_role: "shelter_custody",
        reason: "post_adoption_failed_return",
        matched_against_pet_id: null,
        foster_ended_event_id: fosterEndedEventId,
        notes: null,
      });
      const [transferEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_transferred",
          occurredAt: now,
          recordedAt: now,
          // Audit-integrity fix: attribute to the acting org member.
          recordedByUserId: actingUserId,
          authorRole: "shelter",
          authorOrganizationId: orgId,
          payload: transferPayload,
          caseId: custodyCase?.id ?? null,
        })
        .returning({ id: petEvents.id });

      // 2. End the owner's ownership row.
      await tx.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, ownerOwnership.id));

      // 3. Open a new shelter_custody ownership for the org.
      await tx.insert(ownerships).values({
        petId: pet.id,
        ownerOrganizationId: orgId,
        role: "shelter_custody",
        startedAt: now,
      });

      // 4. Notify the owner.
      pendingNotifications.push({
        userId: ownerUserId,
        notificationType: "custody_transfer_accepted_owner_side",
        severity: "info",
        title: `Devolución aceptada — ${pet.name}`,
        body: `${orgDisplayName} confirmó la recepción de ${pet.name}. La custodia fue transferida correctamente.`,
        relatedPetId: pet.id,
        relatedEventId: transferEvent.id,
        relatedCaseId: custodyCase?.id ?? null,
        ctaLabel: "Ver mi mascota",
        ctaUrl: `/mis-mascotas/${pet.publicToken}`,
      });
    });
  } catch (err) {
    // The pre-check's own sentence, or the index firing behind it (a custody
    // row committed after the read): one refusal, never the raw query text.
    if (
      isOrgCustodyCollision(err) ||
      (err instanceof Error && err.message === ORG_CUSTODY_TAKEN_ERROR)
    ) {
      return { error: ORG_CUSTODY_TAKEN_ERROR };
    }
    return {
      error: `No se pudo procesar la devolución: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true };
}
