// Seed-side guards for the `cases` open-per-pet-kind invariant.
//
// Migration 0033 declares a PARTIAL UNIQUE index:
//
//   create unique index cases_open_per_pet_kind_idx
//     on public.cases (primary_pet_id, case_kind)
//     where status in ('open', 'escalated')
//       and case_kind not in ('adoption_application', 'adoption_listing',
//                             'welfare_denuncia', 'foster_placement');
//
// "One open case per pet per kind" is a real domain rule, not an accident, so
// a seed step that wants to OPEN a case has to pick a pet that provably has
// none of that kind open yet — otherwise the insert throws.
//
// Two seed steps used to pick their pets with an unordered
// `select ... from pets where public_token like 'PANO-%' limit N`. Postgres
// returns PHYSICAL heap order for such a query, and the heap reorders as the
// seed UPDATEs pets rows along the way (status='lost', cache columns,
// in_custody_dispute). The two steps therefore saw different slices on
// different runs, and whenever the later step's pick landed on a pet the
// earlier step had already opened a custody_dispute for, the seed died with
// `duplicate key value violates unique constraint "cases_open_per_pet_kind_idx"`
// — the intermittent CI failure this module exists to make impossible.
//
// The fix is by construction, not by retry: `selectPetsWithoutOpenCase`
// applies the SAME predicate the index uses as a `NOT EXISTS`, and orders by
// `public_token` so the pick is reproducible run to run.
//
// Tested by __tests__/seed-case-guards.test.ts against the local DB.

import { and, asc, eq, inArray, like, notExists } from "drizzle-orm";

import { cases, db, pets } from "../db";

/** Statuses the partial unique index counts as "open". */
export const OPEN_CASE_STATUSES = ["open", "escalated"] as const;

/**
 * Kinds explicitly EXCLUDED from `cases_open_per_pet_kind_idx` — they are
 * allowed to have several open cases on the same pet at once (multi-applicant
 * adoptions, multi-org listings, independent anonymous denuncias, rotating
 * fosters). Keep in sync with db/migrations/0033_cases.sql.
 */
export const CASE_KINDS_ALLOWING_MULTIPLE_OPEN = [
  "adoption_application",
  "adoption_listing",
  "welfare_denuncia",
  "foster_placement",
] as const;

/** True when `cases_open_per_pet_kind_idx` constrains this kind. */
export function kindIsSingleOpenPerPet(caseKind: string): boolean {
  return !(CASE_KINDS_ALLOWING_MULTIPLE_OPEN as readonly string[]).includes(caseKind);
}

export type GuardedPet = {
  id: string;
  publicToken: string;
  province: string | null;
  locality: string | null;
};

const PET_COLUMNS = {
  id: pets.id,
  publicToken: pets.publicToken,
  province: pets.jurisdictionProvince,
  locality: pets.jurisdictionLocality,
};

/**
 * Seed pets by token prefix in a STABLE order. Use this instead of a bare
 * `limit(n)` anywhere the pick has to be reproducible — Postgres returns
 * physical heap order for an unordered LIMIT, and the heap moves under the
 * seed's own UPDATEs.
 */
export async function selectSeedPetsOrdered(opts: {
  tokenPrefix: string;
  limit: number;
}): Promise<GuardedPet[]> {
  return db
    .select(PET_COLUMNS)
    .from(pets)
    .where(like(pets.publicToken, `${opts.tokenPrefix}%`))
    .orderBy(asc(pets.publicToken))
    .limit(opts.limit);
}

/**
 * Pets whose `public_token` starts with `tokenPrefix` and that have NO
 * open/escalated case of `caseKind`, ordered by `public_token` so the result
 * is stable across runs.
 *
 * The `NOT EXISTS` mirrors the index predicate exactly, so every returned pet
 * is a legal target for one new open case of that kind. For a kind the index
 * does not constrain, the guard is a no-op filter (still ordered).
 */
export async function selectPetsWithoutOpenCase(opts: {
  tokenPrefix: string;
  caseKind: string;
  limit: number;
}): Promise<GuardedPet[]> {
  const { tokenPrefix, caseKind, limit } = opts;

  if (!kindIsSingleOpenPerPet(caseKind)) {
    // The index does not constrain this kind — ordering is all the caller gets.
    return selectSeedPetsOrdered({ tokenPrefix, limit });
  }

  return db
    .select(PET_COLUMNS)
    .from(pets)
    .where(
      and(
        like(pets.publicToken, `${tokenPrefix}%`),
        notExists(
          db
            .select({ id: cases.id })
            .from(cases)
            .where(
              and(
                eq(cases.primaryPetId, pets.id),
                eq(cases.caseKind, caseKind),
                inArray(cases.status, [...OPEN_CASE_STATUSES]),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(pets.publicToken))
    .limit(limit);
}

/**
 * Open/escalated cases of `caseKind` already attached to `petId`. Empty means
 * a new open case of that kind is legal. Used by the seed as a last-line
 * assertion and by the guard test as an independent oracle.
 */
export async function findOpenCasesOfKind(
  petId: string,
  caseKind: string,
): Promise<{ id: string; publicCode: string; status: string }[]> {
  return db
    .select({ id: cases.id, publicCode: cases.publicCode, status: cases.status })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, petId),
        eq(cases.caseKind, caseKind),
        inArray(cases.status, [...OPEN_CASE_STATUSES]),
      ),
    );
}
