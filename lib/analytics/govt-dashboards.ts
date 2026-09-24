// Barrel for the /gob regional dashboards (Fase 11) read helpers.
//
// This module used to hold every fetcher directly (2613 lines) — it has been
// split into domain modules under lib/analytics/dashboards/ (engram
// refactor/govt-dashboards-split) to keep each file reviewable. Every export
// that used to live here still resolves from this path unchanged; new code
// should import directly from the domain module it needs.
//
// Domains:
//   - dashboards/perdidas.ts     — Pérdidas (lost pets), E3.
//   - dashboards/surveillance.ts — Vigilancia / outbreak signals / zoonosis, E2.
//   - dashboards/welfare.ts      — Maltrato (welfare_reports) + moderation, E4.
//   - dashboards/analytics.ts    — Adoption/rabies/disputes KPIs + trends, E5.
//   - dashboards/exports.ts      — Raw row fetchers for govt data exports, E6.
//   - dashboards/_scope.ts       — Shared jurisdiction scope-clause helpers
//                                  (internal; not re-exported here except the
//                                  symbols that were already public).

// Re-export so existing callers that import from this module don't need to change.
export type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

export { custodyDisputesScopeClause } from "./dashboards/_scope";
export * from "./dashboards/analytics";
export * from "./dashboards/exports";
export * from "./dashboards/perdidas";
export * from "./dashboards/surveillance";
export * from "./dashboards/welfare";
