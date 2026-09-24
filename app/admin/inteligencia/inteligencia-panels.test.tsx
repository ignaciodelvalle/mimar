// @vitest-environment jsdom
//
// /admin/inteligencia streamed panels (platform-budget T3.2).
//
// The pre-T3 page raced ONE 10 s loadWithTimeout over four fetchers — one slow
// query degraded the WHOLE page, and "Reintentar" re-fought the same four-query
// contention. These tests pin the new contract: each panel awaits its OWN
// AnalyticsLoad envelope, degrades ALONE into the honest AnalyticsLoadFallback
// (with a retry href scoped to the page + current period params), and a
// degraded KPI tile says "sin datos" — never a fabricated zero.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AnalyticsLoad } from "@/lib/analytics/analytics-load";
import type { ProvinceDataQualityResult } from "@/lib/analytics/territorial-data-quality";

import {
  IntelIndexKpis,
  IntelIndexPanel,
  IntelPolicyKpi,
  IntelPolicyPanel,
  IntelQualityKpi,
  IntelQualityPanel,
  diffEntries,
} from "./inteligencia-panels";

const ok = <T,>(value: T): Promise<AnalyticsLoad<T>> => Promise.resolve({ ok: true, value });
const timedOut = <T,>(): Promise<AnalyticsLoad<T>> =>
  Promise.resolve({ ok: false, reason: "timeout" });

const EMPTY_QUALITY: ProvinceDataQualityResult = {
  rows: [],
  suppressedProvinces: 0,
  unassigned: 0,
};

describe("panel independence — one degraded panel never drags the others", () => {
  it("index panel renders its card while the policy panel times out", async () => {
    const indexHtml = renderToStaticMarkup(
      await IntelIndexPanel({ load: ok<never[]>([]), sp: {} }),
    );
    const policyHtml = renderToStaticMarkup(await IntelPolicyPanel({ load: timedOut(), sp: {} }));

    // Index panel: the real card (empty-state variant — honest, not degraded).
    expect(indexHtml).toContain("Índice territorial compuesto");
    expect(indexHtml).toContain("Sin datos suficientes");
    // Policy panel: the honest degraded fallback with a real retry link.
    expect(policyHtml).toContain("tardando más de lo normal");
    expect(policyHtml).toContain("Reintentar");
    expect(policyHtml).not.toContain("Política → resultado");
  });
});

describe("degraded panels", () => {
  it("quality panel timeout → AnalyticsLoadFallback with the scoped retry href (period kept)", async () => {
    const html = renderToStaticMarkup(
      await IntelQualityPanel({ load: timedOut(), sp: { period: "90d" } }),
    );
    expect(html).toContain("Reintentar");
    expect(html).toContain("/admin/inteligencia?period=90d");
  });

  it("quality panel error → the error variant of the fallback", async () => {
    const html = renderToStaticMarkup(
      await IntelQualityPanel({
        load: Promise.resolve({ ok: false, reason: "error" }),
        sp: {},
      }),
    );
    expect(html).toContain("No pudimos cargar los datos");
    expect(html).toContain("Reintentar");
  });

  it("policy panel renders real data when its own load succeeds", async () => {
    const html = renderToStaticMarkup(await IntelPolicyPanel({ load: ok([]), sp: {} }));
    expect(html).toContain("Política → resultado");
    expect(html).toContain("Sin cambios de reglas");
  });

  it("quality panel renders real data when its own load succeeds", async () => {
    const html = renderToStaticMarkup(await IntelQualityPanel({ load: ok(EMPTY_QUALITY), sp: {} }));
    expect(html).toContain("Calidad de datos por provincia");
  });
});

describe("degraded KPI tiles — explicit 'sin datos', never zeros", () => {
  it("index KPIs degrade to '—' + 'Sin datos por demora'", async () => {
    const html = renderToStaticMarkup(await IntelIndexKpis({ load: timedOut() }));
    expect(html).toContain("Provincias evaluadas");
    expect(html).toContain("Índice promedio");
    expect(html).toContain("Sin datos por demora");
    expect(html).not.toContain(">0<");
  });

  it("policy KPI degrades to '—' + 'Sin datos por demora'", async () => {
    const html = renderToStaticMarkup(await IntelPolicyKpi({ load: timedOut() }));
    expect(html).toContain("Cambios de reglas");
    expect(html).toContain("Sin datos por demora");
  });

  it("policy KPI renders the real window sub-line when its load succeeds", async () => {
    const html = renderToStaticMarkup(await IntelPolicyKpi({ load: ok([]) }));
    expect(html).toContain("Cambios de reglas");
    expect(html).not.toContain("Sin datos por demora");
  });
});

// T4.16 (2026-08-01): five sites in this file interpolated a raw JS number
// straight into a "%" string — a plain "." decimal separator inside an es-AR
// UI (formatPercent renders "41,3%", the raw code rendered "41.3%"). Each
// case below picks a value with a real fractional part so the assertion
// distinguishes the two — a whole-number fixture (e.g. 50) would pass either
// way, since formatPercent's "50,0%" and the raw "50%" only differ once a
// decimal exists. These tests FAIL against the pre-fix code (which emits the
// "." form and never the "," form).
describe("es-AR decimal formatting (T4.16)", () => {
  it("DeltaCell (policy panel Δ column) renders the comma decimal, not a raw JS float", async () => {
    const html = renderToStaticMarkup(
      await IntelPolicyPanel({
        load: ok([
          {
            auditId: "audit-1",
            action: "govt_business_rule_updated",
            ruleType: "ppp_breed_list",
            province: "Córdoba",
            locality: null,
            changedAt: new Date("2026-07-01T00:00:00Z"),
            previousPayload: null,
            newPayload: null,
            metricLabel: "Cobertura antirrábica",
            eventType: "vaccination_administered",
            before: 100,
            after: 141,
            deltaPct: 41.3,
            afterDaysCovered: 30,
            partialAfter: false,
            suppressed: false,
            deltaUnstable: false,
          },
        ]),
        sp: {},
      }),
    );
    expect(html).toContain("+41,3%");
    expect(html).not.toContain("41.3%");
  });

  it("DeltaCell renders a negative delta with the comma decimal too", async () => {
    const html = renderToStaticMarkup(
      await IntelPolicyPanel({
        load: ok([
          {
            auditId: "audit-2",
            action: "govt_business_rule_updated",
            ruleType: "ppp_breed_list",
            province: "Santa Fe",
            locality: null,
            changedAt: new Date("2026-07-01T00:00:00Z"),
            previousPayload: null,
            newPayload: null,
            metricLabel: "Mordeduras",
            eventType: "incident_reported",
            before: 17,
            after: 3,
            deltaPct: -82.4,
            afterDaysCovered: 30,
            partialAfter: false,
            suppressed: false,
            deltaUnstable: false,
          },
        ]),
        sp: {},
      }),
    );
    expect(html).toContain("82,4%");
    expect(html).not.toContain("82.4%");
  });

  it("ghost-records KPI sub-line renders the comma decimal, not a raw JS float", async () => {
    const html = renderToStaticMarkup(
      await IntelQualityKpi({
        load: ok({
          rows: [
            {
              province: "Buenos Aires",
              total: 300,
              missingLocality: 0,
              missingSex: 0,
              missingChip: 0,
              orphans: 41,
              dormant: 41,
              ghosts: 41,
              replacedChips: 0,
              score: 90,
              rank: 1,
            },
          ],
          suppressedProvinces: 0,
          unassigned: 0,
        }),
      }),
    );
    // 41/300 * 100 = 13.6666… → Math.round(*1000)/10 = 13.7
    expect(html).toContain("13,7%");
    expect(html).not.toContain("13.7%");
  });

  it("índice compuesto table renders each component rate with the comma decimal", async () => {
    const html = renderToStaticMarkup(
      await IntelIndexPanel({
        // The load used to be a [rows, censusPopulations] tuple. The census
        // half only fed the impact column's canine population estimate, and
        // that estimate was the wrong denominator for two of these three
        // metrics (metric-honesty audit, PO 2026-09-16); the impact is now
        // counted over each row's own `denominator`, so the tuple is gone.
        load: ok([
          {
            province: "Córdoba",
            metric: "rabies",
            rate: 41.3,
            target: 80,
            gap: 38.7,
            isOutlier: true,
            denominator: 300,
          },
          {
            province: "Córdoba",
            metric: "sterilization",
            rate: 62.5,
            target: 70,
            gap: 7.5,
            isOutlier: true,
            denominator: 800,
          },
          {
            province: "Córdoba",
            metric: "microchip",
            rate: 15,
            target: 50,
            gap: 35,
            isOutlier: true,
            denominator: 800,
          },
        ]),
        sp: {},
      }),
    );
    expect(html).toContain("41,3%");
    expect(html).toContain("62,5%");
    // A whole-number rate (15) still goes through formatPercent — "15,0%",
    // not the bare "15%" the raw interpolation used to emit. This is the
    // case a whole-number-only fixture could not have caught.
    expect(html).toContain("15,0%");
    expect(html).not.toContain(">15%<");
  });
});

// Lote B4 — the key-level diff behind «Ver cambios». Pure function: the render
// path just maps its output, so the edge cases live here.
describe("diffEntries (B4)", () => {
  it("returns empty for identical payloads (including both null)", () => {
    expect(diffEntries({ days: 10 }, { days: 10 })).toEqual([]);
    expect(diffEntries(null, null)).toEqual([]);
  });

  it("reports changed keys with before → after values", () => {
    expect(diffEntries({ days: 10 }, { days: 14 })).toEqual([
      { key: "days", before: "10", after: "14" },
    ]);
  });

  it("reports added and removed keys with an em-dash placeholder", () => {
    const out = diffEntries({ old: true }, { nuevo: [1, 2] });
    expect(out).toContainEqual({ key: "old", before: "true", after: "—" });
    expect(out).toContainEqual({ key: "nuevo", before: "—", after: "[1,2]" });
  });

  it("compares nested values structurally, not by reference", () => {
    expect(diffEntries({ list: [1, 2] }, { list: [1, 2] })).toEqual([]);
    expect(diffEntries({ list: [1, 2] }, { list: [1, 3] })).toHaveLength(1);
  });
});
