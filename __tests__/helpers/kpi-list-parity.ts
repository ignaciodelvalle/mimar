// Reusable KPI↔list parity assertion.
//
// The recurring bug class this guards: a dashboard's headline KPI count
// disagrees with the row count of its own list view under the SAME filters.
// It has bitten twice — most recently the maltrato ("Sin asignar" etc.) KPI
// tiles ignoring kind/severity/status/admin-province while the list they
// drill into honored them (see the "KPI↔list parity (filter-honesty fix
// 2026-07)" note in lib/analytics/dashboards/welfare.ts). Earlier, the
// "Perdidas activas" KPI vs the /gob/perdidas list had the same class of gap
// (see the "no `since` returns the full lost stock" test in
// __tests__/govt-dashboards.test.ts).
//
// This helper does not fetch anything itself — it takes a KPI-count fetcher
// and a list-row fetcher, calls both with IDENTICAL filters, and asserts the
// counts reconcile. Callers own how filters map to each underlying function's
// real signature (they rarely match 1:1 — e.g. a KPI fetcher may take a
// `WelfareMetricsFilters` subset while the list fetcher takes the full
// `MaltratoListFilters` — so callers typically pass a thin object and wrap
// each side in an arrow function that projects it onto the real call).

import { expect } from "vitest";

export type AssertKpiListParityOpts<TFilters> = {
  /** The filter set applied identically to both the KPI and the list fetch. */
  filters: TFilters;
  /** Resolves the dashboard's headline KPI count under `filters`. */
  getKpiCount: (filters: TFilters) => Promise<number>;
  /** Resolves the list's rows under the SAME `filters`. */
  getListRows: (filters: TFilters) => Promise<unknown[]>;
  /** Optional label surfaced in the failure message (e.g. "maltrato — unassigned queue"). */
  label?: string;
};

/**
 * Fetches the KPI count and the list rows under identical filters, then
 * asserts `kpiCount === listRows.length`. Call this from a vitest `it()`
 * block against real DB-backed fetchers (not mocks) so the assertion
 * exercises the actual query pair a page renders side by side.
 */
export async function assertKpiListParity<TFilters>(
  opts: AssertKpiListParityOpts<TFilters>,
): Promise<void> {
  const { filters, getKpiCount, getListRows, label } = opts;

  const [kpiCount, listRows] = await Promise.all([getKpiCount(filters), getListRows(filters)]);

  const context = label ? ` (${label})` : "";
  expect(
    kpiCount,
    `KPI↔list parity${context}: the KPI count (${kpiCount}) must equal the list row count (${listRows.length}) under identical filters. A mismatch means the headline tile and the list it drills into disagree — the exact bug class this harness guards against (bit twice; see maltrato-detail-scope-consistency / maltrato-sql-queue KPI↔list history).`,
  ).toBe(listRows.length);
}
