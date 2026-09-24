/**
 * Paquete J, Fase J2 — projection-card smoke tests for /admin/poblacion and
 * /admin/programa.
 *
 * The pages are Server Components with live DB calls, so (matching the repo
 * convention in ux-2.3-dataviz.test.tsx) we exercise the exact data flow each
 * page wires up — fetch → projectSeries → ForecastChart — against
 * representative seed-shaped FLOW series, asserting:
 *   - a healthy series renders the projection card (band present, no crash), and
 *   - a short series renders the "insufficient" state instead of an invented
 *     straight line.
 *
 * Both pages pass NO `target` to ForecastChart (Paquete J §J-D3: the legal
 * target is coverage %, a different unit than these event counts — no %-meta on
 * a counts axis), which we also pin here.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ForecastChart } from "@/components/charts/ForecastChart";
import { projectSeries } from "@/lib/metrics/forecast";

// Seed-shaped sterilization FLOW series (event counts per bucket).
const STERIL_SERIES = [
  { x: "2026-W01", y: 12 },
  { x: "2026-W02", y: 18 },
  { x: "2026-W03", y: 15 },
  { x: "2026-W04", y: 22 },
  { x: "2026-W05", y: 25 },
  { x: "2026-W06", y: 28 },
];

// Seed-shaped antirrábica vaccination FLOW series (distinct dogs/bucket).
const RABIES_SERIES = [
  { x: "ene.", y: 40 },
  { x: "feb.", y: 55 },
  { x: "mar.", y: 48 },
  { x: "abr.", y: 62 },
  { x: "may.", y: 70 },
];

const SHORT_SERIES = [
  { x: "2026-W01", y: 6 },
  { x: "2026-W02", y: 9 },
];

describe("/admin/poblacion — sterilization projection card (J2.1)", () => {
  it("renders the projection card with seed data (band present, no crash)", () => {
    const result = projectSeries(STERIL_SERIES, { horizon: 3 });
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" unit="esterilizaciones" />,
    );
    expect(html).toContain("Proyección de Esterilizaciones");
    expect(html).toContain('data-forecast-has-band="true"');
    // §J-D3: no %-meta ReferenceLine on a counts axis.
    expect(html).toContain('data-forecast-has-target="false"');
  });

  it("shows 'insufficient' (not an invented line) for a short series", () => {
    const result = projectSeries(SHORT_SERIES, { horizon: 3 });
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Esterilizaciones" />,
    );
    expect(html).toContain("Datos insuficientes para proyectar");
    expect(html).toContain('data-forecast-has-band="false"');
  });
});

describe("/admin/programa — antirrábica projection card (J2.2)", () => {
  it("renders the projection card with seed data (band present, no crash)", () => {
    const result = projectSeries(RABIES_SERIES, { horizon: 3 });
    const html = renderToStaticMarkup(
      <ForecastChart
        result={result}
        seriesLabel="Vacunación antirrábica"
        unit="perros vacunados"
      />,
    );
    expect(html).toContain("Proyección de Vacunación antirrábica");
    expect(html).toContain('data-forecast-has-band="true"');
    // §J-D3: the legal target is coverage % (stock) — not painted on counts axis.
    expect(html).toContain('data-forecast-has-target="false"');
  });

  it("shows 'insufficient' (not an invented line) for a short series", () => {
    const result = projectSeries(SHORT_SERIES, { horizon: 3 });
    const html = renderToStaticMarkup(
      <ForecastChart result={result} seriesLabel="Vacunación antirrábica" />,
    );
    expect(html).toContain("Datos insuficientes para proyectar");
    expect(html).toContain('data-forecast-insufficient="true"');
  });
});
