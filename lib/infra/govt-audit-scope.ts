// Jurisdiction scope for the /gob/historial audit trail (Wave C, gob-audit-inventory).
//
// audit_log has NO jurisdiction_province/jurisdiction_locality columns of its
// own (see db/schema.ts) — it only carries actor_user_id, target_user_id,
// target_organization_id, target_govt_assignment_id. So "audit for MY
// jurisdiction" is derived, not stored: it means "actions performed by govt
// operators who share an active govt_assignments tuple with me" (peer
// accountability within the same territory), not "actions about an entity
// located in my jurisdiction" (that would require joining every possible
// target table and is out of scope for this pass).
//
// The predicate is pushed to SQL (a WHERE on govt_assignments, then an
// inArray on the resulting bounded id list) rather than fetched-then-filtered
// in JS — govt_assignments rows for a given province+locality are always a
// small, bounded set (per-locality staffing), so this two-step query is not
// an N+1 risk.

import { and, isNull, sql } from "drizzle-orm";

import { db, govtAssignments } from "@/db";
import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";
import { jurisdictionPairClause } from "@/lib/metrics/scope";

/**
 * Resolves the set of user IDs with an ACTIVE (non-revoked) govt_assignment
 * matching any of the given jurisdiction tuples.
 *
 * Returns `[]` when `jurisdictions` is empty (govt actor with no active
 * assignment) — callers must treat that as "matches nothing", not "no filter".
 */
export async function fetchJurisdictionActorIds(
  jurisdictions: AdminOrGovtJurisdiction[],
): Promise<string[]> {
  if (jurisdictions.length === 0) return [];

  // synthetic: exempt — govt_assignments are operator accounts, not seed data.
  const pairsClause = jurisdictionPairClause(
    jurisdictions,
    sql`${govtAssignments.jurisdictionProvince}`,
    sql`${govtAssignments.jurisdictionLocality}`,
  );
  if (!pairsClause) return [];

  const rows = await db
    .selectDistinct({ userId: govtAssignments.userId })
    .from(govtAssignments)
    .where(and(isNull(govtAssignments.revokedAt), pairsClause));

  return rows.map((r) => r.userId);
}
