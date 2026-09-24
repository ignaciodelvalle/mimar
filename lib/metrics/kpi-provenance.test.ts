// kpi-provenance.test.ts — completeness + language fences for the provenance
// formulas (the "¿De dónde sale este número?" contract).
//
// The completeness fence is the test that keeps future KPIs honest: every
// KpiId in KPI_CATALOG must carry a non-empty es-AR formula. (The type system
// already enforces this — KPI_PROVENANCE is a full Record<KpiId, …> — but the
// runtime sweep also catches an empty/whitespace string the compiler cannot.)

import { describe, expect, it } from "vitest";

import { KPI_CATALOG } from "./kpi-catalog";
import { KPI_PROVENANCE, describeWindowBasisEs, getKpiProvenance } from "./kpi-provenance";

// English dev-prose words that must never leak into operator-facing formula
// copy. Deliberately short to avoid false positives on es-AR words: \b keeps
// "cuenta" (count), "estado" (status) and snake_case identifiers like
// "status_changed" (underscore is a word char, so \b never fires inside) safe.
const ENGLISH_DEV_PROSE = /\b(count|where|status|from|distinct|select|null)\b/i;

describe("KPI_PROVENANCE — completeness fence", () => {
  const catalogIds = Object.keys(KPI_CATALOG);

  it("covers every catalogued KpiId with a non-empty formulaEs", () => {
    for (const id of catalogIds) {
      const entry = KPI_PROVENANCE[id as keyof typeof KPI_PROVENANCE];
      expect(entry, `KPI_PROVENANCE is missing an entry for "${id}"`).toBeDefined();
      expect(
        entry.formulaEs.trim().length,
        `KPI_PROVENANCE["${id}"].formulaEs must not be empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("has no orphan entries for ids the catalog no longer declares", () => {
    for (const id of Object.keys(KPI_PROVENANCE)) {
      expect(catalogIds, `KPI_PROVENANCE["${id}"] has no matching KPI_CATALOG entry`).toContain(id);
    }
  });

  it("keeps every formula in es-AR — no English dev-prose function words", () => {
    for (const [id, entry] of Object.entries(KPI_PROVENANCE)) {
      const match = entry.formulaEs.match(ENGLISH_DEV_PROSE);
      expect(
        match,
        `KPI_PROVENANCE["${id}"].formulaEs contains English dev prose ("${match?.[0]}"): ${entry.formulaEs}`,
      ).toBeNull();
    }
  });

  it("getKpiProvenance resolves the same entry the record holds", () => {
    expect(getKpiProvenance("rabies_coverage_dogs_12m")).toBe(
      KPI_PROVENANCE.rabies_coverage_dogs_12m,
    );
  });
});

describe("describeWindowBasisEs — catalog-static period line", () => {
  it("renders the window and the counting basis in es-AR", () => {
    expect(describeWindowBasisEs("12m", "ratio")).toBe(
      "Últimos 12 meses · razón (numerador sobre denominador)",
    );
    expect(describeWindowBasisEs("now", "stock")).toBe(
      "Al momento de la consulta · stock (foto a un momento dado)",
    );
  });

  it("covers every catalogued window/basis pair without throwing", () => {
    for (const def of Object.values(KPI_CATALOG)) {
      expect(describeWindowBasisEs(def.window, def.basis).length).toBeGreaterThan(0);
    }
  });
});
