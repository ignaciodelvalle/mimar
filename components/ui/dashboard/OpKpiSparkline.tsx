"use client";

// Recharts-bearing sparkline extracted from OpKpi.tsx (bundle-size #22).
//
// WHY a separate file: OpKpi is imported directly by ~29 route/component
// files across /gob, /admin, and /org — including first-paint dashboards
// like app/gob/page.tsx. When the sparkline's `recharts` import lived at the
// top of OpKpi.tsx, every one of those call sites paid for recharts in its
// first-load JS even when `sparkline` was never passed. OpKpi.tsx now
// dynamic-imports this module (next/dynamic, ssr:false) so recharts is only
// fetched on the client, and only for tiles that actually render a sparkline.
//
// Decorative only (aria-hidden in the parent) — safe to defer without
// affecting SSR content or accessibility.

import { Area, AreaChart } from "recharts";

import { ChartSizingBox } from "@/components/charts/ChartSizingBox";

type Tone = "neutral" | "danger" | "warn" | "ok" | "blue";

/**
 * One plotted period of a KPI sparkline.
 *
 * SUPPRESSED ≠ ZERO, and this type is where that survives the trip to the tile.
 * `suppressSmallBuckets` masks a 1..k-1 bucket to `y: 0` AND flags it, but every
 * sparkline call site used to hand OpKpi a bare `number[]` built with
 * `.points.map((p) => p.y)` — a projection that structurally CANNOT carry the
 * flag. The masked bucket then drew as a dip to the floor on twelve KPI tiles,
 * and the "N períodos ocultos (privacidad)" disclosure that the big trend cards
 * render was nowhere near them: the reader of the tile had no way to know that
 * the trough was a privacy mask rather than a week nothing happened. Fed a
 * whole `SingleSeriesTrend["points"]` array, the flag rides along for free.
 */
export type SparklinePoint = {
  /** Plotted value. A masked bucket carries 0 here (numeric consumers unchanged). */
  y: number;
  /** True when this bucket is a k-anonymity mask, not a measurement. */
  suppressed?: true;
};

export function OpKpiSparkline({ points, tone }: { points: SparklinePoint[]; tone: Tone }) {
  if (points.length < 2) return null;

  const strokeColor =
    tone === "ok"
      ? "#31a354"
      : tone === "danger"
        ? "#cb181d"
        : tone === "warn"
          ? "#e6550d"
          : tone === "blue"
            ? "#2171b5"
            : "#6b7280";

  // A masked bucket plots as `null`, so recharts breaks the area instead of
  // drawing a dip to zero — the same treatment TimeSeriesChart gives a masked
  // point on the big trend cards, and for the same reason: a trough the reader
  // cannot distinguish from a real one is a claim we never measured. The gap is
  // deliberately subtle at 32px; the tile's own "N períodos ocultos
  // (privacidad)" line underneath is what carries the meaning.
  const chartData = points.map((p, i) => ({ i, v: p.suppressed ? null : p.y }));

  return (
    // #15: use the shared ChartSizingBox (inline width/height) so recharts'
    // ResponsiveContainer never measures 0 on first paint under the ssr:false
    // dynamic import — the width(-1)/height(-1) console warning source on tiles.
    <ChartSizingBox height={32} className="mt-2 w-full" aria-hidden="true">
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sparkFill-${tone}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={strokeColor} stopOpacity={0.3} />
            <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={strokeColor}
          strokeWidth={1.5}
          fill={`url(#sparkFill-${tone})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartSizingBox>
  );
}
