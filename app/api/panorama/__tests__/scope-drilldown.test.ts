// Route-level regression tests for the Panorama drill-down scope wiring
// (critique of PR #762, findings 1, 2, 3, 4).
//
// These mock the shared institutional gate + the use-cases and assert the
// EXACT arguments each route threads down, so a regression in the drill-down
// wiring is caught without a DB. Failure modes reproduced here:
//   #1  admin picks a province → kpis refetch must pass adminProvince/Locality
//       (before: it silently returned NATIONAL KPIs).
//   #2  whole-CABA operator opens a barrio unit → 200, not 403.
//   #3  a custom period → [layer] must thread `until` as the window upper bound
//       (before: events after `to` were plotted).
//   #4  whole-CABA operator picks a barrio → scoped narrows to that barrio,
//       never empties to sql`false`.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mocks (hoisted) -------------------------------------------------------

const mockResolveActor = vi.fn();
vi.mock("../_guard", () => ({
  resolveInstitutionalPanoramaActor: () => mockResolveActor(),
}));

const mockLocalityByName = vi.fn();
vi.mock("@/lib/infra/ar-localidades", () => ({
  localityByName: (...a: unknown[]) => mockLocalityByName(...a),
}));

const mockGetPanoramaKpis = vi.fn();
vi.mock("@/src/modules/panorama/application/get-panorama-kpis", () => ({
  getPanoramaKpis: (...a: unknown[]) => mockGetPanoramaKpis(...a),
  degradedPanoramaKpis: () => ({ kpis: [], recalculatedFor: "", dataAsOf: null }),
}));

const mockGetLayerFeatures = vi.fn();
vi.mock("@/src/modules/panorama/application/get-layer-features", () => ({
  getLayerFeatures: (...a: unknown[]) => mockGetLayerFeatures(...a),
  // panorama-event-points Slice 1: the route now imports resolvePointsMode; keep
  // the real gate semantics in the mock (mode=points AND a province resolved).
  resolvePointsMode: (mode: string | null, provinceResolved: boolean) =>
    mode === "points" && provinceResolved,
  emptyLayerFeatures: () => ({
    features: { type: "FeatureCollection", features: [] },
    truncated: false,
    suppressedCount: 0,
    noLocalityCount: 0,
    level: "locality",
  }),
}));

const mockLoadUnitHistory = vi.fn();
vi.mock("@/src/modules/panorama/infrastructure/repository", () => ({
  loadUnitHistory: (...a: unknown[]) => mockLoadUnitHistory(...a),
}));

import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { GET as layerGET } from "../[layer]/route";
import { GET as kpisGET } from "../kpis/route";
import { GET as unitHistoryGET } from "../unit-history/route";

const CABA_WHOLE = { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" };
const CABA_PALERMO = { province: "CABA", locality: "Palermo" };

function actorOk(role: "admin" | "govt", jurisdictions: { province: string; locality: string }[]) {
  return {
    ok: true,
    actor: { role, profile: { role }, jurisdictions },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: locality slug "palermo" resolves to the "Palermo" barrio.
  mockLocalityByName.mockResolvedValue({ localityName: "Palermo", localitySlug: "palermo" });
  mockGetPanoramaKpis.mockResolvedValue({ kpis: [], recalculatedFor: "", dataAsOf: null });
  mockGetLayerFeatures.mockResolvedValue({
    features: { type: "FeatureCollection", features: [] },
    truncated: false,
    suppressedCount: 0,
    noLocalityCount: 0,
    level: "locality",
  });
  mockLoadUnitHistory.mockResolvedValue({ events: [], trend: [], byType: {} });
});

// ---------------------------------------------------------------------------
// Finding 1 — kpis route honors the ADMIN province/locality filter.
// ---------------------------------------------------------------------------
describe("GET /api/panorama/kpis — admin drill-down (finding 1)", () => {
  it("passes adminProvince/adminLocality when an admin picks a province+locality", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin", []));
    const res = await kpisGET(
      new Request("http://localhost/api/panorama/kpis?province=AR-C&locality=palermo"),
    );
    expect(res.status).toBe(200);
    expect(mockGetPanoramaKpis).toHaveBeenCalledTimes(1);
    const [, scoped, , adminProvince, adminLocality] = mockGetPanoramaKpis.mock.calls[0];
    // Admin scope stays universal ([]) — the drill-down rides the admin params.
    expect(scoped).toEqual([]);
    expect(adminProvince).toBe("CABA");
    expect(adminLocality).toBe("Palermo");
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — kpis route narrows a whole-province govt assignment (not empty).
// ---------------------------------------------------------------------------
describe("GET /api/panorama/kpis — govt subsumption (finding 4)", () => {
  it("narrows a whole-CABA operator to the picked barrio instead of emptying", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", [CABA_WHOLE]));
    const res = await kpisGET(
      new Request("http://localhost/api/panorama/kpis?province=AR-C&locality=palermo"),
    );
    expect(res.status).toBe(200);
    const [, scoped, , adminProvince, adminLocality] = mockGetPanoramaKpis.mock.calls[0];
    expect(scoped).toEqual([{ province: "CABA", locality: "Palermo" }]);
    // govt must NEVER receive the admin drill-down params.
    expect(adminProvince).toBeUndefined();
    expect(adminLocality).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — [layer] route threads `until` as the window upper bound.
// ---------------------------------------------------------------------------
describe("GET /api/panorama/[layer] — custom period upper bound (finding 3)", () => {
  it("passes asOf = period.until for a custom period with no scrub", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin", []));
    const qs = "period=custom&from=2025-01-01&to=2025-06-01";
    const res = await layerGET(new Request(`http://localhost/api/panorama/perdidas?${qs}`), {
      params: Promise.resolve({ layer: "perdidas" }),
    });
    expect(res.status).toBe(200);
    const [, , , periodArg] = mockGetLayerFeatures.mock.calls[0];
    const expected = resolveAnalyticsPeriod({
      period: "custom",
      from: "2025-01-01",
      to: "2025-06-01",
    });
    // Before the fix asOf was undefined (no scrub) → the custom upper bound leaked.
    expect(periodArg.asOf).toBeInstanceOf(Date);
    expect((periodArg.asOf as Date).getTime()).toBe(expected.until.getTime());
    expect((periodArg.since as Date).getTime()).toBe(expected.since.getTime());
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — unit-history route gate uses whole-province subsumption.
// ---------------------------------------------------------------------------
describe("GET /api/panorama/unit-history — govt scope gate (finding 2)", () => {
  const url = (province: string, locality: string) =>
    new Request(
      `http://localhost/api/panorama/unit-history?layer=perdidas&province=${encodeURIComponent(
        province,
      )}&locality=${encodeURIComponent(locality)}`,
    );

  it("serves a barrio unit to a whole-CABA operator (200, not 403)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", [CABA_WHOLE]));
    const res = await unitHistoryGET(url("CABA", "Palermo"));
    expect(res.status).toBe(200);
    expect(mockLoadUnitHistory).toHaveBeenCalledTimes(1);
  });

  it("403s a barrio operator requesting a DIFFERENT barrio (never widens)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", [CABA_PALERMO]));
    const res = await unitHistoryGET(url("CABA", "Almagro"));
    expect(res.status).toBe(403);
    expect(mockLoadUnitHistory).not.toHaveBeenCalled();
  });
});
