// Use-case: proposeReturnAsRefugioWriter — org/refugio proposes custody return
// to the original owner.
//
// Auth (requireOrgAccessByToken + custody.transfer capability) is handled by
// the caller (action). This use-case receives pre-authorized actor context.
//
// Steps:
//   1. Look up pet by publicToken — must be lost.
//   2. Verify org holds active shelter_custody on this pet.
//   3. Find active owner.
//   4. Fast pre-check hasPendingProposal (optimistic, outside tx).
//   5. In a tx: writeRefugioReturnProposalInTx (advisory lock, re-verify
//      pending, emit custody_transfer_proposed), then build the owner
//      notification.
//   6. Flush notifications outside tx.
//
// writeRefugioReturnProposalInTx is the ONE place a refugio's proposal is
// written. It has two callers: this use-case, and the refugio's chip-match
// confirmation (confirm-chip-match-refugio.ts), which leaves the proposal for
// the owner in the same transaction as the intake (PO 2026-10-01). Each caller
// owns its notification: this one sends "Devolución propuesta de …"; the chip
// match already tells the owner "¡Encontraron a …!" with the same CTA, so it
// sends nothing more — one event, one notice.

import { and, eq, isNull, sql } from "drizzle-orm";

import { cases, db, notifications, ownerships, petEvents, pets, profiles } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";

import { withNotificationIds } from "@/lib/infra/notification-ids";
import type { ProposeReturnResult } from "../domain/types";
import { hasPendingProposal } from "./proposal-queries";

export type { ProposeReturnResult };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RefugioReturnProposalWrite =
  | { ok: true; eventId: string; lostCaseId: string | null }
  /** A proposal is already pending on this pet: nothing was written. */
  | { ok: false; reason: "pending" };

/**
 * Write a refugio's return proposal to the pet's owner, INSIDE the caller's
 * transaction.
 *
 * What it enforces, whoever calls it:
 *   - serialization: it takes the pet's advisory lock (the same key every
 *     return-to-owner writer and the chip match use; re-entrant within one
 *     transaction, so a caller already holding it loses nothing);
 *   - at most ONE pending proposal per pet: re-verified under that lock, and a
 *     pending one means nothing is written;
 *   - authorship: the event is the organization's (`authorRole` "shelter",
 *     `authorOrganizationId`), recorded by the acting member — the spine entry
 *     is the audit record;
 *   - the open lost_pet_episode case, when there is one, is the event's case.
 *
 * What it does NOT check, because both callers already did, outside or inside
 * the same transaction: that the pet is lost, that the organization holds its
 * active shelter_custody, and who the owner is. It sends no notification.
 */
export async function writeRefugioReturnProposalInTx(
  tx: Tx,
  args: {
    petId: string;
    userId: string;
    organizationId: string;
    ownerUserId: string;
    notes: string | null;
    now: Date;
  },
): Promise<RefugioReturnProposalWrite> {
  const { petId, userId, organizationId, ownerUserId, notes, now } = args;

  // TOCTOU fix: serialize concurrent proposals on the same pet. Same lock key
  // as orgAcceptOwnerReturnWriter so propose-vs-accept also serialize —
  // prevents a proposal slipping in while an accept is running.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${petId}))`);

  // Re-verify inside the tx after acquiring the lock.
  if (await hasPendingProposal(petId, tx)) return { ok: false, reason: "pending" };

  // Cases system (Fase D3): the proposal event attaches to the open
  // lost_pet_episode. Null when the pet was marked lost before D3 rolled out.
  const [lostCase] = await tx
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, petId),
        eq(cases.caseKind, "lost_pet_episode"),
        eq(cases.status, "open"),
      ),
    )
    .limit(1);

  const payload = validateEventPayload("custody_transfer_proposed", {
    from_user_id: null,
    from_organization_id: organizationId,
    to_user_id: ownerUserId,
    to_organization_id: null,
    reason: "return_to_original_owner",
    notes,
    matched_against_pet_id: petId,
    proposed_at: now.toISOString(),
  });

  const [proposalEvent] = await tx
    .insert(petEvents)
    .values({
      petId,
      eventType: "custody_transfer_proposed",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId,
      authorRole: "shelter",
      authorOrganizationId: organizationId,
      payload,
      caseId: lostCase?.id ?? null,
    })
    .returning({ id: petEvents.id });

  return { ok: true, eventId: proposalEvent.id, lostCaseId: lostCase?.id ?? null };
}

export async function proposeReturnAsRefugioUseCase({
  userId,
  organization,
  petPublicToken,
  notes,
}: {
  userId: string;
  organization: { id: string; displayName: string };
  petPublicToken: string;
  notes: string | null;
}): Promise<ProposeReturnResult> {
  // Look up pet.
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    // Art. 16: an erased pet answers like a token that never existed.
    .where(unerasedPetByToken(petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };
  const pet = petRow.pet;

  if (pet.status !== "lost") {
    return { error: `La mascota no está en estado 'perdida' (estado actual: ${pet.status}).` };
  }

  // Verify org has active shelter_custody on this pet.
  const [actorOwnership] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerOrganizationId, organization.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!actorOwnership) {
    return { error: "La organización no tiene custodia activa sobre esta mascota." };
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

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      const written = await writeRefugioReturnProposalInTx(tx, {
        petId: pet.id,
        userId,
        organizationId: organization.id,
        ownerUserId,
        notes,
        now,
      });
      if (!written.ok) {
        throw new Error("Ya existe una propuesta de devolución pendiente para esta mascota.");
      }
      eventId = written.eventId;

      // Fetch actor's display name for the notification body.
      const [actorProfile] = await tx
        .select({ displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1);
      const actorName = actorProfile?.displayName ?? organization.displayName;

      // Notify the original owner.
      pendingNotifications.push({
        userId: ownerUserId,
        notificationType: "custody_transfer_proposal_owner",
        severity: "urgent",
        title: `Devolución propuesta de ${pet.name}`,
        body: `${actorName} está listo para devolverte a ${pet.name}. Confirmá cuando la tengas físicamente.`,
        relatedPetId: pet.id,
        relatedEventId: written.eventId,
        relatedCaseId: written.lostCaseId,
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
      // Ids minted before the insert, so the push carries the row's own id.
      const rows = withNotificationIds(pendingNotifications);
      await db.insert(notifications).values(rows);
      // Web Push leg (ADR 2026-07-18 §4): urgent custodia, best-effort, never throws.
      const { sendPushForNotifications } = await import("@/lib/infra/web-push");
      await sendPushForNotifications(rows);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true, eventId };
}
