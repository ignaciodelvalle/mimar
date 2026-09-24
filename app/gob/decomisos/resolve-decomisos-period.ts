// Period resolution for /gob/decomisos (F2b — period control wiring).
//
// Extracted to a standalone pure function (mirrors app/gob/panorama/
// derive-widest-jurisdiction.ts) so the pre-existing 30d-default guarantee is
// unit-testable without a DB or auth session.
//
// resolveAnalyticsPeriod's OWN fallback (lib/analytics/analytics-period.ts
// defaultWindow) is trailing 12 MONTHS, not 30 days — calling it directly
// with no period param would silently widen the D5 seizures window on first
// load. This mirrors the identical ternary /gob/campanas uses (page.tsx) to
// keep its 30d default while still honoring an explicit period/custom range.

import { resolveAnalyticsPeriod, windows } from "@/lib/metrics/period";
import type { AnalyticsPeriod, PeriodSearchParams } from "@/lib/metrics/period";

/**
 * Resolve the decomisos D5 seizures window from raw searchParams.
 *
 * - No `period`/`from` present → trailing 30 days (pre-existing hardcoded
 *   `windows.trailing30d()` behavior — the default must NOT regress to
 *   resolveAnalyticsPeriod's own 12-month fallback).
 * - `period` (preset or "custom" with `from`/`to`) present → delegates to
 *   resolveAnalyticsPeriod, same as every sibling /gob dashboard.
 */
export function resolveDecomisosPeriod(sp: PeriodSearchParams): AnalyticsPeriod {
  return sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing30d();
}
