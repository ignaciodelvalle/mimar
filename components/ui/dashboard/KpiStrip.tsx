// KpiStrip — responsive KPI row primitive.
//
// Wraps a set of OpKpi tiles in a grid that collapses to 2 columns on phones
// and expands to 4 on desktop. Eliminates the repeated
// `grid grid-cols-2 md:grid-cols-4 gap-3` pattern spread across ~10 dashboards.
//
// Usage:
//   <KpiStrip cols={4}>
//     <OpKpi label="..." value={...} />
//     <OpKpi label="..." value={...} />
//   </KpiStrip>
//
// cols prop maps to the desktop column count. Mobile is always 2-up to
// maximise information density on a narrow screen without overflowing.
// 2-col desktops get sm: breakpoint instead (e.g. small embedded panels).
//
// Spacing: gap-3 (12px) — the canonical token used across all dashboard KPI
// rows. No raw pixel values.

import type { ReactNode } from "react";

type KpiStripCols = 2 | 3 | 4 | 5 | 6;

const DESKTOP_COLS: Record<KpiStripCols, string> = {
  2: "sm:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-6",
};

export type KpiStripProps = {
  /** Number of columns on desktop (md+). Mobile always renders 2-up. Default: 4. */
  cols?: KpiStripCols;
  /** Additional classes for the grid wrapper. */
  className?: string;
  children: ReactNode;
};

/**
 * Responsive KPI row. 2-up on mobile, `cols`-up on desktop.
 *
 * Dashboards with `cols={4}` (most common) render identically to the previous
 * `grid grid-cols-2 md:grid-cols-4 gap-3` — the only difference is that phones
 * now get 2 tiles instead of cramming 4.
 */
export function KpiStrip({ cols = 4, className, children }: KpiStripProps) {
  const gridCols = DESKTOP_COLS[cols];
  return (
    <div className={["grid grid-cols-2", gridCols, "gap-3", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
