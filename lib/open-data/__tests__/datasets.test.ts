// Datasets-level test for buildDataset (Epic B, item 2) — audit fix.
//
// The other open-data tests either exercise province-suppression.ts directly
// (pure, no DB) or mock buildDataset itself at the route boundary. Neither
// proves that a suppressed row, once it flows through the REAL buildDataset
// pipeline, actually emits the marker on every numeric column it publishes —
// a regression there (e.g. only tagging one of the two rate columns) would
// leak a raw value while still "passing" every other suite.
//
// Here only the DB-backed fetcher is mocked; buildDataset, suppressRateProvinces
// and the row-shaping logic all run for real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchRabiesCoverageByProvince } = vi.hoisted(() => ({
  fetchRabiesCoverageByProvince: vi.fn(),
}));
const { fetchSterilizationCoverage } = vi.hoisted(() => ({
  fetchSterilizationCoverage: vi.fn(),
}));
const { fetchMicrochipPenetrationByProvince } = vi.hoisted(() => ({
  fetchMicrochipPenetrationByProvince: vi.fn(),
}));
const { fetchPppComplianceByProvince } = vi.hoisted(() => ({
  fetchPppComplianceByProvince: vi.fn(),
}));
const { loadMortalityRawRollupByProvince } = vi.hoisted(() => ({
  loadMortalityRawRollupByProvince: vi.fn(),
}));

vi.mock("@/lib/analytics/govt-home-kpis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/govt-home-kpis")>();
  return { ...actual, fetchRabiesCoverageByProvince };
});
vi.mock("@/lib/metrics/population-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics/population-control")>();
  return { ...actual, fetchSterilizationCoverage };
});
vi.mock("@/lib/analytics/compliance-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/compliance-metrics")>();
  return { ...actual, fetchMicrochipPenetrationByProvince, fetchPppComplianceByProvince };
});
// #40: the mortalidad builder now reads the RAW province rollup (not the map's
// already-suppressed cells) so suppressDensityProvinces can run its
// complementary pass over real counts. Mocked at that seam.
vi.mock("@/src/modules/panorama/infrastructure/repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/modules/panorama/infrastructure/repository")>();
  return { ...actual, loadMortalityRawRollupByProvince };
});

import { SUPPRESSED_MARKER } from "@/lib/open-data/province-suppression";
import { datasetToCsv, datasetToJson } from "@/lib/open-data/serialize";
import { buildDataset } from "../datasets";

beforeEach(() => {
  fetchRabiesCoverageByProvince.mockReset();
  fetchSterilizationCoverage.mockReset();
  fetchMicrochipPenetrationByProvince.mockReset();
  fetchPppComplianceByProvince.mockReset();
  loadMortalityRawRollupByProvince.mockReset();
  // C8 (2026-08-05): the joint rule now spans NESTED bases too
  // (perros_ppp ⊂ perros_registrados ⊂ mascotas_activas), so building ANY rate
  // dataset touches every other rate fetcher. Empty defaults keep a test that
  // only cares about one dataset from having to mock the whole family; a test
  // exercising the joint rule overrides what it needs.
  fetchRabiesCoverageByProvince.mockResolvedValue([]);
  fetchSterilizationCoverage.mockResolvedValue({
    rate: 0,
    sterilized: 0,
    total: 0,
    byProvince: [],
    byProvinceSuppressedCount: 0,
    byProvinceAssignedTotal: 0,
  });
  fetchMicrochipPenetrationByProvince.mockResolvedValue([]);
  fetchPppComplianceByProvince.mockResolvedValue([]);
});

describe("buildDataset — mortalidad (density) k-anon, aligned with the map (#40)", () => {
  it("marks a sub-k province and publishes the visible ones (same k=5, same criterion)", async () => {
    loadMortalityRawRollupByProvince.mockResolvedValue([
      { province: "Santa Cruz", count: 3 }, // < k → primary suppression
      { province: "Buenos Aires", count: 40 },
      { province: "Córdoba", count: 25 },
    ]);

    const built = await buildDataset("mortalidad", new Date("2026-07-15T00:00:00.000Z"));

    const sc = built.rows.find((r) => r.provincia === "Santa Cruz");
    expect(sc).toBeDefined();
    expect(sc?.fallecimientos_registrados).toBe(SUPPRESSED_MARKER);
    // The public file NEVER publishes the protected number, and never a 0.
    expect(sc?.fallecimientos_registrados).not.toBe(3);
    expect(sc?.fallecimientos_registrados).not.toBe(0);
    expect(built.meta.suppression.k).toBe(5);
  });

  it("keeps the COMPLEMENTARY pass alive — the reason it reads raw counts, not map cells", async () => {
    // The regression this locks: feeding this pipeline the map's suppressed
    // cells would hide the sub-k row, complementarySuppress would see ZERO
    // suppressed cells nationally, promote no complement, and the lone hidden
    // count would be recoverable by subtracting the visible provinces from the
    // national total. Exactly one primary suppression ⇒ a second row must also
    // be marked (the next-smallest visible).
    loadMortalityRawRollupByProvince.mockResolvedValue([
      { province: "Santa Cruz", count: 3 },
      { province: "Córdoba", count: 25 },
      { province: "Buenos Aires", count: 40 },
    ]);

    const built = await buildDataset("mortalidad", new Date("2026-07-15T00:00:00.000Z"));

    expect(built.meta.suppressedCount).toBe(2);
    // Córdoba (25) is the smallest visible → promoted; Buenos Aires survives.
    expect(built.rows.find((r) => r.provincia === "Córdoba")?.fallecimientos_registrados).toBe(
      SUPPRESSED_MARKER,
    );
    expect(built.rows.find((r) => r.provincia === "Buenos Aires")?.fallecimientos_registrados).toBe(
      40,
    );
  });

  it("suppresses the VALUE, not the province's existence — the row is still published", async () => {
    loadMortalityRawRollupByProvince.mockResolvedValue([
      { province: "Santa Cruz", count: 3 },
      { province: "Buenos Aires", count: 40 },
      { province: "Córdoba", count: 25 },
    ]);
    const built = await buildDataset("mortalidad", new Date("2026-07-15T00:00:00.000Z"));
    expect(built.rows.map((r) => r.provincia)).toContain("Santa Cruz");
    expect(built.rows).toHaveLength(3);
  });
});

describe("buildDataset — suppression end-to-end (real buildDataset, fetcher mocked)", () => {
  it("emits the marker on BOTH numeric columns of a suppressed row", async () => {
    // CABA: numerator (vaccinated) = 2 — a protected small positive — triggers
    // primary suppression via isRateCellProtected even though the population
    // base clears k. Buenos Aires / Córdoba clear every guard and stay visible.
    fetchRabiesCoverageByProvince.mockResolvedValue([
      { province: "CABA", vaccinated: 2, total: 9000, ratePct: 0 },
      { province: "Buenos Aires", vaccinated: 4000, total: 9000, ratePct: 44.4 },
      { province: "Córdoba", vaccinated: 4500, total: 9000, ratePct: 50 },
    ]);

    const built = await buildDataset("cobertura-antirrabica", new Date("2026-07-15T00:00:00.000Z"));

    const caba = built.rows.find((r) => r.provincia === "CABA");
    expect(caba).toBeDefined();
    // Both published numeric columns — the base AND the percentage — must
    // carry the marker. Tagging only one would silently leak the other.
    expect(caba?.perros_registrados).toBe(SUPPRESSED_MARKER);
    expect(caba?.cobertura_antirrabica_pct).toBe(SUPPRESSED_MARKER);

    // The visible rows are untouched.
    const cordoba = built.rows.find((r) => r.provincia === "Córdoba");
    expect(cordoba?.perros_registrados).toBe(9000);
    expect(cordoba?.cobertura_antirrabica_pct).toBe(50);

    expect(built.meta.suppressedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("buildDataset — a row the AUTHENTICATED tier already withheld (#40c)", () => {
  it("still ships the province, as the marker in every numeric column", async () => {
    // fetchSterilizationCoverage now applies the D.10 rule before returning, so
    // a national/admin build can receive rows with every number already null.
    // The public tier must NOT drop them (absence is a disclosure channel) and
    // must NOT publish a 0 — it must reach "protected" from its own rule.
    fetchSterilizationCoverage.mockResolvedValue({
      rate: 0,
      sterilized: 0,
      total: 0,
      byProvince: [
        {
          province: "Tierra del Fuego",
          suppressed: true,
          sterilized: null,
          total: null,
          ratePct: null,
        },
        { province: "Santa Cruz", suppressed: true, sterilized: null, total: null, ratePct: null },
        {
          province: "Buenos Aires",
          suppressed: false,
          sterilized: 4000,
          total: 9000,
          ratePct: 44.4,
        },
        { province: "Córdoba", suppressed: false, sterilized: 4500, total: 9000, ratePct: 50 },
      ],
      byProvinceSuppressedCount: 2,
      byProvinceAssignedTotal: 18_007,
    });
    // The joint-base pass reads microchip too (shared mascotas_activas column).
    fetchMicrochipPenetrationByProvince.mockResolvedValue([
      { province: "Buenos Aires", chipped: 4000, active: 9000, ratePct: 44.4 },
      { province: "Córdoba", chipped: 4500, active: 9000, ratePct: 50 },
    ]);

    const built = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-07-15T00:00:00.000Z"),
    );

    expect(built.rows.map((r) => r.provincia)).toContain("Tierra del Fuego");
    const tdf = built.rows.find((r) => r.provincia === "Tierra del Fuego");
    expect(tdf?.mascotas_activas).toBe(SUPPRESSED_MARKER);
    expect(tdf?.cobertura_esterilizacion_pct).toBe(SUPPRESSED_MARKER);
    expect(tdf?.mascotas_activas).not.toBe(0);
    expect(tdf?.cobertura_esterilizacion_pct).not.toBe(0);

    // The rows that were NOT withheld upstream are published normally.
    expect(built.rows.find((r) => r.provincia === "Córdoba")?.mascotas_activas).toBe(9000);
  });
});

describe("buildDataset — joint suppression of the shared mascotas_activas base", () => {
  // The attack the adversarial review confirmed: cobertura-esterilizacion and
  // cobertura-microchip publish the SAME base column (mascotas_activas) from the
  // same denominator. If a province is suppressed in microchip but CLEAR in
  // esterilizacion, per-dataset suppression would still publish the base in
  // esterilizacion — an attacker joins the two files on codigo_iso and recovers
  // exactly the base microchip withheld. The JOINT rule closes this: a province
  // suppressed in EITHER file has its base marked in BOTH.
  //
  // Scenario: CABA (and Tierra del Fuego, a second suppression so complementary
  // suppression stays inert) are suppressed in microchip via a protected small
  // numerator; all provinces clear their own guards in esterilizacion.
  function mockUnderlyingCounts() {
    // esterilizacion: every province clears k on its own → visible per-dataset.
    fetchSterilizationCoverage.mockResolvedValue({
      rate: 0,
      sterilized: 0,
      total: 0,
      byProvince: [
        { province: "CABA", suppressed: false, sterilized: 4500, total: 9000, ratePct: 50 },
        {
          province: "Tierra del Fuego",
          suppressed: false,
          sterilized: 4000,
          total: 8000,
          ratePct: 50,
        },
        {
          province: "Buenos Aires",
          suppressed: false,
          sterilized: 4000,
          total: 9000,
          ratePct: 44.4,
        },
        { province: "Córdoba", suppressed: false, sterilized: 4500, total: 9000, ratePct: 50 },
      ],
      byProvinceSuppressedCount: 0,
      byProvinceAssignedTotal: 35000,
    });
    // microchip: CABA + Tierra del Fuego suppressed (numerator 1-4 is protected).
    fetchMicrochipPenetrationByProvince.mockResolvedValue([
      { province: "CABA", chipped: 2, active: 9000, ratePct: 0 },
      { province: "Tierra del Fuego", chipped: 1, active: 8000, ratePct: 0 },
      { province: "Buenos Aires", chipped: 4000, active: 9000, ratePct: 44.4 },
      { province: "Córdoba", chipped: 4500, active: 9000, ratePct: 50 },
    ]);
    // C8: the NESTED bases are now part of the joint group, so both fetchers run
    // on every rate build. Held far below `mascotas_activas` here (differences of
    // thousands) so this fixture keeps testing the SAME-base rule alone.
    fetchRabiesCoverageByProvince.mockResolvedValue([
      { province: "CABA", vaccinated: 2000, total: 4000, ratePct: 50 },
      { province: "Tierra del Fuego", vaccinated: 1500, total: 3000, ratePct: 50 },
      { province: "Buenos Aires", vaccinated: 2000, total: 4000, ratePct: 50 },
      { province: "Córdoba", vaccinated: 2000, total: 4000, ratePct: 50 },
    ]);
    fetchPppComplianceByProvince.mockResolvedValue([
      { province: "CABA", attested: 500, flaggedCount: 1000, ratePct: 50 },
      { province: "Tierra del Fuego", attested: 400, flaggedCount: 800, ratePct: 50 },
      { province: "Buenos Aires", attested: 500, flaggedCount: 1000, ratePct: 50 },
      { province: "Córdoba", attested: 500, flaggedCount: 1000, ratePct: 50 },
    ]);
  }

  it("marks esterilizacion's base for a province suppressed only in microchip, while keeping its own pct visible", async () => {
    mockUnderlyingCounts();

    const est = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-07-15T00:00:00.000Z"),
    );

    const caba = est.rows.find((r) => r.provincia === "CABA");
    expect(caba).toBeDefined();
    // THE FIX: the shared base is withheld even though esterilizacion cleared k
    // on its own — because microchip suppressed CABA.
    expect(caba?.mascotas_activas).toBe(SUPPRESSED_MARKER);
    // The dataset-specific pct keeps its own (clear) per-dataset suppression: it
    // is safe to publish (numerator, base and complement are all ≥ k here) and
    // a bare percentage without its base recovers no count.
    expect(caba?.cobertura_esterilizacion_pct).toBe(50);

    // Second joint-suppressed province behaves identically.
    const tdf = est.rows.find((r) => r.provincia === "Tierra del Fuego");
    expect(tdf?.mascotas_activas).toBe(SUPPRESSED_MARKER);
    expect(tdf?.cobertura_esterilizacion_pct).toBe(50);

    // Provinces visible in BOTH files keep their real base.
    const cordoba = est.rows.find((r) => r.provincia === "Córdoba");
    expect(cordoba?.mascotas_activas).toBe(9000);
    expect(cordoba?.cobertura_esterilizacion_pct).toBe(50);
  });

  it("keeps the base joint-suppressed symmetrically in microchip too", async () => {
    mockUnderlyingCounts();

    const chip = await buildDataset("cobertura-microchip", new Date("2026-07-15T00:00:00.000Z"));

    // CABA is suppressed in microchip on its own → base + pct both marked.
    const caba = chip.rows.find((r) => r.provincia === "CABA");
    expect(caba?.mascotas_activas).toBe(SUPPRESSED_MARKER);
    expect(caba?.cobertura_microchip_pct).toBe(SUPPRESSED_MARKER);
  });

  it("preserves the joint-suppressed base across CSV/JSON serialization (parity)", async () => {
    mockUnderlyingCounts();

    const est = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-07-15T00:00:00.000Z"),
    );

    // JSON: the CABA base is the marker string, the pct is the real number.
    const json = JSON.parse(datasetToJson(est)) as {
      data: {
        provincia: string;
        mascotas_activas: unknown;
        cobertura_esterilizacion_pct: unknown;
      }[];
    };
    const cabaJson = json.data.find((r) => r.provincia === "CABA");
    expect(cabaJson?.mascotas_activas).toBe(SUPPRESSED_MARKER);
    expect(cabaJson?.cobertura_esterilizacion_pct).toBe(50);

    // CSV: the marker is present and quoted for CABA; the visible pct is not the
    // marker. The row order is province-sorted, so match the CABA data line.
    const csv = datasetToCsv(est);
    const cabaLine = csv.split("\r\n").find((l) => l.startsWith("CABA,"));
    expect(cabaLine).toBeDefined();
    expect(cabaLine).toContain(`"${SUPPRESSED_MARKER}"`);
    // The pct cell (50) survives as a real value alongside the suppressed base.
    expect(cabaLine).toMatch(/,50$/);
  });
});

describe("buildDataset — C8: joint suppression across NESTED bases (dogs ⊂ pets)", () => {
  // The audit finding (Y2/RA-3): joint suppression grouped on the base column
  // NAME, so `perros_registrados` and `mascotas_activas` looked unrelated. They
  // are not — every registered dog is an active pet. Both files pass their own
  // k-checks on their own populations, and the DIFFERENCE (the pets that are not
  // dogs) is a group nobody ever checked. Download both, join on codigo_iso,
  // subtract.
  //
  // Santa Cruz here: 9 004 active pets, 9 000 registered dogs → 4 non-dogs, a
  // sub-k group disclosed by two "compliant" files. Córdoba is the control:
  // 9 000 pets vs 4 000 dogs → a difference of 5 000, nothing to protect.
  function mockNestedCounts() {
    fetchSterilizationCoverage.mockResolvedValue({
      rate: 0,
      sterilized: 0,
      total: 0,
      byProvince: [
        { province: "Santa Cruz", suppressed: false, sterilized: 4502, total: 9004, ratePct: 50 },
        { province: "Córdoba", suppressed: false, sterilized: 4500, total: 9000, ratePct: 50 },
        {
          province: "Buenos Aires",
          suppressed: false,
          sterilized: 4500,
          total: 9000,
          ratePct: 50,
        },
      ],
      byProvinceSuppressedCount: 0,
      byProvinceAssignedTotal: 27004,
    });
    fetchRabiesCoverageByProvince.mockResolvedValue([
      { province: "Santa Cruz", vaccinated: 4500, total: 9000, ratePct: 50 },
      { province: "Córdoba", vaccinated: 2000, total: 4000, ratePct: 50 },
      { province: "Buenos Aires", vaccinated: 2000, total: 4000, ratePct: 50 },
    ]);
  }

  it("suppresses the SUPERSET base (mascotas_activas) when pets − dogs falls under k", async () => {
    mockNestedCounts();
    const est = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-08-05T00:00:00.000Z"),
    );
    const sc = est.rows.find((r) => r.provincia === "Santa Cruz");
    expect(sc?.mascotas_activas).toBe(SUPPRESSED_MARKER);
    // Its own rate survives — the dataset's own k-checks passed, and a rate
    // without its base recovers no count.
    expect(sc?.cobertura_esterilizacion_pct).toBe(50);
  });

  it("suppresses the SUBSET base (perros_registrados) too — the difference leaks both ways", async () => {
    mockNestedCounts();
    const rab = await buildDataset("cobertura-antirrabica", new Date("2026-08-05T00:00:00.000Z"));
    const sc = rab.rows.find((r) => r.provincia === "Santa Cruz");
    expect(sc?.perros_registrados).toBe(SUPPRESSED_MARKER);
  });

  it("leaves a province whose difference clears k fully published", async () => {
    mockNestedCounts();
    const est = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-08-05T00:00:00.000Z"),
    );
    const cba = est.rows.find((r) => r.provincia === "Córdoba");
    expect(cba?.mascotas_activas).toBe(9000);
    const rab = await buildDataset("cobertura-antirrabica", new Date("2026-08-05T00:00:00.000Z"));
    expect(rab.rows.find((r) => r.provincia === "Córdoba")?.perros_registrados).toBe(4000);
  });

  it("does NOT suppress an EQUAL pair — an empty complement identifies nobody", async () => {
    fetchSterilizationCoverage.mockResolvedValue({
      rate: 0,
      sterilized: 0,
      total: 0,
      byProvince: [
        { province: "Córdoba", suppressed: false, sterilized: 4500, total: 9000, ratePct: 50 },
        {
          province: "Buenos Aires",
          suppressed: false,
          sterilized: 4500,
          total: 9000,
          ratePct: 50,
        },
      ],
      byProvinceSuppressedCount: 0,
      byProvinceAssignedTotal: 18000,
    });
    // Every active pet in Córdoba is a registered dog: 9 000 − 9 000 = 0.
    fetchRabiesCoverageByProvince.mockResolvedValue([
      { province: "Córdoba", vaccinated: 4500, total: 9000, ratePct: 50 },
      { province: "Buenos Aires", vaccinated: 2000, total: 4000, ratePct: 50 },
    ]);
    const est = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-08-05T00:00:00.000Z"),
    );
    expect(est.rows.find((r) => r.provincia === "Córdoba")?.mascotas_activas).toBe(9000);
  });

  it("reaches TRANSITIVELY: ppp dogs vs active pets, two links apart", async () => {
    // perros_ppp ⊂ perros_registrados ⊂ mascotas_activas. An attacker joins the
    // ppp file straight to the esterilización file; the containment walk must
    // see the pair even though neither declares the other directly.
    fetchSterilizationCoverage.mockResolvedValue({
      rate: 0,
      sterilized: 0,
      total: 0,
      byProvince: [
        { province: "Santa Cruz", suppressed: false, sterilized: 4501, total: 9002, ratePct: 50 },
        { province: "Córdoba", suppressed: false, sterilized: 4500, total: 9000, ratePct: 50 },
      ],
      byProvinceSuppressedCount: 0,
      byProvinceAssignedTotal: 18002,
    });
    fetchPppComplianceByProvince.mockResolvedValue([
      { province: "Santa Cruz", attested: 4500, flaggedCount: 9000, ratePct: 50 },
      { province: "Córdoba", attested: 2000, flaggedCount: 4000, ratePct: 50 },
    ]);
    const est = await buildDataset(
      "cobertura-esterilizacion",
      new Date("2026-08-05T00:00:00.000Z"),
    );
    expect(est.rows.find((r) => r.provincia === "Santa Cruz")?.mascotas_activas).toBe(
      SUPPRESSED_MARKER,
    );
    expect(est.rows.find((r) => r.provincia === "Córdoba")?.mascotas_activas).toBe(9000);
  });
});
