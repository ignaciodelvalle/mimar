// Period-invariance derivation for KPI tiles.
//
// Lives OUTSIDE kpi-catalog.ts on purpose: the catalog file is over the
// file-size fence and must not grow (check-file-size.ts). This helper only
// READS the catalog.

import { KPI_CATALOG, type KpiId } from "./kpi-catalog";

/**
 * True when the catalog says this KPI is a point-in-time STOCK ("basis:
 * stock", "window: now") — the same derivation OpKpi uses internally to
 * decide whether to render its own "no varía con el período" tag. Exported
 * so a caller composing SEVERAL sibling OpKpi tiles in one group (e.g. the
 * /gob/denuncias triage stat row) can hoist a single group-level footnote
 * instead of letting each tile repeat the tag (copy audit 2026-08-06, S5).
 */
export function isKpiPeriodInvariant(id: KpiId | undefined): boolean {
  if (!id) return false;
  const descriptor = KPI_CATALOG[id];
  return descriptor?.basis === "stock" && descriptor?.window === "now";
}
