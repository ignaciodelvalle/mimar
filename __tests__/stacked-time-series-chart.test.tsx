/**
 * StackedTimeSeriesChart contract tests (PR-1 — RSC serializable labels).
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom). recharts'
 * ResponsiveContainer renders no SVG children in static SSR, so we assert on the
 * accessibility data-table the component always renders: one <th> per series key
 * carrying its resolved es-AR label.
 *
 * Why this exists: the chart is a Client Component. Its label contract MUST be
 * serializable data (a key -> label map), never a function — passing a function
 * across the server -> client boundary crashes the route (Next RSC:
 * "Functions cannot be passed directly to Client Components"). The prop is
 * `seriesLabels: Record<string, string>`, resolved server-side at the call-site.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type StackedSeriesPoint,
  StackedTimeSeriesChart,
} from "@/components/charts/StackedTimeSeriesChart";

const POINTS: StackedSeriesPoint[] = [
  { x: "2026-W01", values: { disease: 3, accident: 1 } },
  { x: "2026-W02", values: { disease: 5, accident: 2 } },
];

describe("StackedTimeSeriesChart — serializable label contract", () => {
  it("renders resolved es-AR labels from the seriesLabels data map", () => {
    const html = renderToStaticMarkup(
      <StackedTimeSeriesChart
        seriesKeys={["disease", "accident"]}
        points={POINTS}
        seriesLabels={{ disease: "Enfermedad", accident: "Accidente" }}
        fallbackTableLabel="Fallecimientos por semana y causa"
      />,
    );
    expect(html).toContain("Enfermedad");
    expect(html).toContain("Accidente");
    expect(html).toContain("Fallecimientos por semana y causa");
  });

  it("falls back to the raw key when a label is missing from the map", () => {
    const html = renderToStaticMarkup(
      <StackedTimeSeriesChart
        seriesKeys={["disease", "mystery_cause"]}
        points={POINTS}
        seriesLabels={{ disease: "Enfermedad" }}
      />,
    );
    expect(html).toContain("Enfermedad");
    expect(html).toContain("mystery_cause");
  });
});

// SUPPRESSED ≠ ZERO (metric-honesty audit, PO 2026-09-16).
//
// The "Ver datos" table is the ONLY place this chart publishes exact numbers —
// recharts renders no SVG children under renderToStaticMarkup, and the stacked
// area cannot show a mask geometrically anyway (a masked band is already
// zero-height, so a path break would read as a render glitch rather than as
// information). That makes the table the surface where the false claim lived:
// a month with 1..4 rabies deaths on /gob/mortalidad printed a plain "0",
// inside a card whose header simultaneously disclosed how many cells were
// hidden. The number and the disclosure contradicted each other and the number
// is the one people quote.
describe("StackedTimeSeriesChart — a masked cell is never published as a zero", () => {
  const MASKED: StackedSeriesPoint[] = [
    // W01 "disease" really had 1..4 deaths; suppressSmallStackedCells zeroed the
    // value and flagged the cell.
    { x: "2026-W01", values: { disease: 0, accident: 7 }, suppressed: { disease: true } },
    { x: "2026-W02", values: { disease: 6, accident: 0 } },
  ];

  const render = () =>
    renderToStaticMarkup(
      <StackedTimeSeriesChart
        seriesKeys={["disease", "accident"]}
        points={MASKED}
        seriesLabels={{ disease: "Enfermedad", accident: "Accidente" }}
        fallbackTableLabel="Fallecimientos por semana y causa"
        suppressedCount={1}
      />,
    );

  it("writes 'oculto (privacidad)' in the data table instead of the masked 0", () => {
    expect(render()).toContain("oculto (privacidad)");
  });

  it("keeps rendering the GENUINE zero in the same table as a zero", () => {
    // The guard that keeps this fix from overreaching: W02's "accident" is a
    // true 0 and must stay a 0. Suppression masks 1..k-1, never a real zero —
    // an operator who cannot see a real dip has lost the signal the chart is for.
    const html = render();
    const rows = html.split("<tr");
    const w02 = rows.find((r) => r.includes("2026-W02")) ?? "";
    expect(w02).toContain(">0<");
    expect(w02).not.toContain("oculto (privacidad)");
  });

  it("tells a screen reader that the table holds masked cells, not zeros", () => {
    // The plot is figure[role="img"]; everything inside it is presentational, so
    // the aria-label is the whole story assistive tech gets about the chart.
    const html = render();
    expect(html).toContain("1 celda oculta por privacidad");
  });
});
