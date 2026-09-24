// Use-case: confirmChipMatchAsRefugioWriter — refugio path for chip-match confirmation
// (strangler migration 21/61).
//
// Org-side confirmation: a refugio actor sees a matched pet after a microchip cross-check
// during intake and decides whether it's the same animal.
//
// decision='same': inserts shelter_custody ownership + shelter_intake_recorded event +
//   chip_match_notification_owner notification (post-tx, best-effort).
// decision='not_same': emits a dismissal note_added event. No state change.
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { db, notifications, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { validateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";
import {
  ORG_CUSTODY_TAKEN_ERROR,
  findLiveOrgShelterCustody,
  isOrgCustodyCollision,
} from "@/lib/infra/org-custody";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { ConfirmChipMatchResult } from "./types";

export async function confirmChipMatchAsRefugioWriter({
  auth,
  orgToken,
  claim,
  matchedPetToken,
  decision,
  notes,
}: {
  auth: {
    user: { id: string };
    organization: { id: string; displayName: string; verified: boolean };
  };
  orgToken: string;
  claim?: string;
  matchedPetToken: string;
  decision: "same" | "not_same";
  notes?: string;
}): Promise<ConfirmChipMatchResult> {
  const { user, organization } = auth;
  const now = new Date();

  // Cross-tenant write guard (review 24 HIGH #7): both decisions mutate the
  // matched (lost) pet — 'same' creates shelter_custody + notifies the owner,
  // 'not_same' writes a note event. Confirming from the token alone let any
  // org member act on any lost-pet token cross-org. Require the same HMAC
  // intake-match claim the page gated on: it binds THIS org (by URL token) to
  // THIS pet and is minted only by the org's own intake chip cross-check.
  if (!claim || !validateIntakeMatchClaim(orgToken, matchedPetToken, claim)) {
    return { error: "Coincidencia de intake no válida o expirada. Reintentá el ingreso." };
  }

  // Look up matched pet and its active owner. Art. 16: an erased pet must
  // answer like a token that never existed — BOTH decisions write onto the
  // matched pet ('same' takes custody + notifies, 'not_same' appends a note),
  // and neither may land on a credential the erasure switched off.
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    .where(and(eq(pets.publicToken, matchedPetToken), isNull(pets.deletedAt)))
    .limit(1);

  if (!petRow) return { error: "Mascota no encontrada." };
  const matchedPet = petRow.pet;

  if (decision === "not_same") {
    // Emit a dismissal note on the matched pet — no state change.
    const notePayload = validateEventPayload("note_added", {
      category: null,
      text: `Refugio ${organization.displayName} descartó posible coincidencia de chip en intake. Sin cambios de estado.`,
    });
    await db.insert(petEvents).values({
      petId: matchedPet.id,
      eventType: "note_added",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: user.id,
      authorRole: "shelter",
      authorOrganizationId: organization.id,
      authorVerified: organization.verified,
      payload: notePayload,
    });
    return { ok: true };
  }

  // decision === 'same'
  if (matchedPet.status !== "lost") {
    return {
      error: `La mascota ya no está en estado 'perdida' (estado actual: ${matchedPet.status}). No se puede crear la custodia.`,
    };
  }

  // Idempotency guard (projection-writes audit §6): confirming the match does
  // NOT flip the pet's status, so the state check above cannot block a
  // double-submit. If this org already holds active shelter_custody on the
  // matched pet, the confirmation already happened — no second ownership row,
  // no second intake event, no second owner notification.
  const [existingCustody] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, matchedPet.id),
        eq(ownerships.ownerOrganizationId, organization.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (existingCustody) return { ok: true };

  // Find the active owner ownership to notify them.
  const [ownerOwnership] = await db
    .select({ ownerUserId: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, matchedPet.id),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);

  let custodyEventId: string | undefined;
  let refusal: string | null = null;

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // TOCTOU guard: serialize concurrent confirmations on the same pet (same
      // advisory-lock pattern as the return-to-owner writers), then re-verify
      // custody inside the tx so a double-click cannot insert twice.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${matchedPet.id}))`);
      const [custodyInTx] = await tx
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, matchedPet.id),
            eq(ownerships.ownerOrganizationId, organization.id),
            eq(ownerships.role, "shelter_custody"),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      if (custodyInTx) return;

      // One live ORG custody per pet (0195). The guard above only knows about
      // THIS org; a second refugio confirming an animal another org already
      // took in would otherwise hit the index as a raw 23505.
      const heldByOtherOrg = await findLiveOrgShelterCustody(matchedPet.id, tx);
      if (heldByOtherOrg) {
        refusal = ORG_CUSTODY_TAKEN_ERROR;
        return;
      }

      // 1. Insert shelter_custody ownership for the refugio (parallel to owner's).
      await tx.insert(ownerships).values({
        petId: matchedPet.id,
        ownerOrganizationId: organization.id,
        role: "shelter_custody",
        startedAt: now,
      });

      // 2. Emit shelter_intake_recorded event with match context.
      const intakePayload = validateEventPayload("shelter_intake_recorded", {
        intake_reason: "stray_found",
        intake_condition: notes ?? null,
        rescue_jurisdiction: null,
      });
      const [intakeEvent] = await tx
        .insert(petEvents)
        .values({
          petId: matchedPet.id,
          eventType: "shelter_intake_recorded",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified: organization.verified,
          payload: intakePayload,
        })
        .returning({ id: petEvents.id });
      custodyEventId = intakeEvent.id;

      // 3. Notify the original owner if we have a userId.
      if (ownerOwnership?.ownerUserId) {
        pendingNotifications.push({
          userId: ownerOwnership.ownerUserId,
          notificationType: "chip_match_notification_owner",
          severity: "urgent",
          title: `Encontraron a ${matchedPet.name}`,
          body: `${organization.displayName} detectó a ${matchedPet.name} por su microchip. Coordiná la devolución.`,
          ctaLabel: "Coordinar devolución",
          ctaUrl: `/mis-mascotas/${matchedPetToken}/devolucion`,
          relatedPetId: matchedPet.id,
          relatedEventId: intakeEvent.id,
        });
      }
    });
  } catch (err) {
    // The index is the last line: a custody row committed between the read
    // above and the insert. Same sentence as the pre-check, never a 500.
    if (isOrgCustodyCollision(err)) return { error: ORG_CUSTODY_TAKEN_ERROR };
    throw err;
  }
  if (refusal) return { error: refusal };

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

  return { ok: true, custodyEventId };
}
