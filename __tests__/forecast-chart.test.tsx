/**
 * ForecastChart contract tests (Paquete J, Fase J1).
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom). recharts'
 * ResponsiveContainer renders no SVG children in static SSR (zero dimensions),
 * so we assert on the plain-DOM contract the component owns OUTSIDE the chart:
 *   - the figure[role="img"] wrapper + descriptive aria-label,
 *   - data-forecast-* markers that pin the dashed-segment/band/refline decisions,
 *   - the honesty footnote (n + method),
 *   - the crossing callout,
 *   - the insufficient state (message, no band),
 *   - the accessible data table (observed vs proyección rows).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ForecastChart } from "@/components/charts/ForecastChart";
import { type ForecastResult, projectSeries, targetCrossing } from "@/lib/metrics/forecast";

const RISING = [
  { x: "2026-W01", y: 10 },
  { x: "2026-W02", y: 15 },
  { x: "2026-W03", y: 20 },
  { x: "2026-W04", y: 25 },
  { x: "2026-W05", y: 30 },
  { x: "2026-W06", y: 35 },
];

const SHORT = [
  { x: "2026-W01", y: 5 },
  { x: "2026-W02", y: 8 },
  { x: "2026-W03", y: 11 },
];

describe("ForecastChart — forecast present", () => {
  const result = projectSeries(RISING, { horizon: 3 });

  it("renders a figure[role='img'] with a descriptive aria-label", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("Proyección de Esterilizaciones");
    expect(html).toContain("tendencia en aumento");
  });

  it("marks that a confidence band is present (dashed-segment + band exist)", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain('data-forecast-has-band="true"');
    expect(html).toContain('data-forecast-insufficient="false"');
  });

  it("renders the honesty footnote with n and method", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain("Proyección de tendencia — no es una garantía");
    expect(html).toContain("n=6");
    expect(html).toContain("método=lineal");
  });

  it("renders the accessible data table with observed and proyección rows", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain("Ver datos");
    expect(html).toContain("observado");
    expect(html).toContain("proyección");
    // The forecast tail renders its band as "y (lo–hi)".
    expect(html).toContain("–");
  });
});

describe("ForecastChart — target reference", () => {
  const result = projectSeries(RISING, { horizon: 3 });

  it("marks that a target reference line is present when a same-unit target is passed", () => {
    const html = renderToStaticMarkup(
      <ForecastChart
        result={result}
        seriesLabel="Esterilizaciones"
        target={{ value: 40, label: "Meta de volumen" }}
      />,
    );
    expect(html).toContain('data-forecast-has-target="true"');
  });

  it("does NOT mark a target when none is provided (J-D3: no %-meta on counts axis)", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain('data-forecast-has-target="false"');
  });
});

describe("ForecastChart — crossing callout", () => {
  it("renders the reach-target callout when crossing is non-null", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    const crossing = targetCrossing(result, 50, "above"); // 3
    expect(crossing).toBe(3);
    const html = renderToStaticMarkup(
      <ForecastChart
        result={result}
        seriesLabel="Esterilizaciones"
        target={{ value: 50, label: "Meta" }}
        crossing={crossing}
      />,
    );
    expect(html).toContain("Alcanza la meta en aproximadamente 3 períodos");
  });

  it("renders the not-reached callout when crossing is null but a target exists", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    const crossing = targetCrossing(result, 100, "above"); // null
    expect(crossing).toBeNull();
    const html = renderToStaticMarkup(
      <ForecastChart
        result={result}
        seriesLabel="Esterilizaciones"
        target={{ value: 100, label: "Meta" }}
        crossing={crossing}
      />,
    );
    expect(html).toContain("A este ritmo no alcanza la meta");
  });
});

describe("ForecastChart — insufficient data", () => {
  const result = projectSeries(SHORT, { horizon: 3 });

  it("shows the insufficient message and NO band", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain("Datos insuficientes para proyectar");
    expect(html).toContain('data-forecast-insufficient="true"');
    expect(html).toContain('data-forecast-has-band="false"');
  });

  it("still renders the actuals in the accessible data table", () => {
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain("observado");
    // No forecast rows when insufficient: the type cell ">proyección<" only
    // appears for forecast rows (the word also occurs in the figcaption prose,
    // so we assert on the table-cell form specifically).
    expect(html).not.toContain(">proyección<");
  });

  it("does not throw when rendering the insufficient state", () => {
    expect(() =>
      renderToStaticMarkup(<ForecastChart result={result} seriesLabel="Esterilizaciones" />),
    ).not.toThrow();
  });
});

// B1 — Forecast no longer renders an empty SVG.
//
// SSR note: the ResponsiveContainer is CLIENT-GATED (red-team-admin-2 P2.8) —
// ChartSizingBox only mounts it once the box has measured a non-zero width, so
// recharts never sees a 0/-1 dimension. It is therefore absent from
// renderToStaticMarkup entirely. The reliable SSR proxies are the SIZED BOX:
//   - happy path  → `data-forecast-chart` box with a concrete height IS present
//   - insufficient → that box is ABSENT (the honest "insufficient" state instead)
// The concrete height on that box is what guarantees the container can't collapse
// to 0 once it mounts on the client (the actual B1 fix).
describe("ForecastChart — B1: never an empty chart box", () => {
  it("gives the chart a concrete-height container so ResponsiveContainer can't collapse to 0", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Antirrábica" height={300} />,
    );
    // The chart branch renders a sized box (the B1 fix). The ResponsiveContainer
    // itself is client-gated, so we assert the box + its concrete height, which
    // is what prevents a 0-dimension mount on the client.
    expect(html).toContain('data-forecast-chart="true"');
    expect(html).toContain("min-height:300px");
    expect(html).toContain('data-forecast-insufficient="false"');
  });

  it("falls back to the honest insufficient state when there are < 2 actuals (no empty SVG)", () => {
    // A result that claims to be sufficient but only carries ONE actual vertex —
    // recharts would paint nothing. The cannotPlot guard must catch it.
    const onePoint: ForecastResult = {
      points: [{ x: "2026-W01", y: 10, lo: 10, hi: 10, kind: "actual" }],
      method: "linear",
      slopePerBucket: 0,
      insufficient: false,
    };
    const html = renderToStaticMarkup(
      <ForecastChart result={onePoint} seriesLabel="Antirrábica" />,
    );
    expect(html).toContain('data-forecast-insufficient="true"');
    expect(html).toContain("Datos insuficientes para proyectar");
    expect(html).not.toContain('data-forecast-chart="true"');
    // recharts is NOT mounted in the insufficient branch — no empty SVG possible.
    expect(html).not.toContain("recharts-responsive-container");
  });

  it("also falls back when there are zero actual points", () => {
    // Covers the n=0 edge: a synthetic result with no points at all should
    // also show the insufficient state, not mount an empty recharts chart.
    const noPoints: ForecastResult = {
      points: [],
      method: "linear",
      slopePerBucket: 0,
      insufficient: false, // upstream didn't flag it — our guard must still catch it
    };
    const html = renderToStaticMarkup(
      <ForecastChart result={noPoints} seriesLabel="Antirrábica" />,
    );
    expect(html).toContain('data-forecast-insufficient="true"');
    expect(html).toContain("Datos insuficientes para proyectar");
    expect(html).not.toContain("recharts-responsive-container");
  });
});
