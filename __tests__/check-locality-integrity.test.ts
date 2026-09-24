/**
 * Unit tests for scripts/check-locality-integrity.ts — the locality-catalog
 * integrity gate. Pure fixture tests (no DB): exercise the three detectors
 * against catalog rows transcribed from the live INDEC catalog and the live
 * ar_localities table.
 *
 * WHY THERE ARE THREE (2026-08-21). The gate used to be one check —
 * findAggregateViolations — and it was blind to the failure that actually
 * happened. On 2026-08-19 INDEC replaced CABA's single department-less city-wide
 * row with 15 per-Comuna rows, each carrying a departamento_id. The gate queried
 * only the department-less slice, so it never even LOADED the offending rows,
 * and `lint:locality` printed "✓ Locality integrity clean" over a catalog with
 * 15 phantom AR-C localities double-counting the 48 barrios.
 *
 * The lesson is the one this repo keeps relearning: the old check enumerated a
 * FORM (department-less, name equals province) rather than the SUBJECT (CABA is
 * its 48 barrios; no INDEC row for AR-C belongs here). findSupersededViolations
 * states the subject. findCoverageShortfalls is the non-vacuity floor — "no
 * INDEC rows for AR-C" is also true of an EMPTY AR-C catalog.
 */

import { describe, expect, it } from "vitest";

import {
  type LocalityRow,
  findAggregateViolations,
  findCoverageShortfalls,
  findSupersededViolations,
} from "@/scripts/check-locality-integrity";

function row(over: Partial<LocalityRow> & Pick<LocalityRow, "locality_name">): LocalityRow {
  return {
    province_code: "AR-C",
    locality_slug: over.locality_name.toLowerCase().replaceAll(" ", "-"),
    department_code: null,
    source: "indec_cppdyl",
    ...over,
  };
}

// department_code is null ONLY for CABA rows in the real catalog; capitals all
// carry a departamento. The fixture mirrors that slice plus one capital as a
// negative control.
const CATALOG_SLICE: LocalityRow[] = [
  // The historical offender — whole-city aggregate, no departamento, name → AR-C.
  {
    province_code: "AR-C",
    locality_name: "Ciudad Autónoma de Buenos Aires",
    locality_slug: "ciudad-autonoma-de-buenos-aires",
    department_code: null,
    source: "indec_cppdyl",
  },
  // CABA barrios from the city's own catalog — department-less, names do not
  // resolve to AR-C, and they ARE the AR-C catalog.
  row({ locality_name: "Palermo", source: "caba_open_data" }),
  row({ locality_name: "Recoleta", source: "caba_open_data" }),
  // Real capital sharing its province name — has a departamento, must be kept.
  {
    province_code: "AR-X",
    locality_name: "Córdoba",
    locality_slug: "cordoba",
    department_code: "14014",
    source: "indec_cppdyl",
  },
];

// The live shape since 2026-08-19, transcribed from
// https://infra.datos.gob.ar/georef/localidades_censales.csv (Last-Modified
// Wed, 19 Aug 2026). Ids 02007010 … 02105010, departamento_id 02007 … 02105.
const CABA_COMUNA_ROWS: LocalityRow[] = [2, 14].map((n) =>
  row({
    locality_name: `CABA - Comuna ${n}`,
    locality_slug: `caba-comuna-${n}`,
    department_code: `020${String(n * 7).padStart(2, "0")}`,
    source: "indec_cppdyl",
  }),
);

describe("findAggregateViolations", () => {
  it("flags exactly the CABA whole-city aggregate", () => {
    const violations = findAggregateViolations(CATALOG_SLICE);
    expect(violations).toHaveLength(1);
    expect(violations[0].locality_slug).toBe("ciudad-autonoma-de-buenos-aires");
  });

  it("returns nothing for a clean catalog slice", () => {
    const clean = CATALOG_SLICE.filter(
      (r) => r.locality_slug !== "ciudad-autonoma-de-buenos-aires",
    );
    expect(findAggregateViolations(clean)).toEqual([]);
  });

  it("does not flag CABA barrios or capitals sharing their province name", () => {
    const violations = findAggregateViolations(CATALOG_SLICE);
    const flaggedSlugs = violations.map((v) => v.locality_slug);
    expect(flaggedSlugs).not.toContain("palermo");
    expect(flaggedSlugs).not.toContain("recoleta");
    expect(flaggedSlugs).not.toContain("cordoba");
  });

  it("is BLIND to the 15 comunas — the reason the second detector exists", () => {
    // Not a defect in this function: by its own definition a row with a
    // departamento is not a whole-province aggregate. It is a defect in relying
    // on it alone, which is what the gate did.
    expect(findAggregateViolations(CABA_COMUNA_ROWS)).toEqual([]);
  });
});

describe("findSupersededViolations", () => {
  it("flags every indec_cppdyl row for a province an alt source owns", () => {
    const violations = findSupersededViolations([...CATALOG_SLICE, ...CABA_COMUNA_ROWS]);
    const slugs = violations.map((v) => v.locality_slug).sort();
    expect(slugs).toEqual(["caba-comuna-14", "caba-comuna-2", "ciudad-autonoma-de-buenos-aires"]);
  });

  it("catches the comunas the aggregate detector cannot see", () => {
    // THE CI BREAK. 15 of these imported on every bootstrap and `lint:locality`
    // stayed green because it never loaded them.
    expect(findSupersededViolations(CABA_COMUNA_ROWS)).toHaveLength(2);
  });

  it("keeps the alt source's own barrios and every other province's rows", () => {
    const slugs = findSupersededViolations(CATALOG_SLICE).map((v) => v.locality_slug);
    expect(slugs).not.toContain("palermo");
    expect(slugs).not.toContain("recoleta");
    expect(slugs).not.toContain("cordoba");
  });

  it("keeps curated manual rows for the same province", () => {
    // "Belgrano R" lives in the local catalog as source='manual' — a deliberate
    // addition the 48-barrio division does not name. A supersede rule displaces
    // the sources it names, not everything that is not the owner.
    const manual = [row({ locality_name: "Belgrano R", source: "manual" })];
    expect(findSupersededViolations(manual)).toEqual([]);
  });
});

describe("findCoverageShortfalls", () => {
  it("reports nothing when the owning source meets its floor", () => {
    const full = Array.from({ length: 48 }, (_, i) =>
      row({ locality_name: `Barrio ${i}`, source: "caba_open_data" }),
    );
    expect(findCoverageShortfalls(full)).toEqual([]);
  });

  it("reports a shortfall when the owning source is thin — the non-vacuity floor", () => {
    // "0 superseded violations" is also true of an EMPTY AR-C catalog, which is
    // strictly worse than the state being guarded against. Without this, the
    // gate would applaud a catalog that lost all 48 barrios.
    const shortfalls = findCoverageShortfalls(CATALOG_SLICE);
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]).toMatchObject({
      provinceCode: "AR-C",
      source: "caba_open_data",
      seen: 2,
      minimumRows: 48,
    });
  });

  it("counts only the OWNING source, never the rows it supersedes", () => {
    // 48 INDEC rows for AR-C must not be mistaken for coverage; they are the
    // violation. Padding the count with them would let the two checks cancel.
    const wrong = Array.from({ length: 48 }, (_, i) =>
      row({ locality_name: `CABA - Comuna ${i}`, source: "indec_cppdyl" }),
    );
    expect(findCoverageShortfalls(wrong)).toHaveLength(1);
    expect(findCoverageShortfalls(wrong)[0].seen).toBe(0);
  });
});
