// PanoramaKpiTile — v+1 rail additions (sparkline + target-progress bar).
//
// Pattern: renderToStaticMarkup (repo convention for OpKpi-prop contracts —
// see __tests__/dashboards-vnext-fase0.test.tsx). No jsdom required; verifies
// the tile forwards `kpi.sparkline`/`kpi.bar` to OpKpi without throwing and
// that the existing neutral-delta contract (never a valence color) survives.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanoramaKpiTile } from "@/components/panorama/PanoramaKpiTile";
import type { PanoramaKpi } from "@/src/modules/panorama/application/get-panorama-kpis";

const REUNIFICACION_KPI: PanoramaKpi = {
  id: "reunificacion",
  label: "Tasa de reunificación",
  value: "45,2%",
  sub: "meta 39% · 19 de 42 episodios",
  bar: 45.2,
  tone: "ok",
  href: "/gob/perdidas",
  source: "compliance-metrics.fetchReunificationRate",
  info: { definition: "def" },
};

const COBERTURA_KPI: PanoramaKpi = {
  id: "cobertura",
  label: "Cobertura antirrábica (perros, 12m)",
  value: "72,4%",
  bar: 72.4,
  tone: "warn",
  href: "/gob/programa?vista=resumen#gob-programa-outliers-titulo",
  source: "govt-home-kpis.fetchRabiesCoverage",
  info: { definition: "def" },
  // Un punto entero por bucket, no sólo el número: el flag `suppressed` que
  // pone suppressSmallBuckets viaja con él (metric-honesty audit, PO 2026-09-16).
  // La proyección `.map((p) => p.y)` que había antes en get-panorama-kpis.ts lo
  // borraba, y un bucket enmascarado se dibujaba como una caída al piso.
  sparkline: [{ y: 60 }, { y: 65 }, { y: 68 }, { y: 70 }, { y: 72 }],
  delta: { pct: 12, unit: "pct", direction: "up", label: "+12% vs período anterior" },
};

describe("PanoramaKpiTile — v+1 rail (meta-progress meters + sparklines)", () => {
  it("renders without throwing when `bar` (target-progress meter) is set", () => {
    expect(() => renderToStaticMarkup(<PanoramaKpiTile kpi={REUNIFICACION_KPI} />)).not.toThrow();
  });

  it("renders the meta-progress bar fill via OpKpi's `bar` prop", () => {
    const html = renderToStaticMarkup(<PanoramaKpiTile kpi={REUNIFICACION_KPI} />);
    // OpKpi renders the bar as an inline width style clamped 0..100.
    expect(html).toContain("width:45.2%");
  });

  it("renders without throwing when `sparkline` is set (dynamic-imported chart)", () => {
    expect(() => renderToStaticMarkup(<PanoramaKpiTile kpi={COBERTURA_KPI} />)).not.toThrow();
  });

  it("keeps the delta line a NEUTRAL glyph — never a valence color (code review 2026-07-03)", () => {
    const html = renderToStaticMarkup(<PanoramaKpiTile kpi={COBERTURA_KPI} />);
    // UI professionalism pass: the raw "▲" glyph was retired in favor of the
    // Icon registry — same "up" signal, no bare symbol-as-icon text.
    //
    // ARROW, not chevron (2026-07-25). This test previously pinned
    // "chevron-up", which locked in a real defect: a chevron is the universal
    // DISCLOSURE affordance, so beside "-26%" it read as a collapse control and
    // the PO tried to click it. Nothing here is interactive. OpKpi already used
    // "↑"/"↓" for the identical concept, so Panorama was also the odd surface
    // out. A passing test is not evidence the behaviour was right.
    expect(html).toContain('data-icon-name="arrow-up"');
    expect(html).not.toContain('data-icon-name="chevron-up"');
    expect(html).toContain("+12% vs período anterior");
    // The neutral delta line must not carry the ok/err color tokens (those are
    // reserved for the v1/v2 OpKpi delta props, unused by PanoramaKpiTile).
    expect(html).not.toContain("var(--color-st-ok)");
    expect(html).not.toContain("var(--color-st-err)");
  });

  it("still renders label and value alongside the new props", () => {
    const html = renderToStaticMarkup(<PanoramaKpiTile kpi={REUNIFICACION_KPI} />);
    expect(html).toContain("Tasa de reunificación");
    expect(html).toContain("45,2%");
  });

  // Per-tile degradation: a tile whose PRIMARY fetcher rejected renders an honest
  // self-contained "no disponible" card — its label (so the operator knows WHICH
  // metric failed) but NO numbers (parity: never a stale/wrong figure).
  it("renders an honest 'no disponible' card for an unavailable tile", () => {
    const UNAVAILABLE_KPI: PanoramaKpi = {
      id: "mordeduras",
      label: "Mordeduras / 10k hab.",
      value: "—",
      tone: "neutral",
      href: "/gob/vigilancia",
      source: "govt-home-kpis.fetchBitesPer10k",
      info: { definition: "def" },
      unavailable: true,
    };
    const html = renderToStaticMarkup(<PanoramaKpiTile kpi={UNAVAILABLE_KPI} />);
    expect(html).toContain("Mordeduras / 10k hab.");
    expect(html).toContain("No disponible en este momento.");
    // No numbers, and no OpKpi delta/sparkline/bar chrome leaked in.
    expect(html).not.toContain("width:");
    expect(html).not.toContain('data-icon-name="chevron');
  });
});
