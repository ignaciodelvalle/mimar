// Seed/fixture-side guards for the `pet_transfers` one-pending-per-pet
// invariant.
//
// Migration 0054 declares a PARTIAL UNIQUE index:
//
//   CREATE UNIQUE INDEX IF NOT EXISTS pet_transfers_one_pending_per_pet
//     ON pet_transfers(pet_id)
//     WHERE status = 'pending';
//
// "At most one pending transfer per pet" is a real domain rule — concurrent
// transfers would race on the ownership transition — so any step that wants to
// INSERT a pending transfer has to pick a pet that provably has none, or the
// insert throws.
//
// ---------------------------------------------------------------------------
// The failure this module exists to make impossible (A15 / P2.2)
// ---------------------------------------------------------------------------
// __tests__/rls/matrix.test.ts self-provisions a pending `pet_transfers` row so
// the owner/admin/other_user SELECT cells probe a POLICY rather than an empty
// table. It picked its pet with a bare "first ACTIVE pet of owner@dim.test",
// filtered only for open bite_incident cases. On a database where the demo seed
// had left a pending transfer on that same pet (PTR-D2TZ-JGR4 on DIM-DEMO-0001,
// 2026-07-26) the insert died on the unique index and the whole RLS matrix
// failed at beforeAll. CI never saw it — CI bootstraps clean and creates no
// transfers — so the LOCAL gate was the unusable one, which is how work gets
// pushed unverified.
//
// The fix is identical in shape to scripts/seed-case-guards.ts, which solved
// the same class for cases_open_per_pet_kind_idx: express the INDEX PREDICATE
// as a `NOT EXISTS` so the collision is impossible BY CONSTRUCTION.
//
// ORDERING IS NOT THE FIX. That lesson is A8's, and it was expensive: there,
// adding an `ORDER BY` alone would have converted an INTERMITTENT failure into
// a 100% one, because the deterministic pick happened to be the colliding pick.
// Deterministic ≠ correct. The ORDER BY below exists only so a run is
// reproducible; the `NOT EXISTS` is the guard.
//
// Tested by __tests__/seed-transfer-guards.test.ts against the local DB,
// including a migration-parity test that PARSES db/migrations/0054_pet_transfers.sql
// so the constant below and the index cannot drift apart.

import { and, asc, eq, inArray, like, notExists } from "drizzle-orm";

import { db, petTransfers, pets } from "../db";

/**
 * Transfer statuses the partial unique index treats as blocking.
 *
 * Keep in sync with db/migrations/0054_pet_transfers.sql — the parity test
 * parses the `WHERE` clause of the index DDL and fails if these diverge.
 */
export const BLOCKING_TRANSFER_STATUSES = ["pending"] as const;

export type GuardedTransferPet = {
  id: string;
  publicToken: string;
};

const PET_COLUMNS = {
  id: pets.id,
  publicToken: pets.publicToken,
};

/**
 * A `NOT EXISTS` mirroring `pet_transfers_one_pending_per_pet` exactly:
 * "this pet has no transfer in a blocking status".
 */
function hasNoBlockingTransfer() {
  return notExists(
    db
      .select({ id: petTransfers.id })
      .from(petTransfers)
      .where(
        and(
          eq(petTransfers.petId, pets.id),
          inArray(petTransfers.status, [...BLOCKING_TRANSFER_STATUSES]),
        ),
      ),
  );
}

/**
 * Of `candidateIds`, the pets that have NO pending transfer — ordered by
 * `public_token` so the pick is reproducible run to run.
 *
 * Returns `[]` for an empty candidate list rather than building an `IN ()`.
 *
 * Use this when the caller already has a candidate set (e.g. the pets a
 * PostgREST query returned under RLS) and needs it narrowed to legal insert
 * targets.
 */
export async function selectPetsWithoutPendingTransfer(
  candidateIds: readonly string[],
): Promise<GuardedTransferPet[]> {
  if (candidateIds.length === 0) return [];
  return db
    .select(PET_COLUMNS)
    .from(pets)
    .where(and(inArray(pets.id, [...candidateIds]), hasNoBlockingTransfer()))
    .orderBy(asc(pets.publicToken));
}

/**
 * Pets whose `public_token` starts with `tokenPrefix` and that have NO pending
 * transfer, ordered by `public_token`. The seed-side twin of
 * `selectPetsWithoutPendingTransfer`, matching the signature
 * `scripts/seed-case-guards.ts` exposes.
 */
export async function selectSeedPetsWithoutPendingTransfer(opts: {
  tokenPrefix: string;
  limit: number;
}): Promise<GuardedTransferPet[]> {
  return db
    .select(PET_COLUMNS)
    .from(pets)
    .where(and(like(pets.publicToken, `${opts.tokenPrefix}%`), hasNoBlockingTransfer()))
    .orderBy(asc(pets.publicToken))
    .limit(opts.limit);
}

/**
 * Pending transfers already attached to `petId`. Empty means a new pending
 * transfer is legal. Used as a last-line assertion by callers, and by the guard
 * test as an INDEPENDENT oracle — it must not share the guard's query shape or
 * it would confirm the guard's own bugs.
 */
export async function findBlockingTransfers(
  petId: string,
): Promise<{ id: string; publicToken: string; status: string }[]> {
  return db
    .select({
      id: petTransfers.id,
      publicToken: petTransfers.publicToken,
      status: petTransfers.status,
    })
    .from(petTransfers)
    .where(
      and(
        eq(petTransfers.petId, petId),
        inArray(petTransfers.status, [...BLOCKING_TRANSFER_STATUSES]),
      ),
    );
}
