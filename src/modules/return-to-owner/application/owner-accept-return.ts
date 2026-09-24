// Use-case: ownerAcceptReturn — the pet owner accepts the pending return proposal.
//
// Auth (requireUserOrRedirect) is handled by the caller (action).
//
// Preconditions (§6.3 + §6.4 of the spec):
//   1. Actor still holds active shelter_custody for this pet.
//   2. Pet is still 'lost' (not already found by another path).
//   3. No subsequent custody_transferred event after the latest proposal.
//   4. The proposal's to_user_id matches the accepting owner.
//   5. A pending proposal exists (not already cancelled or transferred).
//
// If any precondition fails → auto-cancel path: emit custody_transfer_cancelled,
// notify the actor, return { ok: true, autoCancelled: true, reason }.

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { cases, db, notifications, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { AcceptReturnResult } from "../domain/types";
import { autoCancelBody, hasPendingProposal } from "./proposal-queries";

export async function ownerAcceptReturnUseCase({
  userId,
  petPublicToken,
}: {
  userId: string;
  petPublicToken: string;
}): Promise<AcceptReturnResult> {
  // Verify caller is the active owner of this pet.
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  const [ownerOwnership] = await db
    .select({ id: ownerships.id, ownerUserId: ownerships.ownerUserId })
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

  // Find the latest custody_transfer_proposed event for this pet.
  const [latestProposal] = await db
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  if (!latestProposal) return { error: "No hay propuestas de devolución pendientes." };

  const proposalPayload = latestProposal.payload as Record<string, unknown>;
  const toUserId = proposalPayload.to_user_id as string | null;

  // The proposal must be addressed to this owner.
  if (toUserId !== userId) {
    return { error: "Esta propuesta no está dirigida a vos." };
  }

  // Check that no custody_transferred event was emitted AFTER the proposal.
  const [subsequentTransfer] = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, pet.id),
        eq(petEvents.eventType, "custody_transferred"),
        gt(petEvents.occurredAt, latestProposal.occurredAt),
      ),
    )
    .limit(1);

  if (subsequentTransfer) {
    return { error: "Esta propuesta ya fue procesada (transferencia ya ejecutada)." };
  }

  const fromUserId = (proposalPayload.from_user_id as string | null) ?? null;
  const fromOrgId = (proposalPayload.from_organization_id as string | null) ?? null;

  // -------------------------------------------------------------------------
  // PRECONDITIONS (lazy auto-cancel check — §6.3 / §6.4 of spec)
  // -------------------------------------------------------------------------

  // 1. Actor still has active shelter_custody.
  const shelterCustodyWhere = fromOrgId
    ? and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerOrganizationId, fromOrgId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      )
    : and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerUserId, fromUserId ?? ""),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      );

  const [actorOwnership] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(shelterCustodyWhere)
    .limit(1);

  const failures: string[] = [];

  if (!actorOwnership) failures.push("actor_no_longer_holds_custody");

  // 2. Pet must still be 'lost'.
  if (pet.status !== "lost") failures.push("pet_not_lost");

  // 3. Pet must not be deceased.
  if (pet.status === "deceased") failures.push("pet_deceased");

  if (failures.length > 0) {
    // AUTO-CANCEL: emit custody_transfer_cancelled + notify actor.
    const reason = failures[0];
    const now = new Date();
    type PendingNotification = typeof notifications.$inferInsert;
    const cancelPendingNotifications: PendingNotification[] = [];
    try {
      await db.transaction(async (tx) => {
        const cancelPayload = validateEventPayload("custody_transfer_cancelled", {
          proposal_event_id: latestProposal.id,
          cancelled_by: "auto_cancel",
          reason,
        });
        await tx.insert(petEvents).values({
          petId: pet.id,
          eventType: "custody_transfer_cancelled",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: "system",
          payload: cancelPayload,
        });

        const notifyUserId = fromUserId;
        if (notifyUserId) {
          cancelPendingNotifications.push({
            // no-cta: informational status update — the recipient only needs to know the
            // pending proposal was auto-cancelled; there is no action for them to take.
            userId: notifyUserId,
            notificationType: "custody_transfer_auto_cancelled",
            severity: "info",
            title: `Propuesta de devolución cancelada — ${pet.name}`,
            body: autoCancelBody(reason, pet.name),
            relatedPetId: pet.id,
          });
        }
      });
    } catch (cancelErr) {
      console.error("auto-cancel notification failed:", cancelErr);
    }

    if (cancelPendingNotifications.length > 0) {
      try {
        await db.insert(notifications).values(cancelPendingNotifications);
      } catch (e) {
        console.error("notifications insert failed (action did succeed)", e);
      }
    }

    return {
      ok: true,
      autoCancelled: true,
      reason: autoCancelBody(reason, pet.name),
    };
  }

  // -------------------------------------------------------------------------
  // HAPPY PATH: execute the transfer.
  // -------------------------------------------------------------------------
  const now = new Date();
  const [lostCase] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, pet.id),
        eq(cases.caseKind, "lost_pet_episode"),
        eq(cases.status, "open"),
      ),
    )
    .limit(1);

  const custodyCase = await findOpenCaseForPetAndKind(pet.id, "custody_episode");

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // Concurrency guard (parity with every sibling writer — propose-return-as-*,
      // owner-propose-return-to-org, actor-cancel-proposal, owner-reject-return,
      // org-accept-owner-return): serialize on the pet's advisory key and re-verify
      // the proposal is STILL pending under the lock. Without it, this accept can
      // interleave with a concurrent actor cancel/reject — having read the proposal
      // as pending before the cancel committed — and execute an already-cancelled
      // proposal into the immutable log.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      const stillPending = await hasPendingProposal(pet.id, tx);
      if (!stillPending) {
        throw new Error("Esta propuesta ya fue procesada o cancelada.");
      }

      // 1. Insert custody_transferred event.
      const transferPayload = validateEventPayload("custody_transferred", {
        from_user_id: fromUserId,
        from_organization_id: fromOrgId,
        to_user_id: userId,
        to_organization_id: null,
        from_role: "shelter_custody",
        to_role: "owner",
        reason: "return_to_original_owner",
        matched_against_pet_id: pet.id,
        foster_ended_event_id: null,
        notes: null,
      });
      const [transferEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_transferred",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: "owner",
          payload: transferPayload,
          caseId: custodyCase?.id ?? lostCase?.id ?? null,
        })
        .returning({ id: petEvents.id });

      // 2. End the actor's shelter_custody ownership.
      const actorOwnershipId = (actorOwnership as { id: string }).id;
      await tx.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, actorOwnershipId));

      // Close the custody_episode case if one was open (animal was intaked).
      if (custodyCase) {
        await closeCase({ caseId: custodyCase.id, reason: "resolved", closedByUserId: userId }, tx);
      }

      // 3. Flip pet status from lost → active + emit status_changed event.
      if (pet.status === "lost") {
        await tx.update(pets).set({ status: "active", updatedAt: now }).where(eq(pets.id, pet.id));

        const statusPayload = validateEventPayload("status_changed", {
          from_status: "lost",
          to_status: "active",
          reason: "return_to_original_owner",
        });
        await tx.insert(petEvents).values({
          petId: pet.id,
          eventType: "status_changed",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: "owner",
          payload: statusPayload,
          caseId: lostCase?.id ?? null,
        });

        if (lostCase) {
          await closeCase({ caseId: lostCase.id, reason: "resolved", closedByUserId: userId }, tx);
        }
      }

      // 4. Notify the actor.
      const notifyUserId = fromUserId;
      if (notifyUserId) {
        pendingNotifications.push({
          // no-cta: informational status update — confirms the return completed and custody
          // was closed; the recipient takes no further action.
          userId: notifyUserId,
          notificationType: "custody_transfer_accepted_owner_side",
          severity: "info",
          title: `Devolución confirmada — ${pet.name}`,
          body: `El dueño confirmó que recibió a ${pet.name}. La custodia fue cerrada correctamente.`,
          relatedPetId: pet.id,
          relatedEventId: transferEvent.id,
        });
      } else if (fromOrgId) {
        const proposalAuthorId = latestProposal.recordedByUserId;
        if (proposalAuthorId) {
          pendingNotifications.push({
            // no-cta: informational status update — confirms the return completed and custody
            // was closed; the recipient takes no further action.
            userId: proposalAuthorId,
            notificationType: "custody_transfer_accepted_owner_side",
            severity: "info",
            title: `Devolución confirmada — ${pet.name}`,
            body: `El dueño confirmó que recibió a ${pet.name}. La custodia fue cerrada correctamente.`,
            relatedPetId: pet.id,
            relatedEventId: transferEvent.id,
          });
        }
      }
    });
  } catch (err) {
    return {
      error: `No se pudo completar la devolución: ${err instanceof Error ? err.message : String(err)}`,
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
