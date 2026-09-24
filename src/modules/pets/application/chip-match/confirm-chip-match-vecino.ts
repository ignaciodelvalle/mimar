// Use-case: confirmChipMatchAsVecinoWriter — vecino path for chip-match confirmation
// (strangler migration 21/61).
//
// Vecino-side confirmation: a regular user actor sees a matched pet after a microchip
// cross-check while registering a found stray and decides whether it's the same animal.
//
// decision='same': inserts shelter_custody ownership for the vecino +
//   shelter_intake_recorded event + chip_match_notification_owner notification
//   (post-tx, best-effort).
// decision='not_same': emits a dismissal note_added event. No state change.
//
// AUTHORIZATION — attemptedMicrochipId is the capability, not the pet token.
// Its sibling confirm-chip-match-refugio.ts binds actor↔pet with an HMAC intake
// claim (review 24 HIGH #7). This path had NOTHING: actorMode='vecino' clears
// requireUserOrRedirect and matchedPetToken came straight from the caller, so
// any authenticated account — self-signup is free — could name any public token
// harvested off /perdidas and (a) receive that animal's 15-digit chip in the
// `not_same` response, (b) take shelter_custody of it with `same`, (c) append a
// note to its event spine. The chip is a number /p/[publicToken] deliberately
// refuses to render.
//
// The premise of this screen is that the actor TYPED the colliding code: they
// cannot be here otherwise. So the code itself is the proof, and requiring it
// turns an oracle into a verifier — you can only confirm what you already knew,
// and a blind prober must guess 15 digits. attemptedChipMatchesPet answers
// inside SQL and never selects the canonical code, so nothing downstream can
// echo it back.
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { db, notifications, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { attemptedChipMatchesPet } from "@/lib/infra/chip-lookup";
import { generateForceToken } from "@/lib/infra/microchip-force-token";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { ConfirmChipMatchResult } from "./types";

/** Uniform refusal — says nothing about which precondition failed. */
const NO_PROOF_ERROR =
  "No pudimos verificar la coincidencia de microchip. Volvé a ingresar el número y reintentá.";

export async function confirmChipMatchAsVecinoWriter({
  userId,
  matchedPetToken,
  attemptedMicrochipId,
  decision,
  notes,
}: {
  userId: string;
  matchedPetToken: string;
  /** The code the actor typed into the alta. Proof they reached this screen legitimately. */
  attemptedMicrochipId: string;
  decision: "same" | "not_same";
  notes?: string;
}): Promise<ConfirmChipMatchResult> {
  const now = new Date();

  // Art. 16: an erased pet must answer like a token that never existed — both
  // decisions write onto the matched pet (custody + owner notification, or the
  // chip-return receipt), same reasoning as the refugio writer.
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    .where(and(eq(pets.publicToken, matchedPetToken), isNull(pets.deletedAt)))
    .limit(1);

  if (!petRow) return { error: "Mascota no encontrada." };
  const matchedPet = petRow.pet;

  // Gate BOTH decisions, before any read of the conflict and before any write:
  // 'not_same' returned the chip, 'same' took custody and notified the owner.
  if (!(await attemptedChipMatchesPet(matchedPet.id, attemptedMicrochipId))) {
    return { error: NO_PROOF_ERROR };
  }

  if (decision === "not_same") {
    // A receipt is only ever issued against a LOST match, which is the only
    // status that routes an actor here (createPetAction: active → inline
    // warning + its own token, deceased → hard block). Checking it here is what
    // makes the deceased block in createPetAction true rather than merely
    // asserted: without this, naming a deceased pet's token minted a receipt
    // for its code. A pet recovered between page load and click lands here too
    // — no receipt, no note, and the alta re-runs its own cross-check.
    if (matchedPet.status !== "lost") return { ok: true };

    const notePayload = validateEventPayload("note_added", {
      category: null,
      text: "Un vecino descartó posible coincidencia de chip al registrar una mascota encontrada. Sin cambios de estado.",
    });
    await db.insert(petEvents).values({
      petId: matchedPet.id,
      eventType: "note_added",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId,
      // NOT "owner". This writer runs on a pet the actor does NOT own — a
      // neighbour adjudicating a chip collision on someone else's record. The
      // timeline renders author_role verbatim ("Dueño/a"), so signing it owner
      // showed the real owner a note about their own pet apparently written by
      // themselves. Events are append-only: a false attribution here cannot be
      // edited later, only apologised for in a second event.
      authorRole: "finder",
      payload: notePayload,
    });

    // Mint the adjudication receipt (RA-2 F6). Until this existed, "No es la
    // misma" wrote this note and returned bare `ok` — the vecino was sent back
    // to /mis-mascotas/nueva, re-entered the same chip, and createPetAction ran
    // the identical cross-check and bounced them straight back here. A closed
    // loop on the product's central use case: a neighbour who finds a lost
    // animal could never finish registering it.
    //
    // We sign the code the CALLER supplied — and that is not a weakening,
    // because the gate above already proved it equals this pet's canonical
    // chip. The response therefore carries no code at all: the actor typed it,
    // the client still has it, and a caller who cannot produce it never gets
    // here. The old version read the canonical code out of the DB and returned
    // it, which is precisely how the endpoint became a chip oracle.
    return {
      ok: true,
      chipConflict: { forceToken: generateForceToken(attemptedMicrochipId) },
    };
  }

  // decision === 'same'
  if (matchedPet.status !== "lost") {
    return {
      error: `La mascota ya no está en estado 'perdida' (estado actual: ${matchedPet.status}). No se puede crear la custodia.`,
    };
  }

  // Idempotency guard (projection-writes audit §6): confirming the match does
  // NOT flip the pet's status, so the state check above cannot block a
  // double-submit. If this vecino already holds active shelter_custody on the
  // matched pet, the confirmation already happened — no-op.
  const [existingCustody] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, matchedPet.id),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (existingCustody) return { ok: true };

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

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

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
          eq(ownerships.ownerUserId, userId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    if (custodyInTx) return;

    // 1. Insert shelter_custody for the vecino.
    await tx.insert(ownerships).values({
      petId: matchedPet.id,
      ownerUserId: userId,
      role: "shelter_custody",
      startedAt: now,
    });

    // 2. Emit shelter_intake_recorded event.
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
        recordedByUserId: userId,
        // NOT "owner" — same reason as the note_added above.
        authorRole: "finder",
        payload: intakePayload,
      })
      .returning({ id: petEvents.id });
    custodyEventId = intakeEvent.id;

    // 3. Notify the original owner.
    if (ownerOwnership?.ownerUserId) {
      pendingNotifications.push({
        userId: ownerOwnership.ownerUserId,
        notificationType: "chip_match_notification_owner",
        severity: "urgent",
        title: `Encontraron a ${matchedPet.name}`,
        body: `Un vecino detectó a ${matchedPet.name} por su microchip. Coordiná la devolución.`,
        ctaLabel: "Coordinar devolución",
        ctaUrl: `/mis-mascotas/${matchedPetToken}/devolucion`,
        relatedPetId: matchedPet.id,
        relatedEventId: intakeEvent.id,
      });
    }
  });

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
