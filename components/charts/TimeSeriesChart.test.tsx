// @vitest-environment jsdom
//
// TimeSeriesChart — the honest rendering of a k-anonymity-masked bucket.
//
// suppressSmallBuckets (lib/metrics/timeseries.ts) masks a 1..k-1 count as
// `y: 0` PLUS `suppressed: true`, because every numeric consumer downstream
// (sparklines, deltas) needs a number. That makes the flag the ONLY thing
// separating "we measured zero" from "we are not allowed to tell you" — and a
// zero is an epidemiological claim while a mask is the absence of one.
//
// This component had zero tests. Its two honest behaviours — a GAP in the
// plotted line and "oculto (privacidad)" in the "Ver datos" table — were
// therefore unguarded, in the exact place a funcionario reads the numbers.
// (Found 2026-08-01: /gob published eleven masked months as eleven zeros while
// the Panorama CSV/PNG of the same fact wrote "Protegido (k<5)".)

import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TimeSeriesChart, type TimeSeriesPoint } from "./TimeSeriesChart";

/** One masked bucket, one genuine zero, one real measurement. */
const MIXED: TimeSeriesPoint[] = [
  { x: "jul 25", y: 0, suppressed: true },
  { x: "ago 25", y: 0 },
  { x: "jun 26", y: 14 },
];

function render(props: Partial<Parameters<typeof TimeSeriesChart>[0]> = {}): string {
  return renderToStaticMarkup(<TimeSeriesChart data={MIXED} seriesLabel="Mordeduras" {...props} />);
}

describe("TimeSeriesChart — the accessible data table", () => {
  it("prints 'oculto (privacidad)' for a masked bucket, never the masked 0", () => {
    const html = render();
    expect(html).toContain("oculto (privacidad)");
    // The masked row must not carry the placeholder number beside its period.
    expect(html).not.toMatch(/jul 25<\/td>\s*<td[^>]*>0</);
  });

  it("prints a genuine measured zero as 0 — a real dip stays readable", () => {
    const html = render();
    expect(html).toMatch(/ago 25<\/td><td[^>]*>0</);
  });

  it("prints a real measurement unchanged", () => {
    const html = render();
    expect(html).toMatch(/jun 26<\/td><td[^>]*>14</);
  });
});

describe("TimeSeriesChart — the fully-masked series", () => {
  const ALL_MASKED: TimeSeriesPoint[] = [
    { x: "jul 25", y: 0, suppressed: true },
    { x: "ago 25", y: 0, suppressed: true },
  ];

  it("blames privacy, not missing data, when every bucket is masked", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart data={ALL_MASKED} seriesLabel="Mordeduras" suppressedCount={2} />,
    );
    expect(html).toContain("Datos ocultos por privacidad (k&lt;5).");
    expect(html).not.toContain("Sin datos para el período seleccionado.");
  });

  it("says 'sin datos' — not 'privacidad' — when the series is genuinely empty", () => {
    const html = renderToStaticMarkup(<TimeSeriesChart data={[]} seriesLabel="Mordeduras" />);
    expect(html).toContain("Sin datos para el período seleccionado.");
    expect(html).not.toContain("privacidad");
  });
});
