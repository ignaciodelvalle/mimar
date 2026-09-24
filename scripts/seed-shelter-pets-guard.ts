// Re-run guard for the shelter-custody pets step of scripts/seed-test-users.ts.
//
// The step's header promised "Idempotent — safe to re-run" and the guard behind
// that promise was:
//
//   if (org already holds a live shelter_custody) -> SKIP
//
// That is a guard on a fact the seed's OWN DATA is allowed to invalidate. A
// custody ends for perfectly ordinary reasons — an adoption, a transfer — and
// once it does, the guard sees zero live custodies and lets the step run again.
// But the pets it inserts carry FIXED microchip codes into pet_identifications,
// and migration 0056 declares
//
//   CREATE UNIQUE INDEX pet_identifications_chip_unique
//     ON public.pet_identifications(code)
//     WHERE kind = 'microchip_iso' AND status = 'active';
//
// so the re-run does not skip and does not succeed either: it re-creates the
// pets and then dies with 23505 on the first fixed chip, PARTWAY THROUGH. That
// is the worst of both — no protection and no atomicity. Measured on staging
// (2026-08-21): duplicated shelter pets, and pets left behind without the chip
// row their spine event says they have.
//
// So the guard is written against the constraint it will actually hit:
//
//   1. LIVE CUSTODY — the original intent, kept. "This shelter already holds
//      its seeded population" is still a legitimate reason not to re-run, and
//      it is the only signal for a seed pet that carries no chip at all.
//   2. CHIP CODES — the new, load-bearing half. The fixed codes are what
//      collide, they are not erased when a custody ends, and they are the
//      durable fingerprint of "this step already wrote its rows".
//
// The predicate mirrors the index EXACTLY, `status = 'active'` included: a chip
// row that was replaced or removed no longer occupies the unique index, so it
// must not block a re-run either. A guard stricter than its constraint is just
// a different bug.
//
// The caller derives `chipCodes` from the seed array itself rather than
// re-listing them here — a fourth seed pet with a chip is covered the day it is
// added, with nothing to keep in sync.
//
// Note the ASYMMETRY, and that it is deliberate: the custody signal is scoped
// to one org, the chip signal is GLOBAL, because the index it mirrors is global
// too. So a shelter that never ran this step is still told "already seeded"
// when some other org holds the chip. That is the correct answer, not a false
// positive: while that code exists anywhere as an active microchip_iso, this
// step CANNOT succeed for anyone. The choice is between skipping and crashing.
//
// Tested by __tests__/seed-shelter-pets-guard.test.ts against the local DB.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, ownerships, petIdentifications } from "../db";

export type ShelterPetsSeedState =
  | { alreadySeeded: false }
  | {
      alreadySeeded: true;
      /** Which signal fired — the seed logs it so a SKIP is never mute. */
      reason: "live-custody" | "chip-already-present";
      detail: string;
    };

/**
 * Whether the shelter-custody pets step has already written its rows.
 *
 * Returns the REASON as well as the verdict: a seed that skips without saying
 * why is how "idempotent" became a claim nobody could check.
 */
export async function shelterPetsAlreadySeeded(opts: {
  orgId: string;
  /** The fixed microchip codes the step will insert. Derive them from the seed
   *  array — never hand-list them here. */
  chipCodes: readonly string[];
}): Promise<ShelterPetsSeedState> {
  const [liveCustody] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerOrganizationId, opts.orgId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (liveCustody) {
    return {
      alreadySeeded: true,
      reason: "live-custody",
      detail: "org already holds shelter custody",
    };
  }

  if (opts.chipCodes.length === 0) return { alreadySeeded: false };

  // Mirrors pet_identifications_chip_unique EXACTLY, `status = 'active'`
  // included — a replaced/removed chip row is outside the partial index, so
  // re-inserting that code would succeed and the guard must not block on it.
  const [takenChip] = await db
    .select({ code: petIdentifications.code, petId: petIdentifications.petId })
    .from(petIdentifications)
    .where(
      and(
        eq(petIdentifications.kind, "microchip_iso"),
        eq(petIdentifications.status, "active"),
        inArray(petIdentifications.code, [...opts.chipCodes]),
      ),
    )
    .limit(1);
  if (takenChip) {
    return {
      alreadySeeded: true,
      reason: "chip-already-present",
      detail: `microchip ${takenChip.code} already registered (pet ${takenChip.petId})`,
    };
  }

  return { alreadySeeded: false };
}
