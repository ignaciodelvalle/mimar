// bookSlotForUser — the guarded booking act, with a TYPED failure arm.
//
// WHAT THIS ADDS OVER `bookSlotWriter`, AND WHY THE WRITER STAYS BARE
// ---------------------------------------------------------------------------
// `bookSlotWriter(slotId, petId, ownerUserId)` takes a caller-supplied user id
// and says so: "The caller is responsible for verifying that `petId` belongs to
// `ownerUserId` before calling this function." That is why it is not re-exported
// from `app/actions/booking.ts` (impersonation triage, review 07) and why
// `__tests__/authz-bare-writer-exports.test.ts` pins the exemption. This module
// is the half that does the verifying, for a door whose caller names the animal
// by its PUBLIC TOKEN rather than by a uuid it has no way to hold.
//
// THE TWO GUARDS ARE COPIED AS A NEGATION OF `bookSlotAction`, NOT RE-DERIVED
// ---------------------------------------------------------------------------
// `app/actions/booking.ts:51-79` is the web's own call site and the rules are
// read off it line by line:
//
//   · an ACTIVE ownership row of ANY role, `ownerships.ended_at IS NULL`, plus
//     `pets.deleted_at IS NULL`. The erased animal folds into the SAME refusal a
//     never-owned pet gets — a guard, not a distinct error, so this door is not
//     an existence oracle (Ley 25.326 art. 16). The web's comment says exactly
//     this and the fold is preserved here.
//   · `pets.status <> 'deceased'`, checked HERE and not only in the picker,
//     because the picker is presentational: a screen opened before the death was
//     recorded, or a hand-posted token, reaches this function with an animal the
//     picker would no longer show. The web makes the same argument in the same
//     words at the same place.
//
// IT IS A SECOND COPY OF ONE RULE AND THAT IS DECLARED RATHER THAN HIDDEN.
// `bookSlotAction` is NOT migrated onto this function: it is a `"use server"`
// entry point the browser drives, three fences read that file
// (`check-authz-scoping`, `authz-bare-writer-exports`,
// `server-actions-auth-coverage`), and changing it is a browser-facing edit with
// its own e2e gate. `list-appointments-for-user.ts` records the identical
// arrangement one file over, for the identical reason. The migration is named in
// the hand-off; until it happens, the citation above is what keeps the two
// honest, and `book-slot-for-user.test.ts` asserts the compiled predicate rather
// than the source text — a `toContain` on `isNull(pets.deletedAt)` passes for
// `or(isNull(pets.deletedAt), sql\`true\`)`.
//
// THE FAILURE ARM IS TYPED, WHICH IS THE REPAIR `me/appointments/commands.ts`
// STILL NEEDS
// ---------------------------------------------------------------------------
// `bookSlotWriter` answers `{ error: string }` carrying es-AR prose written for a
// web form, and the cancel door matches those SENTENCES to map them onto codes —
// a mapping whose own header admits "a reworded sentence falls through to a 500".
// `AmendEventFailureCode` and `ClaimFailureCode` are the repair; this is the
// third instance of it. The prose is matched EXACTLY ONCE, here, against literals
// this module exports so the test can pin them against the writer's source, and
// everything downstream switches on a closed union.

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, pets } from "@/db";

import { bookSlotWriter } from "./book-slot";

/**
 * Every way booking can be refused, as a closed set.
 *
 * SPLIT BY WHAT THE CALLER DOES NEXT, which is the only bar the `/api/v1` error
 * vocabulary applies, and the split is finer HERE than on the wire on purpose:
 * this union is what a route maps onto codes, and a union coarser than the wire
 * could never be refined without changing this file too.
 */
export type BookSlotFailureCode =
  /** No active ownership of any role — or the animal was erased. One answer for both. */
  | "pet_not_yours"
  /** The animal's life record is closed. */
  | "pet_deceased"
  /** No such slot, or it belongs to a different offering than the one asked for. */
  | "slot_not_found"
  /** The slot is cancelled, full, or its offering is not taking bookings. */
  | "slot_unavailable"
  /** The clock passed the slot's start. */
  | "slot_past"
  /** This animal already holds this slot, or another slot of the same offering. */
  | "already_booked";

export type BookSlotForUserResult =
  | { ok: true; appointmentToken: string }
  | { ok: false; code: BookSlotFailureCode };

/**
 * The writer's es-AR sentences, mapped onto codes.
 *
 * EVERY LITERAL IS EXPORTED so `book-slot-for-user.test.ts` can pin it against
 * `book-slot.ts`'s own source. That is the instrument `me/appointments/commands.ts`
 * already uses for the cancel table, and it is what makes a reworded sentence a
 * RED TEST rather than a silent fall-through.
 *
 * THE FALL-THROUGH IS `slot_unavailable`, NOT A THROW, and the direction is the
 * safe one: an unmapped refusal is still a refusal, nothing is granted by it, and
 * the client's move ("re-read the slots") is right for every sentence this writer
 * can produce. A throw would turn a refusal into a 500.
 */
export const BOOK_SLOT_REFUSAL_SENTENCES: ReadonlyArray<{
  sentence: string;
  code: BookSlotFailureCode;
}> = [
  { sentence: "El turno no existe.", code: "slot_not_found" },
  { sentence: "El turno fue cancelado.", code: "slot_unavailable" },
  { sentence: "Sin cupo disponible.", code: "slot_unavailable" },
  { sentence: "El turno ya pasó.", code: "slot_past" },
  { sentence: "Esta mascota ya tiene este turno reservado.", code: "already_booked" },
  { sentence: "Esta mascota ya tiene un turno reservado en esta campaña.", code: "already_booked" },
  { sentence: "El servicio no está disponible.", code: "slot_not_found" },
  {
    sentence: "Este servicio no está tomando turnos en este momento.",
    code: "slot_unavailable",
  },
  // T1-L16: the slot's schedule rule was deleted, paused or ended before its
  // date. Same client move as a cancelled slot — re-read the slots.
  { sentence: "Este horario ya no está en la agenda del prestador.", code: "slot_unavailable" },
];

export function bookSlotRefusalCode(sentence: string): BookSlotFailureCode {
  for (const rule of BOOK_SLOT_REFUSAL_SENTENCES) {
    if (rule.sentence === sentence) return rule.code;
  }
  return "slot_unavailable";
}

/**
 * Book one slot for one of the caller's animals.
 *
 * @param args.slotId       The `time_slots.id` the READ handed the client. Opaque.
 * @param args.petPublicToken `DIM-XXXX-XXXX`. The phone never holds a pet uuid.
 * @param args.userId       The live session's user id. NEVER caller-supplied.
 */
export async function bookSlotForUser(args: {
  slotId: string;
  petPublicToken: string;
  userId: string;
}): Promise<BookSlotForUserResult> {
  // ONE trip for the ownership row and the animal's lifecycle status, the way
  // `bookSlotAction` reads them together. `role` is deliberately NOT constrained:
  // a foster or a co-owner books under their own id and the turno is theirs.
  const [row] = await db
    .select({ petId: pets.id, status: pets.status })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, args.petPublicToken),
        eq(ownerships.ownerUserId, args.userId),
        isNull(ownerships.endedAt),
        // Art. 16 — see the header. The erased animal answers `pet_not_yours`,
        // which is the same answer a stranger's token gets.
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, code: "pet_not_yours" };
  if (row.status === "deceased") return { ok: false, code: "pet_deceased" };

  const result = await bookSlotWriter(args.slotId, row.petId, args.userId);
  if ("error" in result) return { ok: false, code: bookSlotRefusalCode(result.error) };
  return { ok: true, appointmentToken: result.appointmentToken };
}
