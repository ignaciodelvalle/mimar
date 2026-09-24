// Per-cápita encoding domain (panorama-percapita v1 — PROVINCE grain).
//
// Contract under test:
//  1. Eligibility is a DECLARED per-layer property (PERCAPITA_ELIGIBLE_IDS):
//     only COUNT-shaped province layers where a human-population denominator is
//     meaningful. Rate/% layers, already-normalized layers, reference layers and
//     department-grain layers are excluded.
//  2. perCapitaRate: value10k = count / population * 10_000 (2-decimal round);
//     a missing/invalid denominator yields null — NEVER 0 (no fabricated rate).
//  3. enrichPerCapita joins province cells to the census lookup by normalized
//     province name; an unmatched province surfaces as no-data (per10k null).
//  4. projectPerCapita swaps count → per10k for the map projection; a k-anon
//     suppressed count STAYS suppressed (no rate from a hidden count).
//  5. Census metadata (year/source) reaches the caption footer, never hardcoded.

import { describe, expect, it } from "vitest";

import { PANORAMA_LAYERS, getLayer } from "../layers";
import {
  type CensusLookup,
  MIN_PERCAPITA_DENOMINATOR,
  PERCAPITA_ELIGIBLE_IDS,
  PERCAPITA_UNIT_LABEL,
  censusMetaOf,
  enrichPerCapita,
  isBelowPercapitaFloor,
  isPercapitaEligible,
  per10kDisplayValue,
  perCapitaRate,
  percapitaEligibleFor,
  percapitaFooterLabel,
  percapitaLayerLabel,
  projectPerCapita,
} from "../percapita";
import type { FeatureCollection, LayerId } from "../types";

const LOOKUP: CensusLookup = {
  populations: {
    "Buenos Aires": 17_569_053,
    CABA: 3_120_612,
    Córdoba: 3_978_984,
    "Tierra del Fuego": 190_641,
  },
  year: 2022,
  source: "INDEC Censo 2022",
};

function provinceFeature(
  province: string,
  count: number | null,
  suppressed = false,
): FeatureCollection["features"][number] {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-60, -35] },
    properties: {
      place: province,
      province,
      locality: null,
      departmentCode: null,
      level: "province",
      count,
      suppressed,
    },
  };
}

function fc(features: FeatureCollection["features"]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

describe("PERCAPITA_ELIGIBLE_IDS — the declared layer eligibility", () => {
  it("declares exactly the count-shaped province event/report layers", () => {
    expect([...PERCAPITA_ELIGIBLE_IDS].sort()).toEqual(
      ["denuncias", "mordeduras", "perdidas", "sintomas"].sort(),
    );
  });

  it("every eligible layer is a COUNT-shaped density point layer (no double-divide risk)", () => {
    // A rate/% layer must never be divided by population again; every eligible
    // layer serves RAW per-province counts (dataType density, point geometry).
    for (const id of PERCAPITA_ELIGIBLE_IDS) {
      const layer = getLayer(id);
      expect(layer, id).toBeDefined();
      expect(layer?.dataType, id).toBe("density");
      expect(layer?.geomType, id).toBe("point");
      expect(layer?.complianceTarget, id).toBeUndefined();
    }
  });

  it("excludes rate/%, already-normalized, index, reference and department-grain layers", () => {
    const excluded: LayerId[] = [
      "cobertura", // % of dogs vaccinated — not per-inhabitant
      "esterilizacion", // % rate
      "microchip", // % rate
      "ppp", // % rate
      "antiparasitario", // % rate
      "reunificacion", // ratePct signal
      "acceso-veterinario", // already per-1.000 pets
      "indice-territorial", // 0-100 index
      "zoonosis", // department grain at national — no department denominator in v1
      "mortalidad", // pet deaths: meaningful denominator is the pet registry, not humans
      "refugios",
      "clinicas",
      "decomisos", // reference pins — individual entities, never counts per unit
    ];
    for (const id of excluded) {
      expect(isPercapitaEligible(id), id).toBe(false);
    }
  });

  it("stays consistent with the registry (no eligible id missing from the catalog)", () => {
    const known = new Set(PANORAMA_LAYERS.map((l) => l.id));
    for (const id of PERCAPITA_ELIGIBLE_IDS) expect(known.has(id), id).toBe(true);
  });
});

describe("percapitaEligibleFor — the view-level gate predicate", () => {
  it("offers per-cápita at province level when every aggregating layer is eligible", () => {
    expect(percapitaEligibleFor(["denuncias"], "province")).toBe(true);
    expect(percapitaEligibleFor(["mordeduras"], "province")).toBe(true);
    // Reference layers never establish a unit — they don't block (bienestar preset).
    expect(percapitaEligibleFor(["denuncias", "decomisos"], "province")).toBe(true);
  });

  it("refuses below province framing (no department denominator in v1)", () => {
    expect(percapitaEligibleFor(["denuncias"], "locality")).toBe(false);
  });

  it("refuses when a non-eligible aggregating layer shares the map (mixed units)", () => {
    // sintomas preset: sintomas + zoonosis — zoonosis has no province denominator
    // (department grain) so ONE shared graduated scale would mix units.
    expect(percapitaEligibleFor(["sintomas", "zoonosis"], "province")).toBe(false);
    expect(percapitaEligibleFor(["perdidas", "reunificacion"], "province")).toBe(false);
    expect(percapitaEligibleFor(["cobertura"], "province")).toBe(false);
  });

  it("refuses an empty view (nothing to normalize)", () => {
    expect(percapitaEligibleFor([], "province")).toBe(false);
  });
});

describe("perCapitaRate — value10k = count / population * 10_000 (UNROUNDED, F2)", () => {
  it("computes the raw per-10k rate (no 2-decimal round that would fake a zero)", () => {
    expect(perCapitaRate(154, 482_019)).toBeCloseTo(3.1949, 4);
    expect(perCapitaRate(100, 17_569_053)).toBeCloseTo(0.0569, 4);
    expect(perCapitaRate(0, 190_641)).toBe(0);
  });

  it("NEVER collapses a tiny-but-real count over a large province to 0 (the F2 fix)", () => {
    // 1..8 events over Buenos Aires (17,5 M hab.) rounded to 2 decimals was 0 —
    // a fabricated "no incidence". The rate must stay strictly positive.
    for (let count = 1; count <= 8; count++) {
      expect(perCapitaRate(count, 17_569_053)).toBeGreaterThan(0);
    }
  });

  it("returns null — never 0 — for a missing count (suppressed upstream)", () => {
    expect(perCapitaRate(null, 482_019)).toBeNull();
    expect(perCapitaRate(undefined, 482_019)).toBeNull();
  });

  it("returns null — never 0 — for an invalid denominator", () => {
    expect(perCapitaRate(10, null)).toBeNull();
    expect(perCapitaRate(10, undefined)).toBeNull();
    expect(perCapitaRate(10, 0)).toBeNull();
    expect(perCapitaRate(10, -5)).toBeNull();
    expect(perCapitaRate(10, Number.NaN)).toBeNull();
  });

  it("suppresses a rate over a denominator below MIN_PERCAPITA_DENOMINATOR (the privacy floor)", () => {
    // A hypothetical department-scale population (3-4 digits) — below the
    // floor even though the count itself clears k=5.
    expect(perCapitaRate(50, MIN_PERCAPITA_DENOMINATOR - 1)).toBeNull();
    expect(perCapitaRate(6, 999)).toBeNull();
  });

  it("computes normally once the denominator is exactly at or above the floor", () => {
    expect(perCapitaRate(50, MIN_PERCAPITA_DENOMINATOR)).toBeCloseTo(50, 4);
    expect(perCapitaRate(50, MIN_PERCAPITA_DENOMINATOR + 1)).toBeGreaterThan(0);
  });

  it("REGRESSION — every real province population stays untouched by the floor", () => {
    // Smallest province (Tierra del Fuego, 190.641) is ~19x the floor; the
    // floor must be a complete no-op at province grain.
    const provincePopulations = [17_569_053, 3_120_612, 3_978_984, 190_641, 482_019];
    for (const population of provincePopulations) {
      expect(isBelowPercapitaFloor(population)).toBe(false);
      expect(perCapitaRate(154, population)).not.toBeNull();
    }
  });
});

describe("isBelowPercapitaFloor — the floor predicate", () => {
  it("is true only for a present, positive population under the floor", () => {
    expect(isBelowPercapitaFloor(1)).toBe(true);
    expect(isBelowPercapitaFloor(999)).toBe(true);
    expect(isBelowPercapitaFloor(MIN_PERCAPITA_DENOMINATOR - 1)).toBe(true);
  });

  it("is false at/above the floor, and false for null/missing (a different no-data case)", () => {
    expect(isBelowPercapitaFloor(MIN_PERCAPITA_DENOMINATOR)).toBe(false);
    expect(isBelowPercapitaFloor(MIN_PERCAPITA_DENOMINATOR + 1)).toBe(false);
    expect(isBelowPercapitaFloor(190_641)).toBe(false);
    // Null/undefined/0/negative are "no census match", not "below floor" —
    // perCapitaRate already nulls those independently.
    expect(isBelowPercapitaFloor(null)).toBe(false);
    expect(isBelowPercapitaFloor(undefined)).toBe(false);
    expect(isBelowPercapitaFloor(0)).toBe(false);
    expect(isBelowPercapitaFloor(-100)).toBe(false);
  });
});

describe("per10kDisplayValue — honest small-rate display (F2)", () => {
  it("shows a positive-but-tiny rate as '<0,01' instead of a fake '0,00'", () => {
    // count 1 over Buenos Aires (17,5 M) ≈ 0,00057 → would round to 0,00 and read
    // as "no incidence"; the honest display says "below 0,01".
    expect(per10kDisplayValue(perCapitaRate(1, 17_500_000))).toBe("<0,01");
    expect(per10kDisplayValue(0.0009)).toBe("<0,01");
  });

  it("renders a real es-AR value with exactly 2 decimals", () => {
    expect(per10kDisplayValue(3.1949)).toBe("3,19");
    expect(per10kDisplayValue(0.5026)).toBe("0,50");
    expect(per10kDisplayValue(0.01)).toBe("0,01");
  });

  it("keeps a genuine zero (count 0) as 0,00 — that IS no incidence", () => {
    expect(per10kDisplayValue(0)).toBe("0,00");
  });

  it("is null-safe (no rate → empty string, callers render their own no-data copy)", () => {
    expect(per10kDisplayValue(null)).toBe("");
    expect(per10kDisplayValue(undefined)).toBe("");
    expect(per10kDisplayValue(Number.NaN)).toBe("");
  });
});

describe("enrichPerCapita — the census join (server-side, name-normalized)", () => {
  it("joins by province name and carries population, per10k and census metadata", () => {
    const out = enrichPerCapita(fc([provinceFeature("Córdoba", 200)]), LOOKUP);
    const p = out.features[0].properties;
    expect(p.population).toBe(3_978_984);
    expect(p.per10k).toBeCloseTo(0.5026, 4);
    expect(p.censusYear).toBe(2022);
    expect(p.censusSource).toBe("INDEC Censo 2022");
    // The raw count is untouched — the projection (not the join) swaps values.
    expect(p.count).toBe(200);
  });

  it("joins accent/case-insensitively (mirrors the bivariate normName rule)", () => {
    const out = enrichPerCapita(fc([provinceFeature("cordoba", 200)]), LOOKUP);
    expect(out.features[0].properties.per10k).toBeCloseTo(0.5026, 4);
  });

  it("surfaces an unmatched province as no-data (null), NEVER 0", () => {
    const out = enrichPerCapita(fc([provinceFeature("Provincia Fantasma", 42)]), LOOKUP);
    const p = out.features[0].properties;
    expect(p.population).toBeNull();
    expect(p.per10k).toBeNull();
    expect(p.count).toBe(42);
  });

  it("keeps a k-anon suppressed cell suppressed — no rate from a hidden count", () => {
    const out = enrichPerCapita(fc([provinceFeature("CABA", null, true)]), LOOKUP);
    const p = out.features[0].properties;
    expect(p.per10k).toBeNull();
    expect(p.suppressed).toBe(true);
  });

  describe("the denominator privacy floor (forward-compatible with department grain)", () => {
    // Hypothetical department-scale (3-4 digit) populations — v1 has NO
    // department census rows, so these units are made-up for the floor test
    // only; they exercise the SAME enrichPerCapita path a future department
    // wiring would use, without turning department grain on anywhere.
    const TINY_LOOKUP: CensusLookup = {
      populations: {
        "Departamento Chico": 8_000, // below MIN_PERCAPITA_DENOMINATOR
        "Departamento Grande": 25_000, // above the floor
      },
      year: 2022,
      source: "INDEC Censo 2022",
    };

    it("a visible (k>=5) count over a below-floor population reads suppressed, never a number", () => {
      // count=50 clears k=5 easily — the numerator was never at risk. The
      // floor suppresses it anyway because the DENOMINATOR is too small.
      const out = enrichPerCapita(fc([provinceFeature("Departamento Chico", 50)]), TINY_LOOKUP);
      const p = out.features[0].properties;
      expect(p.per10k).toBeNull();
      expect(p.suppressed).toBe(true); // hatch treatment, not blank no-data
      expect(p.population).toBe(8_000); // population itself is still shown
    });

    it("a count over an above-floor population still computes normally", () => {
      const out = enrichPerCapita(fc([provinceFeature("Departamento Grande", 50)]), TINY_LOOKUP);
      const p = out.features[0].properties;
      expect(p.per10k).toBeCloseTo(20, 4); // 50 / 25_000 * 10_000
      expect(p.suppressed).toBe(false);
    });

    it("DIFFERENCING CASE — the floor stops a visible sibling's rate from reconstructing a k-suppressed neighbor", () => {
      // Two departments in the same regional group. "Vecino Chico" has a
      // k-suppressed count (null, suppressed upstream) — its true count is
      // some value in 1..4 (the k=5 band), unknown to an outside observer.
      // "Vecino Grande" is fully visible (count=6, population=8_000, BELOW
      // the floor). WITHOUT the floor, Vecino Grande's rate would publish
      // 7.5 per 10k, which (combined with its public census population)
      // exactly reconstructs its count = 6 — no leak there alone, since 6 was
      // already a visible raw count. But a regional TOTAL published elsewhere
      // (e.g. a province-level rollup, unsuppressed per the accepted §U5
      // disclosure) minus every OTHER visible sibling's rate-derived count
      // narrows in on Vecino Chico's hidden count with full precision applied
      // to every visible small-population sibling in the group — the floor
      // removes that precision at the source by never publishing a rate for
      // ANY tiny-denominator cell, suppressed or not.
      const group = fc([
        provinceFeature("Vecino Chico", null, true), // k-suppressed (1..4, hidden)
        provinceFeature("Vecino Grande", 6, false), // visible, but tiny population
      ]);
      const lookup: CensusLookup = {
        populations: { "Vecino Chico": 4_500, "Vecino Grande": 8_000 },
        year: 2022,
        source: "INDEC Censo 2022",
      };
      const out = enrichPerCapita(group, lookup);
      const [chico, grande] = out.features.map((f) => f.properties);
      // The suppressed sibling never had a rate.
      expect(chico.per10k).toBeNull();
      expect(chico.suppressed).toBe(true);
      // The floor ALSO nulls the visible sibling's rate — no precise
      // denominator-based inversion survives to feed a differencing attack.
      expect(grande.per10k).toBeNull();
      expect(grande.suppressed).toBe(true);
    });
  });

  it("passes non-province features through untouched", () => {
    const locality = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [-60, -35] as [number, number] },
      properties: { province: "CABA", locality: "Palermo", level: "locality", count: 7 },
    };
    const out = enrichPerCapita(fc([locality]), LOOKUP);
    expect(out.features[0].properties).toEqual(locality.properties);
  });
});

describe("projectPerCapita — the client projection the map paints", () => {
  it("swaps count → per10k and marks the feature perCapita", () => {
    const enriched = enrichPerCapita(fc([provinceFeature("Córdoba", 200)]), LOOKUP);
    const out = projectPerCapita(enriched);
    const p = out.features[0].properties;
    expect(p.count).toBeCloseTo(0.5026, 4);
    expect(p.perCapita).toBe(true);
    expect(p.suppressed).toBe(false);
  });

  it("a suppressed cell stays suppressed with no value", () => {
    const enriched = enrichPerCapita(fc([provinceFeature("CABA", null, true)]), LOOKUP);
    const out = projectPerCapita(enriched);
    const p = out.features[0].properties;
    expect(p.count).toBeNull();
    expect(p.suppressed).toBe(true);
  });

  it("an un-enriched feature (stale cache, census unavailable) reads as no-data", () => {
    const out = projectPerCapita(fc([provinceFeature("Córdoba", 200)]));
    const p = out.features[0].properties;
    expect(p.count).toBeNull();
    expect(p.suppressed).toBe(false);
  });
});

describe("census metadata → footer (never hardcoded)", () => {
  it("censusMetaOf reads year/source from the enriched collection", () => {
    const enriched = enrichPerCapita(fc([provinceFeature("CABA", 3)]), LOOKUP);
    expect(censusMetaOf(enriched)).toEqual({ year: 2022, source: "INDEC Censo 2022" });
  });

  it("censusMetaOf is null for an un-enriched collection", () => {
    expect(censusMetaOf(fc([provinceFeature("CABA", 3)]))).toBeNull();
  });

  it("percapitaFooterLabel formats the honest footer from the table's metadata", () => {
    expect(percapitaFooterLabel({ year: 2022, source: "INDEC Censo 2022" })).toBe(
      "Tasas por 10.000 habitantes — Censo 2022 (INDEC)",
    );
    // A future census re-seed flows through without a code change.
    expect(percapitaFooterLabel({ year: 2032, source: "INDEC Censo 2032" })).toBe(
      "Tasas por 10.000 habitantes — Censo 2032 (INDEC)",
    );
  });

  it("percapitaLayerLabel appends the per-10k unit to the layer label", () => {
    expect(percapitaLayerLabel("Denuncias de bienestar")).toBe(
      `Denuncias de bienestar (${PERCAPITA_UNIT_LABEL})`,
    );
  });
});
