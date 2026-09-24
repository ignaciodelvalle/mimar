// Use-case: ownerRejectReturn — the pet owner explicitly rejects the pending
// return proposal.
//
// Auth (requireUserOrRedirect) is handled by the caller (action).
//
// Steps:
//   1. Look up pet, verify caller is active owner.
//   2. Find latest pending proposal.
//   3. In a tx (advisory lock): re-verify pending, emit custody_transfer_cancelled,
//      notify the actor.

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db, notifications, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { RejectReturnResult } from "../domain/types";
import { hasPendingProposal } from "./proposal-queries";

export async function ownerRejectReturnUseCase({
  userId,
  petPublicToken,
  reason,
}: {
  userId: string;
  petPublicToken: string;
  reason: string;
}): Promise<RejectReturnResult> {
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  // Verify caller is the active owner.
  const [ownerOwnership] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!ownerOwnership) return { error: "No sos el dueño activo de esta mascota." };

  // Find the latest pending proposal.
  const [latestProposal] = await db
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);
  if (!latestProposal) return { error: "No hay propuestas de devolución pendientes." };

  const proposalPayload = latestProposal.payload as Record<string, unknown>;
  const fromUserId = (proposalPayload.from_user_id as string | null) ?? null;
  const fromOrgId = (proposalPayload.from_organization_id as string | null) ?? null;

  const now = new Date();
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // TOCTOU fix: serialize against ownerAcceptReturnWriter (and the
      // propose writers) on the same pet. Same advisory key as the accept
      // path — without it a reject can race an accept and emit a spurious
      // custody_transfer_cancelled into the immutable log.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      // Re-verify the proposal is still pending UNDER the lock. If an accept
      // (or another cancel) already resolved it, do not emit a cancellation.
      const stillPending = await hasPendingProposal(pet.id, tx);
      if (!stillPending) {
        throw new Error("No hay propuestas de devolución pendientes.");
      }

      // Emit custody_transfer_cancelled (ARCH-B).
      const cancelPayload = validateEventPayload("custody_transfer_cancelled", {
        proposal_event_id: latestProposal.id,
        cancelled_by: "owner_reject",
        reason: reason ?? null,
      });
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "custody_transfer_cancelled",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        payload: cancelPayload,
      });

      // Notify the actor.
      const notifyUserId = fromUserId;
      if (notifyUserId) {
        pendingNotifications.push({
          // no-cta: informational status update — the recipient only needs to know the
          // proposal was rejected; there is no action for them to take.
          userId: notifyUserId,
          notificationType: "custody_transfer_auto_cancelled",
          severity: "info",
          title: `Propuesta rechazada — ${pet.name}`,
          body: `El dueño de ${pet.name} rechazó la propuesta de devolución. Motivo: ${reason}`,
          relatedPetId: pet.id,
        });
      } else if (fromOrgId) {
        const proposalAuthorId = latestProposal.recordedByUserId;
        if (proposalAuthorId) {
          pendingNotifications.push({
            // no-cta: informational status update — the recipient only needs to know the
            // proposal was rejected; there is no action for them to take.
            userId: proposalAuthorId,
            notificationType: "custody_transfer_auto_cancelled",
            severity: "info",
            title: `Propuesta rechazada — ${pet.name}`,
            body: `El dueño de ${pet.name} rechazó la propuesta de devolución. Motivo: ${reason}`,
            relatedPetId: pet.id,
          });
        }
      }
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
