// @vitest-environment jsdom
//
// ProgramaResumenScreen — the C1 privacy shape, closed (RA-3 finding C1, third
// instance).
//
// Relocated from ./page.test.tsx by the F9 fusion (2026-08-01) together with
// the body it tests: /gob/programa's page.tsx is now a hub shell whose vistas
// are async server components, which renderToStaticMarkup cannot resolve
// through a parent. Same fixtures, same two assertions, one import moved — the
// hub's own chrome is covered by the new ./page.test.tsx.
//
// This page accepts `?province=`, and for an ADMIN that drill narrows the whole
// projection scope (`petsScopeClause`) instead of intersecting an assignment
// set. Once the scope holds a single foreign jurisdiction, every figure on the
// executive summary — "Total registradas", the esterilización rate and its
// "faltan ~N cirugías" forecast, microchip, SLA ENO, la cola, calidad de datos —
// stops being an aggregate and becomes that one province's cell wearing a
// national label. The page used to publish all of them.
//
// The two tests below are the pair that matters, and they pull in OPPOSITE
// directions on purpose:
//   1. the drilled admin gets NOTHING (the withheld headline), and
//   2. D.10 SURVIVES — a govt operator looking at their OWN sub-k province keeps
//      the real number. Suppression exists to stop inference about OTHER
//      jurisdictions; your own administrados are already in your padrón.
// A fix that only satisfies (1) is a regression, not a fix.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

// Async Server Component (fetches its own freshness timestamp) —
// renderToStaticMarkup cannot resolve one synchronously. Same stub the other
// dashboard page tests use.
vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

// vi.mock factories are hoisted above top-level consts, so every mock the
// factories close over has to come from vi.hoisted.
const mocks = vi.hoisted(() => {
  const coverage = {
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
    byProvinceSuppressedCount: 1,
    byProvinceAssignedTotal: null,
    // THE FIELD UNDER TEST. Overridden per-test; the page must never re-derive
    // it (pinned separately by the comment-stripped parity suite in
    // lib/metrics/province-disclosure.test.ts).
    scopeTotalPublishable: false,
  };
  return {
    coverage,
    role: { value: "admin" as "admin" | "govt" },
    jurisdictions: { value: [] as { province: string; locality: string }[] },
    adminProvince: { value: "Tierra del Fuego" as string | null },
    requireGobReadAccessOrRedirect: vi.fn(),
    resolveJurisdictionScope: vi.fn(),
    registryCounts: vi.fn(),
    getCensusPopulationsCached: vi.fn(),
    fetchSterilizationCoverage: vi.fn(),
    fetchMicrochipPenetration: vi.fn(),
    fetchEnoSla: vi.fn(),
    fetchQueueHealthScoped: vi.fn(),
    fetchDataQuality: vi.fn(),
    fetchCrossJurisdictionOutliers: vi.fn(),
    fetchPiiOversight: vi.fn(),
  };
});

mocks.requireGobReadAccessOrRedirect.mockImplementation(async () => ({
  profile: { id: "u-1", role: mocks.role.value },
  jurisdictions: mocks.jurisdictions.value,
}));
mocks.resolveJurisdictionScope.mockImplementation(async () => ({
  selectedProvince: null,
  selectedLocality: null,
  localities: [],
  filteredJurisdictions: mocks.jurisdictions.value,
  allowedProvinces: [{ code: "AR-V", name: "Tierra del Fuego" }],
  adminSelectedProvince: mocks.role.value === "admin" ? mocks.adminProvince.value : null,
  adminSelectedLocality: null,
}));
// The scope holds THREE pets — the whole point: small enough that the headline
// and the withheld province cell are literally the same number.
mocks.registryCounts.mockImplementation(async () => ({
  total: 3,
  active: 3,
  dormant: 0,
  incomplete: 1,
  byLocality: { value: [], suppressedCount: 0 },
}));
mocks.getCensusPopulationsCached.mockImplementation(async () => ({}));
mocks.fetchSterilizationCoverage.mockImplementation(async () => mocks.coverage);
mocks.fetchMicrochipPenetration.mockImplementation(async () => ({ ratePct: 66.6, active: 3 }));
mocks.fetchEnoSla.mockImplementation(async () => ({
  onTimePct: 100,
  total: 3,
  breachedOpen: 0,
}));
mocks.fetchQueueHealthScoped.mockImplementation(async () => ({
  pendingTotal: 3,
  oldestPendingDaysAgo: 4,
  pending14dPlus: 0,
  pending30dPlus: 0,
  pending60dPlus: 0,
}));
mocks.fetchDataQuality.mockImplementation(async () => ({
  total: 3,
  completenessPct: 66,
  missingLocality: 1,
  missingSex: 0,
  missingChip: 1,
  orphans: 0,
}));
mocks.fetchCrossJurisdictionOutliers.mockImplementation(async () => []);
// Kept empty so the page's actor-name lookup (a real `db.select`) never runs.
mocks.fetchPiiOversight.mockImplementation(async () => []);

vi.mock("@/lib/infra/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/auth-guards")>()),
  requireGobReadAccessOrRedirect: mocks.requireGobReadAccessOrRedirect,
}));
vi.mock("@/lib/analytics/jurisdiction-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/jurisdiction-scope")>()),
  resolveJurisdictionScope: mocks.resolveJurisdictionScope,
}));
vi.mock("@/lib/metrics/census", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/metrics/census")>()),
  registryCounts: mocks.registryCounts,
  getCensusPopulationsCached: mocks.getCensusPopulationsCached,
}));
vi.mock("@/lib/metrics/population-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/metrics/population-control")>()),
  fetchSterilizationCoverage: mocks.fetchSterilizationCoverage,
}));
vi.mock("@/lib/analytics/compliance-metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/compliance-metrics")>()),
  fetchMicrochipPenetration: mocks.fetchMicrochipPenetration,
}));
vi.mock("@/lib/analytics/surveillance-metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/surveillance-metrics")>()),
  fetchEnoSla: mocks.fetchEnoSla,
}));
vi.mock("@/lib/analytics/admin-metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/admin-metrics")>()),
  fetchQueueHealthScoped: mocks.fetchQueueHealthScoped,
}));
vi.mock("@/lib/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/metrics")>()),
  fetchDataQuality: mocks.fetchDataQuality,
  fetchCrossJurisdictionOutliers: mocks.fetchCrossJurisdictionOutliers,
  fetchPiiOversight: mocks.fetchPiiOversight,
}));

import { ProgramaResumenScreen } from "./ProgramaResumenScreen";

async function renderPage(searchParams: Record<string, string>): Promise<string> {
  const element = await ProgramaResumenScreen({ searchParams });
  return renderToStaticMarkup(element);
}

describe("Programa · vista Resumen — the scope headline obeys the same verdict as the rows", () => {
  it("an ADMIN drilled into a sub-k province publishes NO scope aggregate", async () => {
    mocks.role.value = "admin";
    mocks.jurisdictions.value = [];
    mocks.adminProvince.value = "Tierra del Fuego";
    mocks.coverage.scopeTotalPublishable = false;

    const html = await renderPage({ province: "AR-V" });

    // The disclosure is present and says WHY (never "sin datos" — the data
    // exists; dressing a withholding as a coverage gap is the same lie in
    // reverse).
    expect(html).toContain("Totales ocultos por privacidad");
    // And not one of the aggregates that IS the withheld cell survives.
    expect(html).not.toContain("Total registradas");
    expect(html).not.toContain("Esterilización");
    expect(html).not.toContain("Microchip");
    expect(html).not.toContain("SLA ENO");
    expect(html).not.toContain("Calidad de datos");
    // Above all: not the protected number itself, by any route (the padrón
    // count, the queue depth and the ENO total were all 3 in this fixture).
    expect(html).not.toMatch(/>3</);
  });

  it("D.10 SURVIVES: a GOVT operator keeps the real number for their OWN sub-k province", async () => {
    mocks.role.value = "govt";
    mocks.jurisdictions.value = [{ province: "Tierra del Fuego", locality: "" }];
    mocks.adminProvince.value = null;
    // Own cells are never suppression candidates, so the fetcher hands down a
    // publishable verdict — even at 3 pets. That is the ruling, not a loophole:
    // those animals are already in this operator's padrón, by name.
    mocks.coverage.scopeTotalPublishable = true;

    const html = await renderPage({});

    expect(html).not.toContain("Totales ocultos por privacidad");
    expect(html).toContain("Total registradas");
    // The real figure, not a dash and not a zero.
    expect(html).toMatch(/>3</);
    expect(html).toContain("Esterilización");
  });
});
