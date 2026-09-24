// Use-case: proposeReturnAsVecinoWriter — vecino (individual finder) proposes
// custody return to the original owner.
//
// Auth (requireUserOrRedirect) is handled by the caller (action).

import { and, eq, isNull, sql } from "drizzle-orm";

import { cases, db, notifications, ownerships, petEvents, pets, profiles } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import type { ProposeReturnResult } from "../domain/types";
import { hasPendingProposal } from "./proposal-queries";

export async function proposeReturnAsVecinoUseCase({
  userId,
  petPublicToken,
  notes,
}: {
  userId: string;
  petPublicToken: string;
  notes: string | null;
}): Promise<ProposeReturnResult> {
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed — the
    // shelter_custody row and status='lost' both SURVIVE the erasure, so
    // without this filter any custodian could append onto the erased spine and
    // fire a notification carrying the retired name.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  if (pet.status !== "lost") {
    return { error: `La mascota no está en estado 'perdida' (estado actual: ${pet.status}).` };
  }

  // Verify vecino has active shelter_custody on this pet.
  const [actorOwnership] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!actorOwnership) {
    return { error: "No tenés custodia activa sobre esta mascota." };
  }

  // Find the original owner.
  const [ownerOwnership] = await db
    .select({ ownerUserId: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .limit(1);
  if (!ownerOwnership?.ownerUserId) {
    return { error: "No se encontró un dueño activo para devolver la mascota." };
  }
  const ownerUserId: string = ownerOwnership.ownerUserId;

  // Fast pre-check outside the tx (optimistic path — avoids lock contention).
  const pendingCheck = await hasPendingProposal(pet.id, db);
  if (pendingCheck) {
    return { error: "Ya existe una propuesta de devolución pendiente para esta mascota." };
  }

  const now = new Date();
  let eventId = "";

  // Cases system (Fase D3): attach proposal to the open lost_pet_episode
  // when present (legacy lost pets have no case yet).
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

      const [actorProfile] = await tx
        .select({ displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      const actorName = actorProfile?.displayName ?? "Un vecino";

      const payload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: userId,
        from_organization_id: null,
        to_user_id: ownerUserId,
        to_organization_id: null,
        reason: "return_to_original_owner",
        notes,
        matched_against_pet_id: pet.id,
        proposed_at: now.toISOString(),
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
          caseId: lostCase?.id ?? null,
        })
        .returning({ id: petEvents.id });

      eventId = proposalEvent.id;

      pendingNotifications.push({
        userId: ownerUserId,
        notificationType: "custody_transfer_proposal_owner",
        severity: "urgent",
        title: `Devolución propuesta de ${pet.name}`,
        body: `${actorName} está listo para devolverte a ${pet.name}. Confirmá cuando la tengas físicamente.`,
        relatedPetId: pet.id,
        relatedEventId: proposalEvent.id,
        relatedCaseId: lostCase?.id ?? null,
        ctaLabel: "Coordinar devolución",
        ctaUrl: `/mis-mascotas/${pet.publicToken}/devolucion`,
      });
    });
  } catch (err) {
    return {
      error: `No se pudo proponer la devolución: ${err instanceof Error ? err.message : String(err)}`,
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
