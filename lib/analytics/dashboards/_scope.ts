// Shared scope-clause helpers for the /gob dashboards (Fase 11 split,
// engram refactor/govt-dashboards-split).
//
// These helpers build Drizzle WHERE-clause fragments that enforce the
// viewer's jurisdiction scope (admin: universal / optional province
// drill-down; govt: OR of assigned jurisdiction pairs). They are used by
// MULTIPLE domain modules under lib/analytics/dashboards/ — keep this file
// free of imports from any of those domain modules to avoid circular
// imports (this module sits BELOW them in the dependency graph).

import { type SQL, and, eq, sql } from "drizzle-orm";

import { cases, custodyDisputes, organizations, pets, welfareReports } from "@/db";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import {
  type DashboardActor,
  type DashboardJurisdiction,
  buildProjectionContext,
  jurisdictionPairClause,
  petEventsScopeClause as metricsPetEventsScopeClause,
  petsScopeClause as metricsPetsScopeClause,
  withoutSyntheticRows,
} from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

export const DAY_MS = 24 * 60 * 60 * 1000;

// Scope-security review 2026-07-04 (Part A1/A2): the payload's
// pet_jurisdiction_* fields are a snapshot taken at event time. When a pet
// moves (or seed data drifts), the payload and the pet's CURRENT
// pets.jurisdiction_* diverge, and a payload-only scope lets a govt viewer see
// out-of-jurisdiction pets. Govt fetchers must ALSO require the pet's current
// jurisdiction to be inside the viewer's scope. Admin keeps universal scope
// (returns null; the payload-based drill-down behavior is unchanged).
export function petsCurrentJurisdictionClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  // T1-P1: the synthetic-row exclusion rides on the scope clause (lib/metrics/scope.ts).
  return withoutSyntheticRows(
    actor.role,
    "pets",
    jurisdictionOnlyPetsCurrentJurisdictionClause(
      actor,
      jurisdictions,
      adminProvince,
      adminLocality,
    ),
  );
}

function jurisdictionOnlyPetsCurrentJurisdictionClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  if (hasNationalReadScope(actor.role)) {
    // Admin province drill-down (Panorama-style) — narrows the CURRENT-jurisdiction
    // guard the same way petsScopeClause does. Backward-compat: no adminProvince →
    // null, exactly as before.
    if (!adminProvince) return null;
    if (adminLocality) {
      // `and()`'s general signature returns `SQL | undefined`; with two concrete
      // (non-undefined) conditions it always yields a defined SQL — cast to match
      // this function's `SQL | null` contract.
      return and(
        eq(pets.jurisdictionProvince, adminProvince),
        eq(pets.jurisdictionLocality, adminLocality),
      ) as SQL;
    }
    return eq(pets.jurisdictionProvince, adminProvince);
  }
  return (
    // synthetic: covered — petsCurrentJurisdictionClause wraps this with withoutSyntheticRows.
    jurisdictionPairClause(
      jurisdictions,
      sql`${pets.jurisdictionProvince}`,
      sql`${pets.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// Build a scope clause for the `cases` table.
// - admin, no province selected → null (no restriction)
// - admin + province selected   → province (+ optional locality) predicate
//   (Panorama-style admin drill-down; additive-only, mirrors petsScopeClause)
// - govt: OR of (jurisdictionProvince=X AND jurisdictionLocality=Y) pairs.
export function casesScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  // T1-P1: the synthetic-row exclusion rides on the scope clause (lib/metrics/scope.ts).
  return withoutSyntheticRows(
    actor.role,
    "cases",
    jurisdictionOnlyCasesScopeClause(actor, jurisdictions, adminProvince, adminLocality),
  );
}

function jurisdictionOnlyCasesScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
) {
  if (hasNationalReadScope(actor.role)) {
    // Backward-compat: no adminProvince → unrestricted, exactly as before.
    if (!adminProvince) return null;
    if (adminLocality) {
      return and(
        eq(cases.jurisdictionProvince, adminProvince),
        eq(cases.jurisdictionLocality, adminLocality),
      );
    }
    return eq(cases.jurisdictionProvince, adminProvince);
  }
  return (
    // synthetic: covered — casesScopeClause wraps this with withoutSyntheticRows.
    jurisdictionPairClause(
      jurisdictions,
      sql`${cases.jurisdictionProvince}`,
      sql`${cases.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// Build a scope clause for the `custody_disputes` table — the domain aggregate
// that the /gob/disputas queue lists.
// - admin, no province selected → null (no restriction)
// - admin + province selected   → province (+ optional locality) predicate
//   (Panorama-style admin drill-down; mirrors casesScopeClause exactly)
// - govt: OR of (jurisdictionProvince=X AND jurisdictionLocality=Y) pairs; govt
//   with no assignments → sql`false` (matches nothing).
//
// Exported so /gob/disputas builds its queue scope with the IDENTICAL predicate
// the analytics "Disputas de custodia" KPI counts — that shared predicate is
// what guarantees the KPI number reconciles with the queue (count↔queue parity).
export function custodyDisputesScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  // T1-P1: the synthetic-row exclusion rides on the scope clause (lib/metrics/scope.ts).
  return withoutSyntheticRows(
    actor.role,
    "custodyDisputes",
    jurisdictionOnlyCustodyDisputesScopeClause(actor, jurisdictions, adminProvince, adminLocality),
  );
}

function jurisdictionOnlyCustodyDisputesScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  if (hasNationalReadScope(actor.role)) {
    // Backward-compat: no adminProvince → unrestricted, exactly as before.
    if (!adminProvince) return null;
    if (adminLocality) {
      return and(
        eq(custodyDisputes.jurisdictionProvince, adminProvince),
        eq(custodyDisputes.jurisdictionLocality, adminLocality),
      ) as SQL;
    }
    return eq(custodyDisputes.jurisdictionProvince, adminProvince);
  }
  return (
    // synthetic: covered — custodyDisputesScopeClause wraps this with withoutSyntheticRows.
    jurisdictionPairClause(
      jurisdictions,
      sql`${custodyDisputes.jurisdictionProvince}`,
      sql`${custodyDisputes.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// Build a scope clause for the `welfare_reports` table — the maltrato queue and
// its KPI tiles. Same contract as casesScopeClause:
// - admin, no province selected → null (no restriction)
// - admin + province selected   → province (+ optional locality) predicate
// - govt: OR of pairs; govt with no assignments → sql`false`.
//
// Moved here from dashboards/welfare.ts (C3, ONE VIEWSCOPE): the admin
// province/locality drill used to be hand-rolled TWICE alongside it
// (buildMaltratoListConditions and fetchWelfareMetrics), which is exactly the
// KPI↔list divergence risk those two call sites exist to prevent. One helper,
// one predicate, both call sites.
export function welfareReportsScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  // T1-P1: the synthetic-row exclusion rides on the scope clause (lib/metrics/scope.ts).
  return withoutSyntheticRows(
    actor.role,
    "welfareReports",
    jurisdictionOnlyWelfareReportsScopeClause(actor, jurisdictions, adminProvince, adminLocality),
  );
}

function jurisdictionOnlyWelfareReportsScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  if (hasNationalReadScope(actor.role)) {
    if (!adminProvince) return null;
    if (adminLocality) {
      return and(
        eq(welfareReports.jurisdictionProvince, adminProvince),
        eq(welfareReports.jurisdictionLocality, adminLocality),
      ) as SQL;
    }
    return eq(welfareReports.jurisdictionProvince, adminProvince);
  }
  return (
    // synthetic: covered — welfareReportsScopeClause wraps this with withoutSyntheticRows.
    jurisdictionPairClause(
      jurisdictions,
      sql`${welfareReports.jurisdictionProvince}`,
      sql`${welfareReports.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// Build a scope clause for the `organizations` table (the /gob organizations
// export). Orgs are scoped by their PRIMARY jurisdiction columns. Same contract
// as casesScopeClause; govt with no assignments → sql`false`, which the export
// caller may still short-circuit for free.
export function organizationsScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  if (hasNationalReadScope(actor.role)) {
    if (!adminProvince) return null;
    if (adminLocality) {
      return and(
        eq(organizations.jurisdictionProvince, adminProvince),
        eq(organizations.jurisdictionLocality, adminLocality),
      ) as SQL;
    }
    return eq(organizations.jurisdictionProvince, adminProvince);
  }
  return (
    // synthetic: exempt — organizations carry no seed marker (T1-P1 report).
    jurisdictionPairClause(
      jurisdictions,
      sql`${organizations.jurisdictionProvince}`,
      sql`${organizations.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// Scope clause over the outbreak_signal event PAYLOAD's jurisdiction SNAPSHOT
// (`pet_jurisdiction_province` / `pet_jurisdiction_locality`).
//
// ⚠️ VALID ONLY for outbreak_signal-family queries — see petEventsScopeClause's
// docblock in lib/metrics/scope.ts for the "ghost-payload" bug class this
// guards against on every other event type. Govt fetchers must ALSO apply
// petsCurrentJurisdictionClause (above) so a moved pet cannot leak through a
// stale snapshot (scope-security review 2026-07-04, Part A1/A2).
//
// A thin adapter over the canonical lib/metrics/ helper — the surveillance
// module used to keep a byte-identical private copy (C3, ONE VIEWSCOPE).
export function outbreakSignalScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
) {
  return metricsPetEventsScopeClause(
    buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
      adminProvince,
      adminLocality,
    }),
  );
}

// Thin adapters for the two scope helpers now canonical in lib/metrics/.
// The period is not relevant for scope-only use — trailing12m is a valid placeholder.
// adminProvince/adminLocality are forwarded into buildProjectionContext's opts,
// which metricsPetsScopeClause already honors (lib/metrics/scope.ts petsScopeClause) —
// backward-compat: omitted → ctx.adminProvince is undefined → unrestricted, same as before.
export function petsScopeClause(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
) {
  return metricsPetsScopeClause(
    buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
      adminProvince,
      adminLocality,
    }),
  );
}
