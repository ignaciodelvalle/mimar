// Use-case: ownerProposeReturnToOrg — pet owner proposes returning the pet
// back to the originating org (post-adoption return or foster return).
//
// Auth (requireUserOrRedirect) is handled by the caller (action).

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, notifications, organizationMemberships, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { OwnerProposeReturnToOrgResult } from "../domain/types";
import { hasPendingProposal } from "./proposal-queries";
import { resolveReturnTargetOrg } from "./resolve-return-target-org";

export async function ownerProposeReturnToOrgUseCase({
  userId,
  petPublicToken,
  reason,
  notes,
  proposedAt,
  callerRole = "owner",
}: {
  userId: string;
  petPublicToken: string;
  reason: string;
  notes: string | null;
  proposedAt: string;
  callerRole?: "owner" | "foster";
}): Promise<OwnerProposeReturnToOrgResult> {
  // Verify the pet exists.
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  // Caller must hold the expected active role on this pet.
  const [callerOwnership] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, callerRole),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!callerOwnership) {
    return callerRole === "foster"
      ? { error: "No tenés un tránsito activo para esta mascota." }
      : { error: "No sos el dueño activo de esta mascota." };
  }

  // Fast pre-check outside the tx (optimistic path — avoids lock contention).
  const alreadyPending = await hasPendingProposal(pet.id, db);
  if (alreadyPending) {
    return { error: "Ya existe una propuesta de devolución pendiente para esta mascota." };
  }

  // THE TARGET ORGANISATION — resolved by `resolveReturnTargetOrg`, which this
  // use-case used to do inline in two branches. It moved out because the bearer
  // door's READ needs the SAME answer to decide whether a "Devolver" control may
  // be drawn at all, and two implementations of "who receives this animal back"
  // is how a screen ends up offering a control the writer refuses.
  //
  // ONE BEHAVIOUR CHANGE CAME WITH THE MOVE and it is the 2026-08-18 scar: the
  // parallel `shelter_custody` lookup was `.limit(1)` with no `ORDER BY`, so a
  // pet with two open custody rows addressed an ARBITRARY organisation. It is
  // now `desc(ownerships.startedAt)` — the same remedy `adoption-public-reads.ts`
  // applied after the public ficha credited a refuge that no longer answered for
  // the animal. Two open rows should not exist; when the invariant breaks, the
  // most recent wins, consistently.
  //
  // THE TWO REFUSAL SENTENCES STAY HERE, byte-for-byte, because they are copy a
  // person reads and they differ by role. The resolver answers with a code.
  const target = await resolveReturnTargetOrg({
    petId: pet.id,
    userId,
    callerRole,
    exec: db,
  });

  if (!target.ok) {
    if (target.code === "not_the_adopter") {
      return { error: "No sos el adoptante registrado para esta mascota." };
    }
    return callerRole === "foster"
      ? {
          error:
            "No se encontró una organización activa asociada a este tránsito. Contactá directamente al refugio.",
        }
      : {
          error:
            "No se encontró una adopción ni una organización asociada para esta mascota. Solo podés devolver mascotas recibidas a través de miMAR.",
        };
  }

  const toOrgId = target.target.orgId;
  // `?? "el refugio"` UNCHANGED: the id can dangle (a payload's
  // `previous_owner_organization_id` carries no foreign key), and this string
  // goes into a notification body rather than onto a screen.
  const orgDisplayName = target.target.displayName ?? "el refugio";
  const orgPublicToken = target.target.publicToken;

  // Look up the custody_episode case if one is open (for event attachment).
  const custodyCase = await findOpenCaseForPetAndKind(pet.id, "custody_episode");

  const now = new Date();
  let eventId = "";
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // TOCTOU fix: serialize concurrent proposals on the same pet.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      // Re-verify inside the tx after acquiring the lock.
      const pendingInTx = await hasPendingProposal(pet.id, tx);
      if (pendingInTx) {
        throw new Error("Ya existe una propuesta de devolución pendiente para esta mascota.");
      }

      const payload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: userId,
        from_organization_id: null,
        to_user_id: null,
        to_organization_id: toOrgId,
        reason,
        notes,
        matched_against_pet_id: null,
        proposed_at: proposedAt,
      });

      const [proposalEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_transfer_proposed",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: "owner",
          payload,
          caseId: custodyCase?.id ?? null,
        })
        .returning({ id: petEvents.id });

      eventId = proposalEvent.id;

      // Notify org admins.
      const admins = await tx
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, toOrgId),
            isNull(organizationMemberships.leftAt),
          ),
        )
        .limit(10);

      for (const admin of admins) {
        if (!admin.userId) continue;
        pendingNotifications.push({
          userId: admin.userId,
          notificationType: "custody_transfer_proposal_owner",
          severity: "urgent",
          title: `Devolución propuesta — ${pet.name}`,
          body: `El adoptante de ${pet.name} propone devolver la mascota a ${orgDisplayName}. Revisá la propuesta en el portal del refugio.`,
          relatedPetId: pet.id,
          relatedEventId: proposalEvent.id,
          relatedCaseId: custodyCase?.id ?? null,
          ctaUrl: orgPublicToken ? `/org/${orgPublicToken}/mascotas/${pet.publicToken}` : "/org",
        });
      }
    });
  } catch (err) {
    return {
      error: `No se pudo registrar la devolución: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
      // Web Push leg (ADR 2026-07-18 §4): urgent custodia, best-effort, never throws.
      const { sendPushForNotifications } = await import("@/lib/infra/web-push");
      await sendPushForNotifications(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true, eventId };
}
