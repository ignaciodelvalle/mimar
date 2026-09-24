// Use-case: recordChipDisputeAgainstActivePet — append-only trace for the
// ACTIVE-match escape hatch (RA-2 F6 follow-up).
//
// When a chip cross-check hits a pet with status='active', createPetAction
// answers with warning:"CHIP_MATCH_ACTIVE" plus a force token, and the actor
// can accept it to register their animal WITHOUT the disputed code. Somebody
// has just asserted that a code held by an existing credential belongs to a
// different animal — a data-quality dispute about a globally-unique
// identifier — and until this module existed that assertion was written
// NOWHERE: not on the matched pet, not on the new one, not in any log. The
// warning was returned, the token was redeemed, and the record it was disputed
// against never heard about it.
//
// The `lost` branch already records its side: the vecino confirmation page
// writes a dismissal note_added before minting its receipt. So this fires only
// for an active match, which is exactly the hole. Both halves of the escape
// hatch now leave a fact on the spine (invariant #2: corrections are new
// events, never edits).
//
// Best-effort by design: the alta has already succeeded when this runs, and a
// failed audit note must not undo a registered pet. Logged, never thrown.

import { db, petEvents, petIdentifications, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { and, eq } from "drizzle-orm";

export async function recordChipDisputeAgainstActivePet({
  disputedChipCode,
  actorUserId,
}: {
  disputedChipCode: string;
  actorUserId: string;
}): Promise<void> {
  try {
    // Scoped to status='active' in SQL: the lost case is already recorded by
    // the confirmation page, and a deceased match can never reach a redemption
    // (createPetAction blocks it before any token exists).
    const [row] = await db
      .select({ petId: pets.id })
      .from(petIdentifications)
      .innerJoin(pets, eq(pets.id, petIdentifications.petId))
      .where(
        and(
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.status, "active"),
          eq(petIdentifications.code, disputedChipCode),
          eq(pets.status, "active"),
        ),
      )
      .limit(1);

    if (!row) return;

    const now = new Date();
    const payload = validateEventPayload("note_added", {
      category: null,
      text: "Otro usuario declaró que el microchip de este registro corresponde a un animal distinto y completó un alta sin ese código. Sin cambios en esta credencial.",
    });

    await db.insert(petEvents).values({
      petId: row.petId,
      eventType: "note_added",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: actorUserId,
      // NOT "owner" — see the twin note in confirm-chip-match-vecino.ts. The
      // actor here is a stranger registering a found animal; this note lands on
      // a THIRD PARTY's active pet.
      authorRole: "finder",
      payload,
    });
  } catch (e) {
    console.error("[chip-match] chip-dispute note insert failed (alta did succeed):", e);
  }
}
