// Visibility + capability rules for approval_requests in the admin UI.
//
// Spec §5 (capability matrix): govt sees + decides vet + org_verification
// in their own (province, locality); admin decides everything plus the
// fallback when no govt covers a locality.
//
// Spec §6 (scope matching): the queue page filters approval_requests by
// this rule. The decision actions re-check via canDecideRequest as the
// authoritative server-side guard.

import { and, count, desc, eq, exists, inArray, or, sql } from "drizzle-orm";

import { type ApprovalRequest, type ApprovalRequestType, approvalRequests, db } from "@/db";
import {
  isWholeProvinceLocality,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";
import { type GobReadRole, hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";
import { type KeysetCursor, decodeCursor, keysetWhere } from "@/lib/utils/keyset-pagination";

// Types that ONLY admin can decide. Spec §5.
// Note: role_upgrade_govt, role_upgrade_admin, govt_assignment_grant were
// removed in migration 0015 — institutional accounts are created directly.
const ADMIN_ONLY_TYPES: ApprovalRequestType[] = [];

// Types that a scope-matching govt CAN decide (admin also can).
// Mirrored in SQL by the govt branch of the approval_requests SELECT policy
// (migration 0241); __tests__/rls/govt-whole-province-rls.test.ts keeps the
// two lists equal.
export const GOVT_DECIDABLE_TYPES: readonly ApprovalRequestType[] = [
  "role_upgrade_vet",
  "organization_verification",
];

// Authoritative server-side guard. Mirrors the queue visibility on the
// decision side: an authority can decide a request only if it would
// appear in their queue under spec §6.
export function canDecideRequest(
  profile: { role: "admin" | "govt" },
  request: Pick<ApprovalRequest, "type" | "jurisdictionProvince" | "jurisdictionLocality">,
  jurisdictions: readonly AdminOrGovtJurisdiction[],
): boolean {
  if (profile.role === "admin") return true;
  // Deciding is a WRITE. Only a govt reaches the jurisdiction test below — the
  // read-only national role (or any future role) is refused by ROLE here, not
  // by happening to hold an empty assignment list. Pinned by
  // __tests__/national-role-read-only.test.ts.
  if (profile.role !== "govt") return false;
  if (ADMIN_ONLY_TYPES.includes(request.type)) return false;
  // Subsumption-aware: a whole-province assignment (e.g. whole-CABA) governs
  // every barrio in it; barrio assignments stay exact (never widens security).
  return jurisdictionScopeContains(
    jurisdictions,
    request.jurisdictionProvince,
    request.jurisdictionLocality,
  );
}

// Returns the WHERE predicate that filters approval_requests to the rows
// visible to `profile` (per spec §6). Use inside an `and()` clause to
// combine with other filters (e.g. type filters, date sorts).
//
// - admin: UNIVERSAL catch-all — NO scope restriction. Admin sees EVERY pending
//   request regardless of type or jurisdiction. This is deliberate and load-
//   bearing: the admin headline counter (fetchQueueHealth) is a global
//   count(*) filter (status='pending'), so the admin queue MUST show the same
//   population or the counter and the queue diverge (QA 2026-07-08: dashboard
//   "COLA PENDIENTE: 1" while /admin/cola was empty). It also makes admin the
//   ultimate fallback for petitions in an unoperated jurisdiction (a barrio no
//   govt covers) or of a type no govt can decide — nothing is orphaned.
//   `canDecideRequest` already returns true for admin unconditionally, so
//   showing every row matches the decision capability.
// - govt: govt-decidable types whose (province, locality) matches one of
//   their active assignments (whole-province subsumption applies).
export function visibleRequestsClause(
  profile: { id: string; role: GobReadRole },
  jurisdictions: readonly AdminOrGovtJurisdiction[],
) {
  // Admin is universal: no scope predicate. `sql`true`` composes cleanly inside
  // the `and(status='pending', scopeClause)` the callers build, so the queue
  // and the global counter share ONE population.
  // admin | national: universal READ of the queue (deciding is a separate,
  // write-side question — canDecideRequest keeps admitting admin | govt only).
  if (hasNationalReadScope(profile.role)) return sql`true`;

  // govt: empty jurisdictions → see nothing.
  if (jurisdictions.length === 0) return sql`false`;

  // Match (province, locality) tuples via an OR of equality pairs. A whole-province
  // assignment (e.g. whole-CABA) subsumes every barrio in it — match on province
  // alone — mirroring jurisdictionPairClause / canDecideRequest above so the queue
  // and the decision guard scope identically. Barrio assignments keep the exact pair.
  const tupleMatches = or(
    ...jurisdictions.map((j) =>
      isWholeProvinceLocality(j.province, j.locality)
        ? eq(approvalRequests.jurisdictionProvince, j.province)
        : and(
            eq(approvalRequests.jurisdictionProvince, j.province),
            eq(approvalRequests.jurisdictionLocality, j.locality),
          ),
    ),
  );
  return and(inArray(approvalRequests.type, GOVT_DECIDABLE_TYPES), tupleMatches);
}

// Convenience: pending requests visible to this authority, newest-first.
// `typeFilter` pushes the type predicate into SQL so the query returns only
// matching rows regardless of total queue size — avoids JS-side silently
// missing rows beyond the former LIMIT 200 ceiling (P1-10).
//
// `opts.limit` caps the result set. List-rendering callers (cola page, gob
// dashboard preview) pass 200 so the query stays bounded. Omit for the rare
// COUNT-style caller — but prefer a dedicated COUNT query for those instead.
//
// `opts.cursor` enables keyset pagination (PERF-5): when provided the query
// returns only rows OLDER than the cursor row — (createdAt, id) < (cursorTs, cursorId).
// Fetch limit+1 to detect hasMore; the page renders limit rows and uses row N+1
// solely to decide whether to show the "older" link.
export async function fetchVisiblePendingRequests(
  profile: { id: string; role: GobReadRole },
  jurisdictions: readonly AdminOrGovtJurisdiction[],
  typeFilter?: ApprovalRequestType,
  opts?: { limit?: number; cursor?: KeysetCursor },
): Promise<ApprovalRequest[]> {
  const scopeClause = visibleRequestsClause(profile, jurisdictions);
  const typeClause = typeFilter ? eq(approvalRequests.type, typeFilter) : undefined;
  const cursorClause = keysetWhere(
    approvalRequests.createdAt,
    approvalRequests.id,
    decodeCursor(opts?.cursor),
  );
  const clauses = [
    eq(approvalRequests.status, "pending"),
    scopeClause,
    typeClause,
    cursorClause,
  ].filter(Boolean);
  const whereClause = and(...(clauses as Parameters<typeof and>));
  const q = db
    .select()
    .from(approvalRequests)
    .where(whereClause)
    .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id));
  return opts?.limit !== undefined ? q.limit(opts.limit) : q;
}

// Real scoped COUNT of pending requests visible to this authority. Use this for
// dashboard headline numbers instead of `fetchVisiblePendingRequests(...).length`:
// the fetch caps its result set (limit 200) so a queue larger than the cap would
// under-report as exactly the cap. A COUNT(*) has no ceiling and returns the true
// total regardless of queue size. Shares `visibleRequestsClause` so the count and
// the list can never scope differently.
export async function countVisiblePendingRequests(
  profile: { id: string; role: GobReadRole },
  jurisdictions: readonly AdminOrGovtJurisdiction[],
): Promise<number> {
  const scopeClause = visibleRequestsClause(profile, jurisdictions);
  const [row] = await db
    .select({ n: count() })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.status, "pending"), scopeClause));
  return Number(row?.n ?? 0);
}

// Scoped COUNT of pending requests of ONE type, visible to this authority.
// Shares `visibleRequestsClause` with `countVisiblePendingRequests` so a
// per-type tile (e.g. /gob home's "Habilitación de organizaciones" queue
// card, scoped to organization_verification) can never disagree with the
// lumped total or the queue list over what's "visible" — same scope
// predicate, just an extra type filter pushed into the same COUNT query.
export async function countVisiblePendingRequestsByType(
  profile: { id: string; role: GobReadRole },
  jurisdictions: readonly AdminOrGovtJurisdiction[],
  type: ApprovalRequestType,
): Promise<number> {
  const scopeClause = visibleRequestsClause(profile, jurisdictions);
  const [row] = await db
    .select({ n: count() })
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.status, "pending"), eq(approvalRequests.type, type), scopeClause),
    );
  return Number(row?.n ?? 0);
}

// Unused import guard for `exists` — kept for symmetry with notExists when
// future types need the inverted form. Stripped at build time.
void exists;
