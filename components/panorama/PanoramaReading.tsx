"use client";

// PanoramaReading — the one-line auto-reading above the map (panorama-redesign
// Fase 1). Thin presentational wrapper over the pure domain builder: the
// sentence derives EXCLUSIVELY from the KpiDelta[] the KPI strip already
// carries (get-panorama-kpis.ts) — zero new queries, never a value from a
// k-anon-suppressed cell.
//
// Hidden while the KPIs are stale: the kpisStale warning already covers that
// state, and a "reading" over stale numbers would mislead the operator. Also
// hidden while the KPIs are still streaming in (perf plan 1.3 pending state):
// there are no deltas yet, so a reading would headline off nothing.

import { type ReadingKpi, buildPanoramaReading } from "@/src/modules/panorama/domain/reading";

type Props = {
  /** The headline KPIs (PanoramaKpi[] satisfies this structurally). */
  kpis: readonly ReadingKpi[];
  /** True when the last KPI refetch failed — the numbers on screen are stale. */
  stale: boolean;
  /**
   * perf plan 1.3: the streamed KPI promise hasn't resolved yet. The metrics
   * column shows the "Cargando indicadores…" state; the reading stays hidden
   * (no deltas to read) exactly as it does while stale.
   */
  pending?: boolean;
  /**
   * trust/safety invariant (2026-07-10): the KPI fan-out DEGRADED — there are
   * no real deltas, so buildPanoramaReading would emit the reassuring fallback
   * ("Sin variación destacable…"). Instead render an explicit "no pudimos
   * calcular" line that REPLACES that conclusion — a degraded view must never
   * show a reassuring reading. Takes priority over stale/pending.
   */
  degraded?: boolean;
};

export function PanoramaReading({ kpis, stale, pending = false, degraded = false }: Props) {
  if (degraded) {
    return (
      <p aria-live="polite" className="text-sm font-medium text-ln-op-warn">
        No pudimos calcular la lectura en este momento.
      </p>
    );
  }
  if (stale || pending) return null;
  return (
    <p aria-live="polite" className="text-sm font-medium text-ln-op-ink">
      {buildPanoramaReading(kpis)}
    </p>
  );
}
