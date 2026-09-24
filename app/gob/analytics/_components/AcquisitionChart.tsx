"use client";

// v1 approach: aggregate all method buckets into a single monthly total and
// render one <TimeSeriesChart variant="area"> for total acquisition trend.
// A small text legend below shows per-method percentage breakdowns.
//
// v2 TODO(E5-followup): when TimeSeriesChart supports multi-series / stacked
// area, replace this with a proper stacked chart per method bucket.

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import type { AcquisitionTrendPoint } from "@/lib/analytics/govt-dashboards";

type Props = {
  data: AcquisitionTrendPoint[];
  className?: string;
};

/** Method bucket display labels (es-AR). */
const METHOD_LABELS: Record<string, string> = {
  shelter_adoption: "adopción de refugio",
  vecino_helps_stray: "vecino ayuda callejero",
  private_handover: "entrega particular",
  other: "otro",
};

export function AcquisitionChart({ data, className }: Props) {
  // Aggregate by month (sum across all methods).
  const byMonth = new Map<string, { x: string; y: number; periodStart: string }>();
  for (const pt of data) {
    const existing = byMonth.get(pt.periodStart) ?? { x: pt.x, y: 0, periodStart: pt.periodStart };
    existing.y += pt.y;
    byMonth.set(pt.periodStart, existing);
  }

  const trendPoints = Array.from(byMonth.values())
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    .map((p) => ({ x: p.x, y: p.y }));

  // Compute per-method percentages from full dataset.
  const methodTotals = new Map<string, number>();
  let grandTotal = 0;
  for (const pt of data) {
    methodTotals.set(pt.method, (methodTotals.get(pt.method) ?? 0) + pt.y);
    grandTotal += pt.y;
  }

  const methodSummary =
    grandTotal > 0
      ? ["shelter_adoption", "vecino_helps_stray", "private_handover", "other"]
          .filter((m) => methodTotals.has(m))
          .map((m) => {
            const pct = Math.round(((methodTotals.get(m) ?? 0) / grandTotal) * 100);
            return `${METHOD_LABELS[m]} (${pct}%)`;
          })
          .join(" · ")
      : null;

  return (
    <div className={className}>
      <TimeSeriesChart
        data={trendPoints}
        seriesLabel="Adquisiciones"
        variant="area"
        fallbackTableLabel="Tendencia de adquisiciones por mes"
      />
      {methodSummary && (
        <p className="mt-2 text-sm text-ln-op-mute">
          <span className="font-medium">Métodos:</span> {methodSummary}
        </p>
      )}
    </div>
  );
}
