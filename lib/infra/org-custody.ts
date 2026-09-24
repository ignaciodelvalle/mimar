// One live ORGANISATION shelter_custody row per pet (migration 0195) — the
// read, the refusal and the error match that every custody writer shares.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Before 0195 the only shelter_custody index was per (pet, org), so a writer
// that opened an org's custody row only ever had to ask "does MY org already
// hold one?". The org-scoped per-pet index changes the question to "does ANY
// org hold one?", and five production writers asked the old question:
// refugio chip-match, owner-return accept, adoption reversal, the cross-org
// transfer accept (owner-source branch) and the rehome accept. Each of them
// would have surfaced the index as a raw 23505 — a 500 for the person
// clicking. The rule is one sentence, so its read and its refusal live in one
// place instead of five.
//
// Two layers, both on purpose (the book-slot.ts pattern):
//   - `findLiveOrgShelterCustody` is the PRE-CHECK: cheap, and the honest UX —
//     the writer refuses before writing, inside its transaction / under its
//     lock, with a sentence the user can act on.
//   - `isOrgCustodyCollision` is the LAST LINE: the index fires when a
//     concurrent writer committed between the pre-check and the insert, and the
//     caller maps it to the same sentence instead of letting it escape.
//
// User-held custody (a neighbour holding a found pet, owner_organization_id
// NULL) is OUTSIDE the index by design and outside this read for the same
// reason — see db/migrations/0195 and db/schema.ts at the ownerships table.

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { type db, ownerships } from "@/db";
import { matchesDbError } from "@/lib/infra/db-errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

/** The partial unique index 0195 creates. */
export const ORG_CUSTODY_INDEX = "ownerships_one_active_org_shelter_custody_per_pet";

/** The es-AR refusal every writer shows when an org custody row is already live. */
export const ORG_CUSTODY_TAKEN_ERROR =
  "Esta mascota ya está bajo custodia de una organización. Esa custodia tiene que cerrarse antes de asignar otra.";

export type LiveOrgShelterCustody = { id: string; ownerOrganizationId: string };

/**
 * The pet's live ORG-held shelter_custody row, whoever holds it, or null.
 *
 * Pass the transaction when the answer gates a write in that transaction —
 * a pre-transaction read is stale by construction (see the callers).
 */
export async function findLiveOrgShelterCustody(
  petId: string,
  client: Executor,
): Promise<LiveOrgShelterCustody | null> {
  const [row] = await client
    .select({ id: ownerships.id, ownerOrganizationId: ownerships.ownerOrganizationId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        isNotNull(ownerships.ownerOrganizationId),
      ),
    )
    .limit(1);
  if (!row?.ownerOrganizationId) return null;
  return { id: row.id, ownerOrganizationId: row.ownerOrganizationId };
}

/**
 * Postgres 23505 = unique_violation, raised by `ORG_CUSTODY_INDEX`.
 * `matchesDbError` walks drizzle 0.45's `.cause` chain (the real pg error is
 * no longer top-level) and tests the constraint name.
 */
export function isOrgCustodyCollision(err: unknown): boolean {
  return matchesDbError(err, { code: "23505", constraint: ORG_CUSTODY_INDEX });
}
