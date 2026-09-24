// Use-case: actorCancelProposal — the actor who proposed the return cancels
// their own proposal.
//
// Auth (requireUserOrRedirect + optional requireOrgAccessByToken) is handled
// by the caller (action).

import { and, desc, eq, sql } from "drizzle-orm";

import { db, notifications, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { CancelProposalResult } from "../domain/types";
import { hasPendingProposal } from "./proposal-queries";

export async function actorCancelProposalUseCase({
  userId,
  petPublicToken,
  reason,
  actorOrgId,
}: {
  userId: string;
  petPublicToken: string;
  reason: string;
  actorOrgId?: string;
}): Promise<CancelProposalResult> {
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  // Find the latest proposal.
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
  const toUserId = (proposalPayload.to_user_id as string | null) ?? null;

  // Verify caller is the actor who proposed (user or org member).
  const isActor = fromUserId
    ? fromUserId === userId
    : actorOrgId != null && fromOrgId === actorOrgId;

  if (!isActor) {
    return { error: "Solo quien propuso la devolución puede cancelarla." };
  }

  const now = new Date();
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // TOCTOU fix: serialize against ownerAcceptReturnWriter (and the
      // propose writers) on the same pet.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      // Re-verify the proposal is still pending UNDER the lock.
      const stillPending = await hasPendingProposal(pet.id, tx);
      if (!stillPending) {
        throw new Error("No hay propuestas de devolución pendientes.");
      }

      // Emit custody_transfer_cancelled (ARCH-B).
      const cancelPayload = validateEventPayload("custody_transfer_cancelled", {
        proposal_event_id: latestProposal.id,
        cancelled_by: "actor_cancel",
        reason: reason ?? null,
      });
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "custody_transfer_cancelled",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: fromOrgId ? "shelter" : "owner",
        authorOrganizationId: fromOrgId ?? undefined,
        payload: cancelPayload,
      });

      // Notify the original owner.
      if (toUserId) {
        pendingNotifications.push({
          userId: toUserId,
          notificationType: "custody_transfer_auto_cancelled",
          severity: "info",
          title: `Propuesta cancelada — ${pet.name}`,
          body: `Quien tenía a ${pet.name} canceló la propuesta de devolución. Motivo: ${reason}`,
          relatedPetId: pet.id,
          ctaLabel: "Ver mi mascota",
          ctaUrl: `/mis-mascotas/${pet.publicToken}`,
        });
      }
    });
  } catch (err) {
    return {
      error: `No se pudo cancelar la propuesta: ${err instanceof Error ? err.message : String(err)}`,
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
