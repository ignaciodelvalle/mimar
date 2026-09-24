// Who counts as "a human administrator we can notify".
//
// WHY THIS EXISTS — A FIX THAT ONLY REACHED ONE OF NINE COPIES
// ---------------------------------------------------------------------------
// On 2026-08-17 an audit found that `findAuthoritiesForJurisdiction`'s admin
// fallback did not exclude service accounts: a row with role "admin",
// accountType "institutional" and no `deactivatedAt` satisfies every predicate
// a service account also satisfies. That was fixed in `approval-routing.ts`.
//
// A second audit, hours later, found the same predicate hand-rolled in eight
// more places — every one of them a notification-recipient path, every one of
// them missing the new clause, and two of them missing `deactivatedAt` too. The
// first fix had been applied to the SITE the audit named rather than to the
// CONCEPT the audit was about. That is the same failure this repo has now
// recorded three times (the whole-province subsumption fix that reached
// Panorama and not the scope fence; the signer-provenance fix that reached the
// walk-in and not the bite report).
//
// So the predicate lives here once. A call site that wants "the humans to tell"
// imports it; it cannot drift, because there is nothing left to copy.
//
// WHY `isSystem` MATTERS MORE THAN IT LOOKS
// ---------------------------------------------------------------------------
// A service account in a recipient list does two kinds of damage. It is sent
// real notifications about bites, rabies observations and outbreaks that nobody
// will ever read — and, worse, it PADS the count that the empty-fan-out check
// reads. That check exists to leave the only durable evidence that an
// announcement reached zero humans. One residual service account makes the list
// non-empty, the trace is never written, and the silence becomes unfindable.

import { and, eq, isNull } from "drizzle-orm";

import { db, profiles } from "@/db";

/**
 * A Drizzle executor — the shared `db` handle or a transaction. Call sites
 * inside a transaction must pass `tx` so the read sees their own uncommitted
 * writes and does not open a second connection while holding one.
 */
type Executor = Pick<typeof db, "select">;

/**
 * User ids of every ACTIVE, HUMAN, institutional administrator.
 *
 * The five clauses, and why each is load-bearing:
 *   - role "admin"                  — the fallback is for administrators.
 *   - accountType "institutional"   — a personal account that happens to hold
 *                                     the admin role is not the institution.
 *   - deactivatedAt IS NULL         — a revoked administrator is not reachable.
 *   - deletedAt IS NULL             — an ERASED account (Ley 25.326 art. 16) is
 *                                     not a person we can page either, and it
 *                                     must not pad the empty-fan-out check
 *                                     (security review, 2026-09-18).
 *   - isSystem = false              — a service account is not a person.
 *
 * Returns ids only. A caller that needs more columns should still filter with
 * this list rather than re-deriving the predicate.
 */
export async function activeHumanInstitutionalAdminIds(executor: Executor = db): Promise<string[]> {
  const rows = await executor
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        eq(profiles.accountType, "institutional"),
        isNull(profiles.deactivatedAt),
        isNull(profiles.deletedAt),
        eq(profiles.isSystem, false),
      ),
    );
  return rows.map((r) => r.id);
}
