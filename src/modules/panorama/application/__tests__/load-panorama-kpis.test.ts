// Unit test for the shared cached KPI loader (staging QA 2026-07-08 finding #1).
//
// The loader is what BOTH the /api/panorama/kpis route AND the server page render
// now call, so a browser RELOAD collapses onto the warm 60s per-lambda cache
// instead of re-running the ~12-query fan-out under a tight budget (the "the
// indicators vanish on reload" symptom). This pins the two properties that make
// that hardening real:
//   1. a second load of the SAME scope is served from cache (the fan-out runs
//      ONCE) — a reload does not re-hammer the DB;
//   2. a budget-exhausted DEGRADED strip is NEVER cached — one bad load can't
//      freeze the honest error for the next window.
//
// The dashboard fetchers are mocked, so this runs with NO database.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
// v+1 rail — meta-progress meters + KPI sparklines (get-panorama-kpis.ts now
// fans out to these too; unmocked here would hit a live DB with no Postgres).
vi.mock("@/lib/analytics/compliance-metrics", () => ({
  fetchReunificationRate: vi.fn(),
  fetchMicrochipPenetration: vi.fn(),
  fetchDangerousBreedCompliance: vi.fn(),
}));
vi.mock("@/lib/metrics/trends", () => ({
  fetchRabiesVaccinationTrend: vi.fn(),
  fetchBitesTrend: vi.fn(),
  fetchKpiTrend: vi.fn(),
}));
// Coherence hybrid (round 2): the zoonosis PRIMARY signal total is a repository
// call — mock it so the loader's real getPanoramaKpis never touches the DB here.
vi.mock("@/src/modules/panorama/infrastructure/repository", () => ({
  loadZoonosisSignalScopeTotal: vi.fn().mockResolvedValue(7),
  loadMortalityByProvince: vi.fn().mockResolvedValue({ cells: [] }),
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
import { lastIngestAt } from "@/lib/metrics/freshness";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";
import { fetchBitesTrend, fetchKpiTrend, fetchRabiesVaccinationTrend } from "@/lib/metrics/trends";

import { __resetKpisCache } from "../kpis-cache";
import { loadCachedPanoramaKpis } from "../load-panorama-kpis";

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
  vi.mocked(fetchDangerousBreedCompliance).mockResolvedValue({
    ratePct: 40,
    attested: 8,
    flaggedCount: 20,
  });
  const emptyTrend = { granularity: "month" as const, points: [], suppressedCount: 0 };
  vi.mocked(fetchRabiesVaccinationTrend).mockResolvedValue(emptyTrend);
  vi.mocked(fetchBitesTrend).mockResolvedValue(emptyTrend);
  vi.mocked(fetchKpiTrend).mockResolvedValue(emptyTrend);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetKpisCache();
  seedDefaults();
});

describe("loadCachedPanoramaKpis", () => {
  it("serves a reload of the same scope from cache (the fan-out runs once)", async () => {
    const params = {
      actor: { role: "admin" as const },
      jurisdictions: [],
      period,
      label: "test",
    };

    const first = await loadCachedPanoramaKpis(params);
    expect(first.cacheHit).toBe(false);
    expect(first.value.kpis.length).toBeGreaterThan(0);
    // fetchRabiesCoverage runs 3x per fan-out (current + prior + verifiedOnly).
    const callsAfterFirst = vi.mocked(fetchRabiesCoverage).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Reload (same scope) — cache hit, NO additional fan-out.
    const second = await loadCachedPanoramaKpis(params);
    expect(second.cacheHit).toBe(true);
    expect(vi.mocked(fetchRabiesCoverage).mock.calls.length).toBe(callsAfterFirst);
  });

  it("a different scope does not read another scope's cache entry", async () => {
    await loadCachedPanoramaKpis({
      actor: { role: "govt" },
      jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
      period,
      label: "test",
    });
    const other = await loadCachedPanoramaKpis({
      actor: { role: "govt" },
      jurisdictions: [{ province: "Santa Fe", locality: "Rosario" }],
      period,
      label: "test",
    });
    expect(other.cacheHit).toBe(false);
  });

  it("a budget-exhausted degraded strip is NOT cached (the next load recomputes)", async () => {
    // A hanging fetcher makes the fan-out never settle → the budget elapses and
    // the loader returns the degraded (empty) strip.
    vi.mocked(fetchRabiesCoverage).mockReturnValue(new Promise(() => {}));
    const params = {
      actor: { role: "admin" as const },
      jurisdictions: [],
      period,
      budgetMs: 10,
      label: "test",
    };

    const degradedLoad = await loadCachedPanoramaKpis(params);
    expect(degradedLoad.cacheHit).toBe(false);
    expect(degradedLoad.value.kpis).toHaveLength(0); // honest empty strip

    // The DB recovered: a subsequent load must recompute (the degraded strip was
    // never cached), not serve the frozen error.
    seedDefaults();
    const recovered = await loadCachedPanoramaKpis({ ...params, budgetMs: 20_000 });
    expect(recovered.cacheHit).toBe(false);
    expect(recovered.value.kpis.length).toBeGreaterThan(0);
  });
});
