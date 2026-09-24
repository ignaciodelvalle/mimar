// @vitest-environment jsdom
//
// PoblacionScreen — ranked "provincias bajo la meta" table + cross-link to
// Operativos/Alcance (IA audit 2026-08).
//
// The audit's worst cognitive-load gap: the sterilization-campaign decision
// spanned Padrón/Población ↔ Operativos/Alcance with ZERO cross-link, and
// "which province is below target" degraded to reading the choropleth. This
// pins the fix's contract:
//   - the table ranks below-target provinces WORST-FIRST (largest gap on top)
//   - suppressed provinces are EXCLUDED (never fabricated) and announced via
//     the canonical provinceSuppressionNotice wording
//   - the cross-link targets /gob/operativos?vista=alcance (AlcanceScreen has
//     no province-scoping param — its ?zona=/?provincia= pair is the
//     overdue-rabies locality drill-down, so the link is deliberately plain)
//   - the screen feeds the table from the SAME fetchSterilizationCoverage
//     call that feeds the choropleth — one fetch, no second query
//
// Mock scaffolding mirrors app/admin/poblacion/AdminPoblacionScreen.test.tsx.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/gob/padron",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: vi.fn(async () => ({
    user: { id: "admin-1" },
    profile: { id: "admin-1", role: "admin" },
    jurisdictions: [],
  })),
}));

vi.mock("@/lib/analytics/jurisdiction-scope", () => ({
  resolveJurisdictionScope: vi.fn(async () => ({
    filteredJurisdictions: [],
    localities: [],
    allowedProvinces: [],
    adminSelectedProvince: null,
    adminSelectedLocality: null,
  })),
}));

// Async server component (own freshness fetch) — renderToStaticMarkup cannot
// resolve it synchronously. Same stub as the admin twin's test.
vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

// Client map/chart embeds — irrelevant to the ranking contract under test.
vi.mock("@/components/panorama/PanoramaEmbed", () => ({
  PanoramaEmbed: () => null,
}));
vi.mock("@/components/charts/TimeSeriesChartDynamic", () => ({
  TimeSeriesChartDynamic: () => null,
}));

// vi.mock factories are hoisted above top-level consts — shared fixtures and
// fetcher mocks must come from vi.hoisted.
const fixtures = vi.hoisted(() => {
  /** 70% target fixture: two below (Córdoba worst), one above, one withheld. */
  const BY_PROVINCE = [
    { province: "Buenos Aires", suppressed: false, ratePct: 72.5, sterilized: 725, total: 1000 },
    { province: "Santa Fe", suppressed: false, ratePct: 55.9, sterilized: 559, total: 1000 },
    { province: "Córdoba", suppressed: false, ratePct: 41.2, sterilized: 412, total: 1000 },
    { province: "Chaco", suppressed: true, ratePct: null, sterilized: null, total: null },
  ];
  return {
    BY_PROVINCE,
    fetchSterilizationCoverage: vi.fn(async (_ctx: unknown, _opts?: { species?: string }) => ({
      rate: 56.5,
      sterilized: 1696,
      total: 3000,
      byProvince: BY_PROVINCE,
      byProvinceSuppressedCount: 1,
      byProvinceAssignedTotal: null,
      scopeTotalPublishable: true,
    })),
    fetchActivePregnancies: vi.fn(async () => 0),
    fetchReproductiveOutcomes: vi.fn(async () => ({
      byClinicalOutcome: { live_birth: 1, stillbirth: 0, miscarriage: 0, unknown: 0 },
      registeredBirths: 1,
    })),
    fetchNetGrowth: vi.fn(async () => ({ altas: 3, registeredBirths: 1, deaths: 1, net: 3 })),
    fetchSterilizationNatalidadRatio: vi.fn(async () => 1.5),
    fetchSterilizationTrend: vi.fn(async () => ({
      granularity: "month" as const,
      points: [],
      suppressedCount: 0,
    })),
    fetchPrevRegisteredBirths: vi.fn(async () => 0),
  };
});

vi.mock("@/lib/metrics/population-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics/population-control")>();
  const { BY_PROVINCE: _ignored, ...mocks } = fixtures;
  return { ...actual, ...mocks };
});

vi.mock("@/lib/metrics/deworming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics/deworming")>();
  return {
    ...actual,
    fetchDewormingCoverage: vi.fn(async () => ({ rate: 50, dewormed: 5, total: 10 })),
  };
});

import type { ProvinceSterlizationRow } from "@/lib/metrics";
import { PoblacionScreen, SterilizationGapCard, rankProvincesBelowTarget } from "./PoblacionScreen";

const BY_PROVINCE = fixtures.BY_PROVINCE as ProvinceSterlizationRow[];

describe("rankProvincesBelowTarget — worst-first ranking rule", () => {
  it("ranks below-target provinces largest gap first, with 1-decimal gaps", () => {
    const rows = rankProvincesBelowTarget(BY_PROVINCE);
    expect(rows).toEqual([
      { province: "Córdoba", ratePct: 41.2, gapPp: 28.8 },
      { province: "Santa Fe", ratePct: 55.9, gapPp: 14.1 },
    ]);
  });

  it("excludes provinces at or above the target (70% itself is NOT below)", () => {
    const rows = rankProvincesBelowTarget([
      { province: "Mendoza", suppressed: false, ratePct: 70, sterilized: 70, total: 100 },
      { province: "Salta", suppressed: false, ratePct: 69.9, sterilized: 699, total: 1000 },
    ]);
    expect(rows.map((r) => r.province)).toEqual(["Salta"]);
  });

  it("excludes suppressed provinces entirely — no fabricated row", () => {
    const rows = rankProvincesBelowTarget(BY_PROVINCE);
    expect(rows.some((r) => r.province === "Chaco")).toBe(false);
  });

  it("breaks gap ties alphabetically for a stable order", () => {
    const rows = rankProvincesBelowTarget([
      { province: "Salta", suppressed: false, ratePct: 40, sterilized: 40, total: 100 },
      { province: "Chubut", suppressed: false, ratePct: 40, sterilized: 40, total: 100 },
    ]);
    expect(rows.map((r) => r.province)).toEqual(["Chubut", "Salta"]);
  });
});

describe("SterilizationGapCard — render contract", () => {
  it("renders only below-target provinces, worst-first", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard byProvince={BY_PROVINCE} suppressedCount={1} />,
    );
    const cordoba = html.indexOf("Córdoba");
    const santaFe = html.indexOf("Santa Fe");
    expect(cordoba).toBeGreaterThan(-1);
    expect(santaFe).toBeGreaterThan(-1);
    expect(cordoba).toBeLessThan(santaFe);
    // Above-target and suppressed provinces never appear as rows.
    expect(html).not.toContain("Buenos Aires");
    expect(html).not.toContain("Chaco");
  });

  it("formats coverage and gap in es-AR (comma decimals, pp unit)", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard byProvince={BY_PROVINCE} suppressedCount={0} />,
    );
    expect(html).toContain("41,2%");
    expect(html).toContain("28,8");
    expect(html).toContain("pp");
  });

  it("cross-links to the Operativos hub's Alcance vista", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard byProvince={BY_PROVINCE} suppressedCount={0} />,
    );
    expect(html).toContain('href="/gob/operativos?vista=alcance"');
  });

  it("announces withheld provinces with the canonical suppression wording", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard byProvince={BY_PROVINCE} suppressedCount={1} />,
    );
    expect(html).toContain("1 provincia oculta por privacidad");
  });

  it("omits the suppression note when nothing was withheld", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard byProvince={BY_PROVINCE} suppressedCount={0} />,
    );
    expect(html).not.toContain("oculta por privacidad");
  });

  it("states honestly when every publishable province meets the target", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard
        byProvince={[
          { province: "Buenos Aires", suppressed: false, ratePct: 80, sterilized: 8, total: 10 },
        ]}
        suppressedCount={0}
      />,
    );
    expect(html).toContain("Ninguna provincia publicable está por debajo de la meta del 70%.");
    expect(html).not.toContain("<table");
  });

  it("caption declares the 70% target, worst-first order, and province grain", () => {
    const html = renderToStaticMarkup(
      <SterilizationGapCard byProvince={BY_PROVINCE} suppressedCount={0} />,
    );
    expect(html).toContain(
      "Provincias por debajo de la meta de esterilización (70%), mayor brecha primero.",
    );
    expect(html).toContain("Cobertura calculada a nivel provincia.");
  });
});

describe("PoblacionScreen — the table reuses the choropleth's coverage fetch", () => {
  it("renders the ranked table from the single fetchSterilizationCoverage call", async () => {
    fixtures.fetchSterilizationCoverage.mockClear();
    const node = await PoblacionScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);

    // One coverage fetch feeds KPI + choropleth + ranked table alike.
    expect(fixtures.fetchSterilizationCoverage).toHaveBeenCalledTimes(1);
    expect(html).toContain("Provincias por debajo de la meta de esterilización");
    expect(html).toContain("Córdoba");
    expect(html).toContain('href="/gob/operativos?vista=alcance"');
  });
});
