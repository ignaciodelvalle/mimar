// Routes an approval request to the right reviewers.
//
// Spec §6 (scope matching): govt sees only requests in the (province,
// locality) tuples they cover via govt_assignments. Admin sees everything
// admin-only (role upgrades to govt/admin, assignment grants) plus the
// fallback for any locality with no active govt.
//
// This module is the writer-side helper: given a jurisdiction, return the
// user IDs that should receive a "pending request" notification when an
// approval_request lands. Admin fallback fires only when no govt covers
// the locality, matching the visibility rule on the read side.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, govtAssignments, profiles } from "@/db";
import { localitiesCoveringSearch } from "@/lib/domain/jurisdiction-canonical";
import { recordEmptyFanout } from "@/lib/infra/empty-fanout-trace";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";

export type ApprovalJurisdiction = {
  province: string;
  locality: string;
};

/**
 * Optional caller context. `route` names the fan-out that is about to happen, so
 * the audit row written when NOBODY can be reached says which notification went
 * nowhere instead of just "some notification". Optional because the resolver has
 * 17 call sites and they are labelled as they are touched; an unlabelled site
 * still gets a row, just a vaguer one.
 */
export type ApprovalRoutingContext = {
  route?: string;
};

// Returns the user IDs of every authority that should be notified about a
// new pending approval request for the given (province, locality).
//
// - If at least one govt has an active govt_assignment matching the
//   jurisdiction, return ONLY those govt user IDs. Admins do not get the
//   notification (they still SEE the request via the universal admin
//   policy, but they're not paged).
// - If no govt covers the jurisdiction, return every active admin so the
//   request lands in the admin queue with a notification.
//
// Empty result is possible only when there are no admins seeded — in
// which case the caller still writes the approval_request row and the
// founder will see it on next login. That case now leaves a
// `notification_fanout_empty` audit row (migration 0187): before it did, an
// empty fan-out was the one failure in the system with no trace anywhere.
//
// WHOLE-PROVINCE SUBSUMPTION (2026-08-17). This used to match locality with
// plain equality, which made a whole-province operator STRUCTURALLY INVISIBLE
// to every writer: she SAW the request in her queue (the read side was fixed in
// July — case-queries.ts, approval-scope.ts, jurisdictionPairClause) and was
// never notified, while the resolver concluded "no govt covers this locality"
// and paged national admins instead. Wording, query and ROUTING must never
// disagree about what counts as the whole province (C3, plan-maestro-integridad).
//
// The subsumption direction here is the SEARCH one — a locality-grain event must
// reach a whole-province assignment ROW — i.e. exactly `localitiesCoveringSearch`
// (lib/domain/jurisdiction-canonical.ts), the same helper the appointment search
// uses. Deliberately NOT a second implementation: four jurisdiction predicates
// already coexist in this codebase and a fifth would be one more thing to drift.
//
// It fails closed the same way the helper does: a non-canonical province accepts
// only its literal locality, and a locality-specific assignment never widens.
export async function findAuthoritiesForJurisdiction(
  jurisdiction: ApprovalJurisdiction,
  context?: ApprovalRoutingContext,
): Promise<string[]> {
  const coveringLocalities = localitiesCoveringSearch(jurisdiction.province, jurisdiction.locality);

  // THE HOLDER MUST STILL BE REACHABLE (T2-S5, 2026-09-18). An unrevoked
  // assignment is not enough: this used to read govt_assignments alone, so an
  // operator whose PROFILE was deactivated kept being paged about bites, rabies
  // closures and denuncias for as long as one assignment row stayed open — and,
  // worse, her silent presence made `govts.length > 0`, so the admin fallback
  // that exists exactly for "nobody covers this" never fired. Deactivation paths
  // do not all revoke assignments (reset-institutional-credentials deactivates
  // without touching them; a hand-patched row does neither), so the profile is
  // the authority here, not the assignment. `isSystem` for the same reason the
  // admin fallback carries it (notification-recipients.ts): a service account is
  // not a person and must not pad the list the empty-fan-out check reads.
  //
  // Every call site is a "who do we tell" fan-out (reviewed together, T2-S5) —
  // none of them is a history view that would want a deactivated holder back.
  //
  // Two more clauses (security review, 2026-09-18), same reasoning:
  //   - deletedAt IS NULL — an ERASED account (Ley 25.326 art. 16) is not
  //     deactivated, it is gone; erasure does not necessarily revoke the
  //     assignment row, and paging an erased subject is both useless and a
  //     privacy defect.
  //   - role = 'govt' — the assignment table is the govt mandate, but nothing
  //     stops a row outliving a role change (a govt demoted or re-roled keeps
  //     the row until someone revokes it). The mandate is only live while the
  //     holder still HOLDS the role.
  const govts = await db
    .select({ userId: govtAssignments.userId })
    .from(govtAssignments)
    .innerJoin(profiles, eq(profiles.id, govtAssignments.userId))
    .where(
      and(
        eq(govtAssignments.jurisdictionProvince, jurisdiction.province),
        inArray(govtAssignments.jurisdictionLocality, coveringLocalities),
        isNull(govtAssignments.revokedAt),
        eq(profiles.role, "govt"),
        isNull(profiles.deactivatedAt),
        isNull(profiles.deletedAt),
        eq(profiles.isSystem, false),
      ),
    );

  if (govts.length > 0) {
    // Deduplicate — a single govt can hold multiple assignments in the same
    // locality across different countries / re-grants (shouldn't, but the
    // partial unique only covers active rows for the same exact tuple).
    return Array.from(new Set(govts.map((g) => g.userId)));
  }

  // Tightened per migration 0015: only active, non-deactivated institutional
  // admins receive fallback notifications.
  //
  // The predicate moved to lib/infra/notification-recipients.ts (2026-08-17,
  // same day it was written here). It was fixed HERE first — this is the site
  // the audit named — and a second audit hours later found the identical query
  // hand-rolled in eight more recipient paths, none of which had the fix. The
  // shared helper is the answer to that, not another copy. Its header carries
  // the full rationale for each clause.
  const admins = await activeHumanInstitutionalAdminIds();

  if (admins.length === 0) {
    // Nobody at all. Govt-first found no one, and the fallback that exists
    // precisely for that case found no one either — so whatever the caller was
    // about to announce reaches zero humans. This row is the only evidence that
    // will ever exist of it. Awaited (not fire-and-forget) so a serverless
    // invocation cannot be frozen before the insert lands; it never throws.
    await recordEmptyFanout({
      route: context?.route ?? "approval_routing_unlabelled",
      province: jurisdiction.province,
      locality: jurisdiction.locality,
      reason: "no_govt_no_admin",
    });
  }

  return admins;
}
