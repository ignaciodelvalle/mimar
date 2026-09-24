// Unit test for the panorama KPI use-case. The dashboard fetchers are mocked,
// so this runs with NO database — it verifies the orchestration, that scope +
// period are threaded UNTOUCHED to the tested fetchers (parity), and that the
// values are formatted/labelled correctly. The whole selling point is that the
// console reuses the SAME fetchers as the dashboards; this test pins that.

import { beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: the mock paths MUST match the SUT's import specifiers exactly
// (@/lib/analytics/…). They used to point at @/lib/govt-* — nonexistent
// modules — so the REAL fetchers loaded and vi.mocked(...) wrapped plain
// functions (mockResolvedValue crashed). Fixed alongside the map-QOL deltas.
vi.mock("@/lib/analytics/govt-dashboards", () => ({
  fetchAnalyticsMetrics: vi.fn(),
  fetchPerdidasMetrics: vi.fn(),
}));
vi.mock("@/lib/analytics/govt-home-kpis", () => ({
  fetchRabiesCoverage: vi.fn(),
  fetchBitesPer10k: vi.fn(),
  fetchActiveZoonosis: vi.fn(),
  fetchOpenWelfareReportsCount: vi.fn(),
}));
vi.mock("@/lib/metrics/population-control", () => ({
  fetchSterilizationCoverage: vi.fn(),
}));
vi.mock("@/lib/metrics/freshness", () => ({
  lastIngestAt: vi.fn(),
}));
// v+1 rail — meta-progress meters (D4 reunification + C1 microchip) + C7 PPP.
vi.mock("@/lib/analytics/compliance-metrics", () => ({
  fetchReunificationRate: vi.fn(),
  fetchMicrochipPenetration: vi.fn(),
  fetchDangerousBreedCompliance: vi.fn(),
}));
// v+1 rail — KPI sparklines (same trend fetchers /gob home uses).
vi.mock("@/lib/metrics/trends", () => ({
  fetchRabiesVaccinationTrend: vi.fn(),
  fetchBitesTrend: vi.fn(),
  fetchKpiTrend: vi.fn(),
}));
// Coherence hybrid (round 2, H1): the zoonosis PRIMARY signal total (== map).
// Orphaned-layer wiring: mortality province aggregate (KPI == Σ map cells).
vi.mock("@/src/modules/panorama/infrastructure/repository", () => ({
  loadZoonosisSignalScopeTotal: vi.fn(),
  loadMortalityByProvince: vi.fn(),
}));

import {
  fetchDangerousBreedCompliance,
  fetchMicrochipPenetration,
  fetchReunificationRate,
} from "@/lib/analytics/compliance-metrics";
import { fetchAnalyticsMetrics, fetchPerdidasMetrics } from "@/lib/analytics/govt-dashboards";
import {
  fetchActiveZoonosis,
  fetchBitesPer10k,
  fetchOpenWelfareReportsCount,
  fetchRabiesCoverage,
} from "@/lib/analytics/govt-home-kpis";
import type { AnalyticsPeriod } from "@/lib/metrics";
import { buildProjectionContext } from "@/lib/metrics/context";
import { lastIngestAt } from "@/lib/metrics/freshness";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";
// NOT mocked on purpose: the two C1 tests below derive the verdict from the REAL
// rule, so a fixture cannot assert a `scopeTotalPublishable` the rule would not
// produce. Re-deriving the rule as `total >= 5` inside the SUT kills the D.10
// test alone; hardcoding `true` in the SUT kills the withholding test alone.
import {
  planProvinceDisclosure,
  scopeTotalSuppressionNotice,
} from "@/lib/metrics/province-disclosure";
import { fetchBitesTrend, fetchKpiTrend, fetchRabiesVaccinationTrend } from "@/lib/metrics/trends";
import {
  loadMortalityByProvince,
  loadZoonosisSignalScopeTotal,
} from "@/src/modules/panorama/infrastructure/repository";

import {
  PanoramaKpisUnavailableError,
  degradedPanoramaKpis,
  getPanoramaKpis,
} from "../get-panorama-kpis";

const period: AnalyticsPeriod = {
  since: new Date("2025-06-20T00:00:00.000Z"),
  until: new Date("2026-06-20T00:00:00.000Z"),
};

function seedDefaults() {
  vi.mocked(fetchRabiesCoverage).mockResolvedValue({
    current: 72.4,
    target: 80,
    partidos: 3,
    hasData: true,
    registryDenominator: 12_480,
    censusDenominator: 474_333,
    censusCoveragePct: 2.6,
    signedCount: 0,
    signedPct: 0,
  });
  vi.mocked(fetchAnalyticsMetrics).mockResolvedValue({
    totalPets: 12345,
    totalAcquisitions: 100,
    adoptionRate: 0,
    rabiesVaccinationRate: 0,
    custodyDisputes: 0,
  });
  vi.mocked(fetchPerdidasMetrics).mockResolvedValue({
    activeCount: 42,
    recoveredMonth: 7,
    avgDaysActive: 5,
  });
  vi.mocked(fetchBitesPer10k).mockResolvedValue({
    rate: 3.5,
    delta: 0,
    reports: 18,
    percapitaEligible: true,
  });
  vi.mocked(fetchActiveZoonosis).mockResolvedValue({
    count: 9,
    rabies: 2,
    lepto: 1,
    hidat: 0,
    deltaWeek: 0,
  });
  // Zoonosis PRIMARY signal total (== map): current then prior window.
  vi.mocked(loadZoonosisSignalScopeTotal).mockResolvedValue(7);
  vi.mocked(fetchOpenWelfareReportsCount).mockResolvedValue({ count: 4, inPeriod: 4 });
  vi.mocked(fetchSterilizationCoverage).mockResolvedValue({
    rate: 65.7,
    sterilized: 657,
    total: 1000,
    byProvince: [],
    byProvinceSuppressedCount: 0,
    byProvinceAssignedTotal: 0,
    scopeTotalPublishable: true,
  });
  vi.mocked(lastIngestAt).mockResolvedValue(new Date("2026-06-19T18:30:00.000Z"));
  // v+1 rail defaults.
  vi.mocked(fetchReunificationRate).mockResolvedValue({
    ratePct: 45.2,
    recovered: 19,
    lostEpisodes: 42,
    medianDaysToRecovery: 3,
  });
  vi.mocked(fetchMicrochipPenetration).mockResolvedValue({
    ratePct: 55.1,
    chipped: 551,
    active: 1000,
    byLocality: { value: [] as never, suppressedCount: 0 },
  });
  // Orphaned-layer wiring — C7 PPP registry adoption (has PPP in scope by default).
  vi.mocked(fetchDangerousBreedCompliance).mockResolvedValue({
    ratePct: 30,
    attested: 6,
    flaggedCount: 20,
  });
  // Orphaned-layer wiring — mortality province aggregate (KPI == Σ cell counts).
  // #40: CABA was `value: 4` here — a count the province loader can no longer
  // emit unsuppressed (density denominator == the count itself, and 4 < k=5), so
  // the fixture modelled an impossible loader output. Both cells now clear k;
  // the suppressed case has its own test below.
  vi.mocked(loadMortalityByProvince).mockResolvedValue({
    cells: [
      { provinceCode: "AR-B", label: "Buenos Aires", value: 8, suppressed: false },
      { provinceCode: "AR-C", label: "CABA", value: 6, suppressed: false },
    ],
    truncated: false,
    suppressedCount: 0,
  });
  vi.mocked(fetchRabiesVaccinationTrend).mockResolvedValue({
    granularity: "month",
    points: [
      { x: "ene", y: 10 },
      { x: "feb", y: 14 },
    ],
    suppressedCount: 0,
  });
  vi.mocked(fetchBitesTrend).mockResolvedValue({
    granularity: "month",
    points: [
      { x: "ene", y: 3 },
      { x: "feb", y: 5 },
    ],
    suppressedCount: 0,
  });
  vi.mocked(fetchKpiTrend).mockResolvedValue({
    granularity: "month",
    points: [
      { x: "ene", y: 1 },
      { x: "feb", y: 2 },
    ],
    suppressedCount: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedDefaults();
});

describe("getPanoramaKpis", () => {
  it("returns 10 headline KPIs in display order, each backed by a named dashboard fetcher", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    // Legal-analysis reorientation (2026-07-03): the two legally-grounded
    // compliance coverages lead. v+1 rail: "microchip" joins the compliance
    // trio; "reunificacion" (D4) sits next to "perdidas". metric-honesty
    // 2026-07-09: "mascotas" (the coverage DENOMINATOR) is no longer a headline
    // tile — it moved to the `coverageDenominator` footer field. Orphaned-layer
    // wiring: "ppp" joins the compliance family; "mortalidad" closes the strip.
    expect(kpis.map((k) => k.id)).toEqual([
      "cobertura",
      "esterilizacion",
      "microchip",
      "ppp",
      "perdidas",
      "reunificacion",
      "mordeduras",
      "zoonosis",
      "denuncias",
      "mortalidad",
    ]);
    // Parity proof: every KPI names the fetcher that produced it.
    expect(kpis.map((k) => k.source)).toEqual([
      "govt-home-kpis.fetchRabiesCoverage",
      "metrics.fetchSterilizationCoverage",
      "compliance-metrics.fetchMicrochipPenetration",
      "compliance-metrics.fetchDangerousBreedCompliance",
      "govt-dashboards.fetchPerdidasMetrics",
      "compliance-metrics.fetchReunificationRate",
      "govt-home-kpis.fetchBitesPer10k",
      "repository.loadZoonosisSignalScopeTotal",
      "govt-home-kpis.fetchOpenWelfareReportsCount",
      "repository.loadMortalityByProvince",
    ]);
  });

  it("demotes the coverage denominator to a footer field, not a headline tile (metric-honesty)", async () => {
    const result = await getPanoramaKpis({ role: "admin" }, [], period);
    // fetchAnalyticsMetrics.totalPets (12345) now rides `coverageDenominator`,
    // formatted as a footer caption by PanoramaKpiFooter — never a decision KPI.
    // F9 (2026-08-01): the href was "/gob/analytics" — which pointed at the one
    // screen that no longer publishes this figure at all (the duplicate
    // registry_total_pets tile was removed from the Analítica vista in the same
    // change). The caption now points at its single publisher, the Resumen vista.
    expect(result.coverageDenominator).toEqual({
      totalPets: 12345,
      href: "/gob/programa?vista=resumen",
    });
    expect(result.kpis.some((k) => k.label === "Mascotas en cobertura")).toBe(false);
  });

  it("formats values with es-AR conventions and surfaces an info tooltip per KPI", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));

    // Percentage — one decimal, es-AR comma (72.4 → "72,4%").
    expect(byId.cobertura.value).toBe("72,4%");
    expect(byId.cobertura.bar).toBe(72.4);
    // Census-coverage-floor guard (parity with /gob, consistency sweep
    // 2026-07-23): the fixture's padrón covers only 2.6% of the estimated
    // canine population, so the 72.4% registry rate must NOT paint a verdict —
    // the tone degrades to neutral and the sub carries the reason.
    expect(byId.cobertura.tone).toBe("neutral");
    expect(byId.cobertura.sub).toContain("NO representa protección poblacional");

    // Decimal comma (es-AR) — 3.5 → "3,5".
    expect(byId.mordeduras.value).toBe("3,5");
    expect(byId.perdidas.value).toBe("42");
    // Zoonosis PRIMARY = the outbreak_signal total (7), NOT the composite (9);
    // the composite rides in the labeled secondary.
    expect(byId.zoonosis.value).toBe("7");
    expect(byId.zoonosis.secondary).toContain("activas hoy: 9");
    expect(byId.denuncias.value).toBe("4");

    // esterilizacion KPI — decimal precision survives to the display (65,7%).
    expect(byId.esterilizacion.value).toBe("65,7%");
    expect(byId.esterilizacion.bar).toBe(65.7);
    expect(byId.esterilizacion.tone).toBe("warn"); // 65.7 < target 70
    expect(byId.esterilizacion.sub).toBe("meta 70%");

    // Every KPI carries a non-empty info tooltip (the ⓘ definition).
    for (const k of kpis) {
      expect(k.info.definition.length).toBeGreaterThan(0);
      expect(k.href.startsWith("/gob/")).toBe(true);
    }
  });

  it("G2: mordeduras rate that rounds to 0,0 with reports>0 shows '<0,1' (not '0,0')", async () => {
    // 5 reports over a large population → a tiny rate that rounds to "0,0" at 1
    // decimal. Displaying "0,0" next to "5 reportes" reads as zero bites.
    vi.mocked(fetchBitesPer10k).mockResolvedValue({
      rate: 0.02,
      delta: 0,
      reports: 5,
      percapitaEligible: true,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "mordeduras")!;
    expect(kpi.value).toBe("<0,1");
    expect(kpi.sub).toContain("5 reportes");
  });

  it("G2: a genuine zero (0 reports) keeps the plain '0,0' rate", async () => {
    vi.mocked(fetchBitesPer10k).mockResolvedValue({
      rate: 0,
      delta: 0,
      reports: 0,
      percapitaEligible: true,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "mordeduras")!;
    expect(kpi.value).toBe("0,0");
    // A genuine zero is neutral, not an "Atención" warning (LOW-1).
    expect(kpi.tone).toBe("neutral");
  });

  it("mordeduras tile is tone 'warn' when there ARE reports", async () => {
    vi.mocked(fetchBitesPer10k).mockResolvedValue({
      rate: 3.5,
      delta: 0,
      reports: 18,
      percapitaEligible: true,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "mordeduras")!;
    expect(kpi.tone).toBe("warn");
  });

  it("H1: sub-provincial scope (percapitaEligible=false) shows the absolute count, not a rate", async () => {
    // A locality-scoped viewer: the numerator counts the locality but the census
    // denominator is province-grain only, so a per-10k rate would understate
    // incidence. The tile must show the raw report count and hide the rate/delta.
    vi.mocked(fetchBitesPer10k).mockResolvedValue({
      rate: 0,
      delta: 0,
      reports: 42,
      percapitaEligible: false,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "mordeduras")!;
    expect(kpi.label).toBe("Mordeduras (12 meses)");
    expect(kpi.value).toBe("42");
    expect(kpi.sub).toBe("sin padrón censal local");
    expect(kpi.delta).toBeUndefined();
  });

  it("esterilizacion KPI is tone ok when rate >= 70", async () => {
    vi.mocked(fetchSterilizationCoverage).mockResolvedValue({
      rate: 75.3,
      sterilized: 753,
      total: 1000,
      byProvince: [],
      byProvinceSuppressedCount: 0,
      byProvinceAssignedTotal: 0,
      scopeTotalPublishable: true,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "esterilizacion")!;
    expect(kpi.tone).toBe("ok");
    expect(kpi.value).toBe("75,3%");
  });

  // -------------------------------------------------------------------------
  // RA-3 finding C1, FOURTH SURFACE — the drilled scope headline
  // -------------------------------------------------------------------------
  //
  // Both tests build the verdict with the REAL `planProvinceDisclosure` and hand
  // it to the mocked fetcher, exactly as production does. Asserting the plan
  // first is not ceremony: it is what stops the pair from degenerating into "the
  // SUT echoes whatever boolean the fixture chose".

  const TDF_SUB_K = { province: "Tierra del Fuego", denominator: 3 } as const;

  it("a drilled admin's esterilización KPI is WITHHELD when the drill leaves one sub-k province", async () => {
    // `?province=Tierra del Fuego` narrows the WHOLE scope (petsScopeClause), so
    // the "whole-scope rate" IS that province's withheld cell under a KPI label.
    const drilled = buildProjectionContext({ role: "admin" }, [], period, {
      adminProvince: "Tierra del Fuego",
    });
    const plan = planProvinceDisclosure(drilled, [TDF_SUB_K]);
    expect(plan.scopeTotalPublishable).toBe(false);

    vi.mocked(fetchSterilizationCoverage).mockResolvedValue({
      rate: 33.3,
      sterilized: 1,
      total: 3,
      byProvince: [
        {
          province: "Tierra del Fuego",
          suppressed: true,
          ratePct: null,
          sterilized: null,
          total: null,
        },
      ],
      byProvinceSuppressedCount: plan.suppressedCount,
      byProvinceAssignedTotal: plan.publishableRowTotal,
      scopeTotalPublishable: plan.scopeTotalPublishable,
    });

    const { kpis } = await getPanoramaKpis(
      { role: "admin" },
      [],
      period,
      "Tierra del Fuego",
      undefined,
    );
    const kpi = kpis.find((k) => k.id === "esterilizacion")!;

    // No number, in ANY encoding: not the text, not the bar's width.
    expect(kpi.value).toBe("—");
    expect(kpi.value).not.toContain("33");
    expect(kpi.bar).toBeUndefined();
    // Never a false zero — a withheld value is ABSENT, not zero.
    expect(kpi.value).not.toBe("0%");
    expect(kpi.value).not.toBe("0,0%");
    // No verdict about a number we refuse to state.
    expect(kpi.tone).toBe("neutral");
    // It DISCLOSES, in the shared wording — hiding without saying so is worse
    // than publishing, because absence reads as "no pasa nada acá".
    expect(kpi.sub).toBe(scopeTotalSuppressionNotice(false));
    expect(kpi.sub).toContain("una sola jurisdicción");
    // A withholding is NOT an outage: `unavailable` would badge a deliberate
    // privacy decision as a broken fetcher.
    expect(kpi.unavailable).toBeFalsy();
  });

  it("D.10 SURVIVES: a govt operator viewing their OWN 3-pet province keeps the real number", async () => {
    // An own cell is never a suppression candidate (isOwnJurisdictionProvince),
    // so a single-unit OWN scope still publishes its headline. Over-suppressing
    // here would blind a jurisdiction about its own administrados — the RA-1
    // over-correction, in the other direction.
    const own = [{ province: "Tierra del Fuego", locality: "" }];
    const ownCtx = buildProjectionContext({ role: "govt" }, own, period);
    const plan = planProvinceDisclosure(ownCtx, [TDF_SUB_K]);
    expect(plan.scopeTotalPublishable).toBe(true);
    expect(plan.suppressedCount).toBe(0);

    vi.mocked(fetchSterilizationCoverage).mockResolvedValue({
      rate: 33.3,
      sterilized: 1,
      total: 3,
      byProvince: [
        {
          province: "Tierra del Fuego",
          suppressed: false,
          ratePct: 33.3,
          sterilized: 1,
          total: 3,
        },
      ],
      byProvinceSuppressedCount: plan.suppressedCount,
      byProvinceAssignedTotal: plan.publishableRowTotal,
      scopeTotalPublishable: plan.scopeTotalPublishable,
    });

    const { kpis } = await getPanoramaKpis({ role: "govt" }, own, period);
    const kpi = kpis.find((k) => k.id === "esterilizacion")!;

    expect(kpi.value).toBe("33,3%");
    expect(kpi.bar).toBe(33.3);
    expect(kpi.tone).toBe("warn");
    expect(kpi.sub).toBe("meta 70%");
    expect(kpi.sub).not.toContain("privacidad");
  });

  it("PPP KPI reflects the C7 registry-adoption rate (estado actual, benchmark 80%)", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "ppp")!;
    // 30% adoption over 20 flagged pets → warn (below the 80% benchmark).
    expect(kpi.value).toBe("30,0%");
    expect(kpi.bar).toBe(30);
    expect(kpi.currentState).toBe(true);
    expect(kpi.sub).toContain("6 de 20");
    // 30% is far below the 80% benchmark → toneForTarget returns danger.
    expect(kpi.tone).toBe("danger");
  });

  it("PPP KPI reads 'sin PPP' (blank value, neutral) when no PPP pets are in scope", async () => {
    vi.mocked(fetchDangerousBreedCompliance).mockResolvedValue({
      ratePct: 0,
      attested: 0,
      flaggedCount: 0,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "ppp")!;
    // A 0% rate over an empty denominator must NOT read as bad adoption.
    expect(kpi.value).toBe("—");
    expect(kpi.sub).toContain("sin PPP");
    expect(kpi.bar).toBeUndefined();
    expect(kpi.tone).toBe("neutral");
  });

  it("mortality KPI equals the SUM of the province choropleth cells (== Σ map cells)", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const kpi = kpis.find((k) => k.id === "mortalidad")!;
    // 8 (Buenos Aires) + 6 (CABA) = 14 deceased pets — the same total the map paints.
    expect(kpi.value).toBe("14");
    expect(kpi.currentState).toBe(true);
    expect(kpi.tone).toBe("warn");
    expect(kpi.source).toBe("repository.loadMortalityByProvince");
  });

  it("SKIPS a k-anon-suppressed province instead of counting it as 0 (#40)", async () => {
    // The null-guard must not become `?? 0` semantics that silently ADD a zero
    // for a protected cell — the headline stays Σ of what the map PAINTS, which
    // is also what keeps it safe: a total that included the hidden cells would
    // let a reader recover them by subtracting the visible ones.
    vi.mocked(loadMortalityByProvince).mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 8, suppressed: false },
        { provinceCode: "AR-Z", label: "Santa Cruz", value: null, suppressed: true },
      ],
      truncated: false,
      suppressedCount: 1,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    expect(kpis.find((k) => k.id === "mortalidad")?.value).toBe("8");
  });

  it("threads the SAME (actor, jurisdictions, period) to the dashboard fetchers (no scope widening)", async () => {
    const jur = [{ province: "Salta", locality: "Salta" }];
    await getPanoramaKpis({ role: "govt" }, jur, period);

    // ctx-based fetchers receive a ProjectionContext built from the exact tuple.
    const ctxArg = vi.mocked(fetchRabiesCoverage).mock.calls[0][0];
    expect(ctxArg.actor).toEqual({ role: "govt" });
    expect(ctxArg.scope).toEqual({ kind: "jurisdictions", jurisdictions: jur });
    expect(ctxArg.period).toBe(period);

    // (actor, jurisdictions, opts) fetchers get the same actor + jurisdictions,
    // with the period's `since` threaded so they are period-aware.
    expect(fetchAnalyticsMetrics).toHaveBeenCalledWith({ role: "govt" }, jur, {
      since: period.since,
    });
    expect(fetchPerdidasMetrics).toHaveBeenCalledWith({ role: "govt" }, jur, {
      adminProvince: undefined,
      adminLocality: undefined,
    });
  });

  it("describes the recalculation alcance for admin vs scoped govt", async () => {
    const admin = await getPanoramaKpis({ role: "admin" }, [], period);
    expect(admin.recalculatedFor).toContain("nacional");

    const govt = await getPanoramaKpis(
      { role: "govt" },
      [{ province: "Córdoba", locality: "Córdoba" }],
      period,
    );
    expect(govt.recalculatedFor).toContain("Córdoba");
  });

  it("names the LOCALITY, not just the province, for a single-locality-scoped govt operator (QA 2026-07-11 §3)", async () => {
    // A Palermo-scoped (CABA) govt operator previously saw "Recalculado para
    // CABA" — the copy named the province and silently dropped the narrower
    // locality scope, reading as if the whole province had been recalculated.
    const govt = await getPanoramaKpis(
      { role: "govt" },
      [{ province: "CABA", locality: "Palermo" }],
      period,
    );
    expect(govt.recalculatedFor).toContain("Palermo");
    expect(govt.recalculatedFor).toContain("CABA");
  });

  it("does NOT claim national reach for a govt operator with an empty scope (QA #81)", async () => {
    // A govt actor whose scope narrowed to [] (e.g. a province selected OUTSIDE
    // their assignment) must not read "alcance nacional" — that's admin-only.
    const govtEmpty = await getPanoramaKpis({ role: "govt" }, [], period);
    expect(govtEmpty.recalculatedFor).toContain("Sin datos en tu alcance");
    expect(govtEmpty.recalculatedFor.toLowerCase()).not.toContain("nacional");
  });

  it("uses a neutral tone when there is nothing to flag (zero counts)", async () => {
    vi.mocked(fetchActiveZoonosis).mockResolvedValue({
      count: 0,
      rabies: 0,
      lepto: 0,
      hidat: 0,
      deltaWeek: 0,
    });
    vi.mocked(loadZoonosisSignalScopeTotal).mockResolvedValue(0);
    vi.mocked(fetchOpenWelfareReportsCount).mockResolvedValue({ count: 0, inPeriod: 0 });
    vi.mocked(fetchPerdidasMetrics).mockResolvedValue({
      activeCount: 0,
      recoveredMonth: 0,
      avgDaysActive: 0,
    });

    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));
    expect(byId.zoonosis.tone).toBe("neutral");
    expect(byId.denuncias.tone).toBe("neutral");
    expect(byId.perdidas.tone).toBe("neutral");
  });

  // ---------------------------------------------------------------------------
  // map-QOL: period-over-period deltas + freshness
  // ---------------------------------------------------------------------------

  it("attaches deltas ONLY to window-sensitive KPIs, computed against the prior window", async () => {
    // Current run first, prior run second (Promise.all evaluates in order).
    vi.mocked(fetchRabiesCoverage)
      .mockResolvedValueOnce({
        current: 72,
        target: 80,
        partidos: 3,
        hasData: true,
        registryDenominator: 12_480,
        censusDenominator: 474_333,
        censusCoveragePct: 2.6,
        signedCount: 0,
        signedPct: 0,
      })
      .mockResolvedValueOnce({
        current: 60,
        target: 80,
        partidos: 3,
        hasData: true,
        registryDenominator: 11_000,
        censusDenominator: 474_333,
        censusCoveragePct: 2.3,
        signedCount: 0,
        signedPct: 0,
      });
    vi.mocked(fetchBitesPer10k)
      .mockResolvedValueOnce({ rate: 3.5, delta: 0, reports: 18, percapitaEligible: true })
      .mockResolvedValueOnce({ rate: 7, delta: 0, reports: 30, percapitaEligible: true });

    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));

    // cobertura: 72 vs 60 → +12 POINTS (H9: a percentage KPI reports its delta in
    // pts, not a relative % of a % — the "+76%" the cowork QA flagged).
    expect(byId.cobertura.delta).toEqual({
      pct: 12,
      unit: "pts",
      direction: "up",
      label: "+12 pts vs período anterior",
    });
    // mordeduras: 3.5 vs 7 → -50% (per-10k rate keeps relative %, not points).
    expect(byId.mordeduras.delta?.pct).toBe(-50);
    expect(byId.mordeduras.delta?.unit).toBe("pct");
    expect(byId.mordeduras.delta?.direction).toBe("down");
    // zoonosis: same mock both runs → 0%, flat (still meaningful: window metric).
    expect(byId.zoonosis.delta?.direction).toBe("flat");

    // State metrics NEVER carry a delta (no misleading 0% on stocks/queues).
    expect(byId.perdidas.delta).toBeUndefined();
    expect(byId.denuncias.delta).toBeUndefined();
    expect(byId.esterilizacion.delta).toBeUndefined();
  });

  it("omits the delta when the prior value is 0 (no meaningful % base)", async () => {
    // Zoonosis delta now compares the signal totals (current then prior window).
    vi.mocked(loadZoonosisSignalScopeTotal).mockResolvedValueOnce(9).mockResolvedValueOnce(0);

    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    expect(kpis.find((k) => k.id === "zoonosis")?.delta).toBeUndefined();
  });

  it("runs the prior window IMMEDIATELY before the active one, same length and scope", async () => {
    await getPanoramaKpis({ role: "admin" }, [], period);

    // Three calls: current ctx, prior-window ctx, and the verifiedOnly ctx for the
    // "firmado por matrícula" sub (task #78 Part 3). Prior is call index 1.
    expect(fetchRabiesCoverage).toHaveBeenCalledTimes(3);
    const priorCtx = vi.mocked(fetchRabiesCoverage).mock.calls[1][0];
    // The prior window ends exactly where the active one starts…
    expect(priorCtx.period.until).toEqual(period.since);
    // …and spans the same length (365d here → prior-12m via windows.trailing24m).
    const priorLen = priorCtx.period.until.getTime() - priorCtx.period.since.getTime();
    const currentLen = period.until.getTime() - period.since.getTime();
    expect(Math.round(priorLen / 86_400_000)).toBe(Math.round(currentLen / 86_400_000));
    // Scope is identical (no widening in the comparison run).
    expect(priorCtx.scope).toEqual(vi.mocked(fetchRabiesCoverage).mock.calls[0][0].scope);
  });

  // ---------------------------------------------------------------------------
  // Coherence hybrid (cowork QA H1/H6): the temporal KPIs track the as-of scrub;
  // the stock KPIs stay current-state; denuncias splits in-period vs backlog.
  // ---------------------------------------------------------------------------

  it("recomputes TEMPORAL KPIs as-of the scrub cutoff, but STOCK KPIs stay live (H1)", async () => {
    const asOf = new Date("2026-05-01T00:00:00.000Z"); // inside [since, until]
    await getPanoramaKpis({ role: "admin" }, [], period, undefined, undefined, asOf);

    // Temporal fetchers see a ctx whose window ENDS at the as-of cutoff — so their
    // numbers move with the scrubber exactly like the map layers do.
    expect(vi.mocked(fetchBitesPer10k).mock.calls[0][0].period.until).toEqual(asOf);
    expect(vi.mocked(fetchActiveZoonosis).mock.calls[0][0].period.until).toEqual(asOf);
    expect(vi.mocked(fetchOpenWelfareReportsCount).mock.calls[0][0].period.until).toEqual(asOf);
    // Zoonosis PRIMARY (== map): the signal total is fetched with the as-of cutoff
    // as its upper bound (arg 3), the SAME window loadZoonosisByUnit draws the layer.
    expect(vi.mocked(loadZoonosisSignalScopeTotal).mock.calls[0][3]).toEqual(asOf);

    // Current-state fetchers keep the LIVE window (until = period.until) — a
    // coverage snapshot cannot vary with a corte; it is labeled "estado actual".
    expect(vi.mocked(fetchRabiesCoverage).mock.calls[0][0].period.until).toEqual(period.until);
    expect(vi.mocked(fetchSterilizationCoverage).mock.calls[0][0].period.until).toEqual(
      period.until,
    );
  });

  it("collapses to the live ctx when asOf is null — no behavior change on the live view", async () => {
    await getPanoramaKpis({ role: "admin" }, [], period, undefined, undefined, null);
    // The temporal fetchers see the plain live window (until = period.until).
    expect(vi.mocked(fetchBitesPer10k).mock.calls[0][0].period.until).toEqual(period.until);
    expect(vi.mocked(fetchActiveZoonosis).mock.calls[0][0].period.until).toEqual(period.until);
  });

  it("marks the stock KPIs as currentState and leaves the temporal ones unmarked", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));
    // Stock/point-in-time metrics.
    for (const id of ["cobertura", "esterilizacion", "microchip", "perdidas"]) {
      expect(byId[id].currentState).toBe(true);
    }
    // Period/as-of-sensitive metrics — reunificacion is computed over the period's
    // lost episodes, so it must NOT wear the tag (cowork round 2 fix).
    for (const id of ["mordeduras", "zoonosis", "denuncias", "reunificacion"]) {
      expect(byId[id].currentState).toBeFalsy();
    }
  });

  it("splits denuncias into an in-period PRIMARY and a labeled backlog SECONDARY (H6)", async () => {
    vi.mocked(fetchOpenWelfareReportsCount).mockResolvedValue({ count: 2202, inPeriod: 195 });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const denuncias = kpis.find((k) => k.id === "denuncias")!;
    // PRIMARY = the in-period count (matches the map + Registros), NOT the backlog.
    expect(denuncias.value).toBe("195");
    // SECONDARY carries the all-time backlog, clearly labeled ("acumulado" — the
    // es-AR term replaced the English "backlog", red-team-admin-2 P1.8b).
    // T2.2: the backlog arm has no date bound (architecturally "now"), so the
    // label must name its base — "acumulado hoy" — or a scrubbed PRIMARY makes
    // the frozen stock read as part of the historical frame.
    expect(denuncias.secondary).toContain("acumulado hoy:");
    expect(denuncias.secondary).toContain("2.202");
  });

  it("bounds the cobertura pts delta with a near-zero prior — no relative-% explosion (cowork round 2)", async () => {
    // At a long window the prior coverage can be ~0; a RELATIVE % blows up
    // (+44900%). Points (H9) is bounded to the 0–100 coverage scale.
    vi.mocked(fetchRabiesCoverage)
      .mockResolvedValueOnce({
        current: 45,
        target: 80,
        partidos: 3,
        hasData: true,
        registryDenominator: 12_480,
        censusDenominator: 474_333,
        censusCoveragePct: 2.6,
        signedCount: 0,
        signedPct: 0,
      })
      .mockResolvedValueOnce({
        current: 0.1,
        target: 80,
        partidos: 3,
        hasData: true,
        registryDenominator: 30,
        censusDenominator: 474_333,
        censusCoveragePct: 0.01,
        signedCount: 0,
        signedPct: 0,
      })
      .mockResolvedValueOnce({
        current: 30,
        target: 80,
        partidos: 3,
        hasData: true,
        registryDenominator: 9_000,
        censusDenominator: 474_333,
        censusCoveragePct: 1.9,
        signedCount: 0,
        signedPct: 0,
      });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const cobertura = kpis.find((k) => k.id === "cobertura")!;
    expect(cobertura.delta?.unit).toBe("pts");
    expect(cobertura.delta?.pct).toBe(45); // round(45 − 0.1), NOT +44900%
    expect(Math.abs(cobertura.delta!.pct)).toBeLessThanOrEqual(100);
  });

  it("blanks the strip to — for a non-admin operator fenced to zero jurisdictions (cowork round 2)", async () => {
    // narrowGovtScope emptied the scope (fenced out): the fetchers return 0, but
    // "0%" reads as a real measured zero. Show "—" to match the map/dock.
    const { kpis, recalculatedFor } = await getPanoramaKpis({ role: "govt" }, [], period);
    expect(kpis.length).toBeGreaterThan(0);
    expect(kpis.every((k) => k.value === "—")).toBe(true);
    expect(kpis.every((k) => k.delta === undefined && k.bar === undefined)).toBe(true);
    expect(recalculatedFor).toContain("Sin datos en tu alcance");
  });

  // ---------------------------------------------------------------------------
  // task #78 Part 3 — the ministry "both numbers": total coverage as the headline,
  // firmado-por-matrícula share in the sub, via a SECOND verifiedOnly ctx.
  // ---------------------------------------------------------------------------

  it("computes a signed-only (verifiedOnly) coverage and surfaces it in the cobertura sub", async () => {
    vi.mocked(fetchRabiesCoverage)
      .mockResolvedValueOnce({
        current: 41.3,
        target: 80,
        partidos: 12,
        hasData: true,
        registryDenominator: 12_480,
        censusDenominator: 474_333,
        censusCoveragePct: 2.6,
        signedCount: 0,
        signedPct: 0,
      }) // total ctx
      .mockResolvedValueOnce({
        current: 39,
        target: 80,
        partidos: 12,
        hasData: true,
        registryDenominator: 11_800,
        censusDenominator: 474_333,
        censusCoveragePct: 2.5,
        signedCount: 0,
        signedPct: 0,
      }) // prior ctx
      .mockResolvedValueOnce({
        current: 28.9,
        target: 80,
        partidos: 12,
        hasData: true,
        registryDenominator: 12_480,
        censusDenominator: 474_333,
        censusCoveragePct: 2.6,
        signedCount: 0,
        signedPct: 0,
      }); // verified ctx

    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const cobertura = kpis.find((k) => k.id === "cobertura")!;

    // The headline value/bar stay TOTAL coverage.
    expect(cobertura.value).toBe("41,3%");
    expect(cobertura.bar).toBe(41.3);
    // The firmado-por-matrícula share rides in the sub alongside the meta.
    expect(cobertura.sub).toContain("28,9% firmado por matrícula");
    expect(cobertura.sub).toContain("meta 80%");

    // A THIRD fetch runs with a verifiedOnly ctx — numerator-only, never widening scope.
    expect(fetchRabiesCoverage).toHaveBeenCalledTimes(3);
    const verifiedCtx = vi.mocked(fetchRabiesCoverage).mock.calls[2][0];
    expect(verifiedCtx.verifiedOnly).toBe(true);
    expect(verifiedCtx.scope).toEqual(vi.mocked(fetchRabiesCoverage).mock.calls[0][0].scope);
  });

  // ---------------------------------------------------------------------------
  // task #79 — honest double denominators: the cobertura tile names BOTH the
  // registry count `current` is a % of AND how much of the estimated canine
  // population the padrón covers.
  // ---------------------------------------------------------------------------

  it("names both denominators in the cobertura sub: registry count + census coverage %", async () => {
    // seedDefaults: registryDenominator 12.480, censusCoveragePct 2,6.
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const cobertura = kpis.find((k) => k.id === "cobertura")!;

    // First denominator: the registry count `current` is computed against.
    expect(cobertura.sub).toContain("12.480 perros en el padrón");
    // Second denominator: registry coverage of the estimated canine population.
    expect(cobertura.sub).toContain("el padrón cubre 2,6% de la población canina estimada");
    // Both signature share and meta still present.
    expect(cobertura.sub).toContain("firmado por matrícula");
    expect(cobertura.sub).toContain("meta 80%");
  });

  it("degrades to 'sin estimación censal' when the scope has no census row", async () => {
    vi.mocked(fetchRabiesCoverage).mockResolvedValue({
      current: 41.3,
      target: 80,
      partidos: 12,
      hasData: true,
      registryDenominator: 12_480,
      censusDenominator: null,
      censusCoveragePct: null,
      signedCount: 0,
      signedPct: 0,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const cobertura = kpis.find((k) => k.id === "cobertura")!;

    // Registry denominator still named; census half honestly says it's missing.
    expect(cobertura.sub).toContain("12.480 perros en el padrón");
    expect(cobertura.sub).toContain("sin estimación censal");
    expect(cobertura.sub).not.toContain("población canina estimada");
  });

  it("surfaces the freshness timestamp as an ISO string (null-safe)", async () => {
    const result = await getPanoramaKpis({ role: "admin" }, [], period);
    expect(result.dataAsOf).toBe("2026-06-19T18:30:00.000Z");

    vi.mocked(lastIngestAt).mockResolvedValue(null);
    const empty = await getPanoramaKpis({ role: "admin" }, [], period);
    expect(empty.dataAsOf).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // v+1 rail — KPI sparklines (item 1): cobertura/mordeduras/zoonosis carry an
  // inline sparkline series sourced from the SAME trend fetchers /gob home uses.
  // ---------------------------------------------------------------------------

  it("attaches a sparkline to cobertura, mordeduras and zoonosis (window-sensitive KPIs)", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));

    // THE WHOLE POINT TRAVELS, not just its `y`. These three assertions used to
    // read `toEqual([10, 14])` and so on, and that shape was not merely an
    // implementation detail being over-pinned: it was pinning the defect. The
    // DTO built its series with `trend.points.map((p) => p.y)`, a projection
    // that structurally cannot carry the `suppressed` flag `suppressSmallBuckets`
    // puts on a k-anon-masked bucket, so a masked bucket (transported as `y: 0`)
    // reached the tile as an indistinguishable zero and drew a dip to the floor
    // (metric-honesty audit, PO 2026-09-16). See the masked case below.
    expect(byId.cobertura.sparkline).toEqual([
      { x: "ene", y: 10 },
      { x: "feb", y: 14 },
    ]);
    expect(byId.mordeduras.sparkline).toEqual([
      { x: "ene", y: 3 },
      { x: "feb", y: 5 },
    ]);
    expect(byId.zoonosis.sparkline).toEqual([
      { x: "ene", y: 1 },
      { x: "feb", y: 2 },
    ]);
    // Non-window-sensitive KPIs never get a sparkline (no matching trend).
    expect(byId.esterilizacion.sparkline).toBeUndefined();
    expect(byId.perdidas.sparkline).toBeUndefined();
    expect(byId.denuncias.sparkline).toBeUndefined();

    // Parity: the trend fetchers receive the SAME ctx as the headline value —
    // the sparkline spans the active period, not a hardcoded 12m window.
    expect(fetchRabiesVaccinationTrend).toHaveBeenCalledTimes(1);
    expect(fetchBitesTrend).toHaveBeenCalledTimes(1);
    expect(fetchKpiTrend).toHaveBeenCalledWith("rabies_observation_started", expect.anything());
  });

  it("carries a k-anon-masked bucket's flag into the sparkline instead of a bare 0", () => {
    // SUPPRESSED != ZERO. A bucket with 1..k-1 observations is masked to y: 0
    // and flagged; the tile needs the flag to draw a gap and to disclose "N
    // períodos ocultos (privacidad)". Without it the tile can only draw the 0,
    // which on a 32px sparkline with no axes and no tooltip reads exactly like a
    // period in which nothing happened.
    vi.mocked(fetchBitesTrend).mockResolvedValue({
      granularity: "month",
      points: [
        { x: "ene", y: 9 },
        { x: "feb", y: 0, suppressed: true },
        { x: "mar", y: 11 },
      ],
      suppressedCount: 1,
    });

    return getPanoramaKpis({ role: "admin" }, [], period).then(({ kpis }) => {
      const mordeduras = kpis.find((k) => k.id === "mordeduras");
      expect(mordeduras?.sparkline).toEqual([
        { x: "ene", y: 9 },
        { x: "feb", y: 0, suppressed: true },
        { x: "mar", y: 11 },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // v+1 rail — meta-progress meters (item 2): reunificacion (D4) + microchip (C1)
  // render a `bar` + `tone` computed via toneForTarget against TARGETS, reusing
  // the SAME fetchers /gob/perdidas + /gob/programa already call.
  // ---------------------------------------------------------------------------

  it("reunificacion KPI carries a target-progress bar + tone vs TARGETS.REUNIFICATION_PCT", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const reunificacion = kpis.find((k) => k.id === "reunificacion")!;

    expect(reunificacion.value).toBe("45,2%");
    expect(reunificacion.bar).toBe(45.2);
    expect(reunificacion.tone).toBe("ok"); // 45.2 >= TARGETS.REUNIFICATION_PCT (39)
    expect(reunificacion.sub).toBe("meta 39% · 19 de 42 episodios");
    expect(reunificacion.href).toBe("/gob/perdidas");
    expect(fetchReunificationRate).toHaveBeenCalledTimes(1);
  });

  it("microchip KPI carries a target-progress bar + tone vs TARGETS.MICROCHIP_PENETRATION_PCT", async () => {
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const microchip = kpis.find((k) => k.id === "microchip")!;

    expect(microchip.value).toBe("55,1%");
    expect(microchip.bar).toBe(55.1);
    expect(microchip.tone).toBe("warn"); // 55.1 < 80, but >= 80*0.5
    expect(microchip.sub).toBe("meta 80%");
    expect(microchip.href).toBe("/gob/censo");
    expect(fetchMicrochipPenetration).toHaveBeenCalledTimes(1);
  });

  it("reunificacion tone degrades to warn/danger below target, matching toneForTarget", async () => {
    vi.mocked(fetchReunificationRate).mockResolvedValue({
      ratePct: 5,
      recovered: 1,
      lostEpisodes: 20,
      medianDaysToRecovery: 10,
    });
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const reunificacion = kpis.find((k) => k.id === "reunificacion")!;
    expect(reunificacion.tone).toBe("danger"); // 5 < 39*0.5
  });

  // ---------------------------------------------------------------------------
  // NEVER-CRASH FAN-OUT (task #74) + PER-TILE DEGRADATION (2026-07): a failing
  // fetcher must degrade ONLY its own tile (honest "no disponible") while the
  // siblings render — WITHOUT abandoning any promise (the prod unhandledRejection).
  // The whole strip only collapses to the empty degraded state when ALL fail.
  // ---------------------------------------------------------------------------

  it("degrades ONLY the affected tile when a fetcher rejects (per-tile, not all-or-nothing)", async () => {
    vi.mocked(fetchBitesPer10k).mockRejectedValue(new Error("pooler timeout"));
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));
    // The mordeduras tile (primary = fetchBitesPer10k) is unavailable — "—", no numbers.
    expect(byId.mordeduras.unavailable).toBe(true);
    expect(byId.mordeduras.value).toBe("—");
    expect(byId.mordeduras.delta).toBeUndefined();
    expect(byId.mordeduras.sparkline).toBeUndefined();
    // …but it keeps its metadata so the operator sees WHICH metric failed.
    expect(byId.mordeduras.label).toBe("Mordeduras / 10k hab.");
    // Every OTHER tile still renders its real numbers (parity intact).
    expect(byId.cobertura.unavailable).toBeFalsy();
    expect(byId.cobertura.value).toBe("72,4%");
    expect(byId.esterilizacion.unavailable).toBeFalsy();
  });

  it("drops only the enrichment (delta/sparkline) when a prior/trend fetcher rejects — tile survives", async () => {
    // The bites PRIOR-window run [8] and trend [14] are enrichments; the current
    // window [3] still resolves. The mordeduras tile renders its value but sheds
    // the delta / sparkline rather than degrading.
    vi.mocked(fetchBitesTrend).mockRejectedValue(new Error("trend timeout"));
    const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
    const mordeduras = kpis.find((k) => k.id === "mordeduras");
    expect(mordeduras?.unavailable).toBeFalsy();
    expect(mordeduras?.value).not.toBe("—");
    expect(mordeduras?.sparkline).toBeUndefined();
  });

  it("throws PanoramaKpisUnavailableError only when EVERY tile's primary rejects", async () => {
    // Reject every PRIMARY tile fetcher → no tile can be built → the strip
    // collapses to the empty degraded state (throw → caller degrades).
    const boom = () => Promise.reject(new Error("all down"));
    vi.mocked(fetchRabiesCoverage).mockImplementation(boom);
    vi.mocked(fetchSterilizationCoverage).mockImplementation(boom);
    vi.mocked(fetchMicrochipPenetration).mockImplementation(boom);
    vi.mocked(fetchDangerousBreedCompliance).mockImplementation(boom);
    vi.mocked(fetchPerdidasMetrics).mockImplementation(boom);
    vi.mocked(fetchReunificationRate).mockImplementation(boom);
    vi.mocked(fetchBitesPer10k).mockImplementation(boom);
    vi.mocked(loadZoonosisSignalScopeTotal).mockImplementation(boom);
    vi.mocked(fetchOpenWelfareReportsCount).mockImplementation(boom);
    vi.mocked(loadMortalityByProvince).mockImplementation(boom);
    await expect(getPanoramaKpis({ role: "admin" }, [], period)).rejects.toBeInstanceOf(
      PanoramaKpisUnavailableError,
    );
  });

  it("awaits EVERY fetcher (allSettled) even when one rejects — no abandoned/dangling promise", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // One fetcher rejects immediately; a sibling rejects a tick LATER. With
      // Promise.all the late sibling would be abandoned → unhandledRejection.
      // With allSettled both are awaited before we build, so nothing dangles —
      // even though the strip now degrades per-tile instead of throwing.
      vi.mocked(fetchRabiesCoverage).mockRejectedValue(new Error("first"));
      vi.mocked(fetchActiveZoonosis).mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("late sibling")), 20)),
      );

      const { kpis } = await getPanoramaKpis({ role: "admin" }, [], period);
      // cobertura degraded (its primary rejected); the strip is partial, not empty.
      expect(kpis.find((k) => k.id === "cobertura")?.unavailable).toBe(true);
      expect(kpis.some((k) => !k.unavailable)).toBe(true);

      // Give the late sibling time to reject and flush microtasks.
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("degradedPanoramaKpis is an empty, honest strip", () => {
    const degraded = degradedPanoramaKpis();
    expect(degraded.kpis).toEqual([]);
    expect(degraded.dataAsOf).toBeNull();
    expect(degraded.coverageDenominator).toBeNull();
    expect(degraded.recalculatedFor.toLowerCase()).toContain("reintent");
  });
});
