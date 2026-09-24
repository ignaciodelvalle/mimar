// Use-case: orgRejectOwnerReturn — org rejects an owner-initiated return proposal.
//
// Auth (requireOrgAccessByToken + custody.transfer capability) is handled by
// the caller (action).
//
// Steps:
//   1. Look up pet, re-verify pending proposal for this org.
//   2. In a tx: emit custody_transfer_cancelled, notify the owner.

import { sql } from "drizzle-orm";

import { db, notifications, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { OrgRejectOwnerReturnResult } from "../domain/types";
import { fetchPendingOwnerReturnProposalForOrg } from "./proposal-queries";

export async function orgRejectOwnerReturnUseCase({
  orgId,
  orgDisplayName,
  actingUserId,
  petPublicToken,
  reason,
}: {
  orgId: string;
  orgDisplayName: string;
  actingUserId: string;
  petPublicToken: string;
  reason: string;
}): Promise<OrgRejectOwnerReturnResult> {
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  // Re-verify pending proposal.
  const pending = await fetchPendingOwnerReturnProposalForOrg(pet.id, orgId, db);
  if (!pending) {
    return { error: "No hay propuesta de devolución pendiente para esta mascota." };
  }
  const { proposal: latestProposal, ownerUserId } = pending;

  const now = new Date();
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // TOCTOU fix (parity with owner-reject-return): serialize against a
      // concurrent org-accept on the same pet with the pet's advisory key, then
      // re-verify the proposal is STILL pending UNDER the lock. Without it a
      // reject can race an accept — both having read the proposal as pending
      // before the accept committed — and emit a spurious
      // custody_transfer_cancelled into the immutable log after the accept
      // already resolved the proposal.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      const stillPending = await fetchPendingOwnerReturnProposalForOrg(pet.id, orgId, tx);
      if (!stillPending) {
        throw new Error("No hay propuesta de devolución pendiente para esta mascota.");
      }

      // Emit custody_transfer_cancelled (ARCH-B).
      const cancelPayload = validateEventPayload("custody_transfer_cancelled", {
        proposal_event_id: latestProposal.id,
        cancelled_by: "org_reject",
        reason: reason ?? null,
      });
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "custody_transfer_cancelled",
        occurredAt: now,
        recordedAt: now,
        // Audit-integrity fix: attribute to the acting org member.
        recordedByUserId: actingUserId,
        authorRole: "shelter",
        authorOrganizationId: orgId,
        payload: cancelPayload,
      });

      // Notify the owner.
      pendingNotifications.push({
        userId: ownerUserId,
        notificationType: "custody_transfer_auto_cancelled",
        severity: "info",
        title: `Propuesta rechazada — ${pet.name}`,
        body: `${orgDisplayName} rechazó tu propuesta de devolución de ${pet.name}. Motivo: ${reason}`,
        relatedPetId: pet.id,
        ctaLabel: "Ver mi mascota",
        ctaUrl: `/mis-mascotas/${pet.publicToken}`,
      });
    });
  } catch (err) {
    return {
      error: `No se pudo registrar el rechazo: ${err instanceof Error ? err.message : String(err)}`,
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
