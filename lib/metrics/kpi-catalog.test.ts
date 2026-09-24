// Unit tests for lib/metrics/kpi-catalog.ts — PURE, DB-free.
//
// Covers:
//   1. Catalog shape invariants (id matches key, required fields non-empty).
//   2. Label uniqueness — the whole point of this catalog is that no two KPIs
//      share a label (the "42% vs 54% same label" bug this catalog fixes).
//   3. fetcherName uniqueness — one catalog entry per fetcher.
//   4. Coverage of /gob home: every KPI fetcher app/gob/page.tsx imports from
//      lib/analytics/{govt-home-kpis,compliance-metrics,mortality-metrics}
//      must have a matching catalog entry. This is a live grep of the page
//      source, not a hardcoded list — a new home-page KPI fetcher without a
//      catalog entry fails this test.
//   5. The two rabies KPIs are disambiguated (distinct labels + distinct
//      denominator population noted in their definitions).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KPI_CATALOG,
  KPI_CATALOG_LIST,
  type KpiTarget,
  findKpiByFetcherName,
  formatKpiTarget,
} from "./kpi-catalog";

// ---------------------------------------------------------------------------
// 1. Shape invariants
// ---------------------------------------------------------------------------

describe("KPI_CATALOG shape", () => {
  it("every entry's `id` matches its own record key", () => {
    for (const [key, def] of Object.entries(KPI_CATALOG)) {
      expect(def.id).toBe(key);
    }
  });

  it("every entry has non-empty label/numerator/denominator/source/fetcherName/fetcherPath/cadence/unit/suppression", () => {
    for (const def of KPI_CATALOG_LIST) {
      expect(def.label.length, `${def.id}.label`).toBeGreaterThan(0);
      expect(def.numerator.length, `${def.id}.numerator`).toBeGreaterThan(0);
      expect(def.denominator.length, `${def.id}.denominator`).toBeGreaterThan(0);
      expect(def.source.length, `${def.id}.source`).toBeGreaterThan(0);
      expect(def.fetcherName.length, `${def.id}.fetcherName`).toBeGreaterThan(0);
      expect(def.fetcherPath.length, `${def.id}.fetcherPath`).toBeGreaterThan(0);
      expect(def.cadence.length, `${def.id}.cadence`).toBeGreaterThan(0);
      expect(def.unit.length, `${def.id}.unit`).toBeGreaterThan(0);
      expect(def.suppression.length, `${def.id}.suppression`).toBeGreaterThan(0);
    }
  });

  // Night-1 dataviz/honesty audit: window/species/basis are the machine-readable
  // versions of the disambiguation prose (cadence/numerator/denominator) — every
  // entry must set them, or a future entry could silently skip disambiguation.
  it("every entry sets window/species/basis (machine-readable disambiguation axes)", () => {
    const VALID_WINDOWS = new Set(["now", "7d", "30d", "12m", "all_time", "period", "mixed"]);
    const VALID_SPECIES = new Set(["dogs", "all_species", "n/a"]);
    const VALID_BASIS = new Set(["stock", "flow", "ratio"]);
    for (const def of KPI_CATALOG_LIST) {
      expect(VALID_WINDOWS.has(def.window), `${def.id}.window`).toBe(true);
      expect(VALID_SPECIES.has(def.species), `${def.id}.species`).toBe(true);
      expect(VALID_BASIS.has(def.basis), `${def.id}.basis`).toBe(true);
    }
  });

  it("has at least 10 catalogued KPIs (program-wide coverage, not a single surface)", () => {
    expect(KPI_CATALOG_LIST.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 2. Label uniqueness — the core fix
// ---------------------------------------------------------------------------

describe("label uniqueness", () => {
  it("no two KPIs share the same es-AR label", () => {
    const labels = KPI_CATALOG_LIST.map((k) => k.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });
});

// ---------------------------------------------------------------------------
// 3. fetcherName uniqueness
// ---------------------------------------------------------------------------

describe("fetcherName uniqueness", () => {
  it("no two catalog entries point at the same fetcher", () => {
    const names = KPI_CATALOG_LIST.map((k) => k.fetcherName);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("findKpiByFetcherName resolves a known fetcher and misses an unknown one", () => {
    expect(findKpiByFetcherName("fetchRabiesCoverage")?.id).toBe("rabies_coverage_dogs_12m");
    expect(findKpiByFetcherName("fetchDoesNotExist")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. /gob home coverage — live grep of the page source
// ---------------------------------------------------------------------------

/**
 * Extract the named imports pulled from lib/analytics/{govt-home-kpis,
 * compliance-metrics,mortality-metrics} in a page source file.
 *
 * Matches `import { a, b } from "@/lib/analytics/<module>"` blocks (single- or
 * multi-line) and returns every `fetch*` identifier found inside them. This
 * intentionally does NOT match every `fetch*` identifier in the whole file
 * (e.g. fetchKpiTrend / fetchVisiblePendingRequests are sparkline/queue
 * helpers imported from other modules, not rate/coverage KPI fetchers).
 */
function fetchersImportedFromKpiModules(source: string): string[] {
  const KPI_MODULES = /@\/lib\/analytics\/(govt-home-kpis|compliance-metrics|mortality-metrics)/;
  const importBlockRe = /import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g;

  const found: string[] = [];
  for (const match of source.matchAll(importBlockRe)) {
    const [, names, modulePath] = match;
    if (!KPI_MODULES.test(modulePath)) continue;
    for (const name of names.split(",").map((n) => n.trim())) {
      if (/^fetch[A-Z]\w*$/.test(name)) found.push(name);
    }
  }
  return found;
}

describe("/gob home KPI coverage", () => {
  const gobHomeSource = readFileSync(path.join(process.cwd(), "app", "gob", "page.tsx"), "utf-8");
  const importedFetchers = fetchersImportedFromKpiModules(gobHomeSource);

  it("the page actually imports some KPI fetchers (sanity — catches a broken regex/path)", () => {
    expect(importedFetchers.length).toBeGreaterThan(0);
  });

  it("every KPI fetcher /gob home imports from a KPI module has a catalog entry", () => {
    const catalogFetchers = new Set(KPI_CATALOG_LIST.map((k) => k.fetcherName));
    const missing = importedFetchers.filter((name) => !catalogFetchers.has(name));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. The rabies disambiguation, specifically
// ---------------------------------------------------------------------------

describe("rabies coverage disambiguation (critique-govt-2026-07-03.md)", () => {
  it("rabies_coverage_dogs_12m and rabies_vaccination_rate_all_species have distinct labels", () => {
    const dogs = KPI_CATALOG.rabies_coverage_dogs_12m;
    const allSpecies = KPI_CATALOG.rabies_vaccination_rate_all_species;
    expect(dogs.label).not.toBe(allSpecies.label);
  });

  it("the two rabies KPIs point at different fetchers (confirming they are genuinely different computations)", () => {
    const dogs = KPI_CATALOG.rabies_coverage_dogs_12m;
    const allSpecies = KPI_CATALOG.rabies_vaccination_rate_all_species;
    expect(dogs.fetcherName).not.toBe(allSpecies.fetcherName);
  });

  it("the two rabies KPIs document different cadences (12m window vs all-time)", () => {
    const dogs = KPI_CATALOG.rabies_coverage_dogs_12m;
    const allSpecies = KPI_CATALOG.rabies_vaccination_rate_all_species;
    expect(dogs.cadence).not.toBe(allSpecies.cadence);
  });

  it("the two rabies KPIs differ on BOTH machine-readable disambiguation axes (window and species)", () => {
    const dogs = KPI_CATALOG.rabies_coverage_dogs_12m;
    const allSpecies = KPI_CATALOG.rabies_vaccination_rate_all_species;
    expect(dogs.window).toBe("12m");
    expect(allSpecies.window).toBe("all_time");
    expect(dogs.species).toBe("dogs");
    expect(allSpecies.species).toBe("all_species");
  });
});

// ---------------------------------------------------------------------------
// 6. formatKpiTarget — claim #6 (cursor red-team 2026-07-23): "meta X% (Ley Y)"
//    conflates a statute's OBLIGATION with a programmatic NUMBER the statute
//    never set. Every target-bearing entry declares a `sourceKind`.
// ---------------------------------------------------------------------------

describe("formatKpiTarget — law-vs-meta separation (claim #6)", () => {
  it("every target-bearing catalog entry declares a sourceKind", () => {
    for (const kpi of KPI_CATALOG_LIST) {
      if (!kpi.target) continue;
      expect(kpi.target.sourceKind, `${kpi.id} has a target but no sourceKind`).toBeDefined();
    }
  });

  it("programmatic-target renders the obligation and the number as SEPARATE facts (never 'meta X% (Ley Y)')", () => {
    const out = formatKpiTarget(
      {
        value: 80,
        source: "Ley 22.953 (vacunación antirrábica obligatoria)",
        sourceKind: "programmatic-target",
      },
      "percent",
    );
    expect(out).toBe(
      "Obligación: Ley 22.953 (vacunación antirrábica obligatoria) · Meta programática: 80%",
    );
    expect(out).not.toContain("meta 80% (Ley");
  });

  it("statutory-obligation keeps the number and law together (the number IS the legal literal)", () => {
    const out = formatKpiTarget(
      {
        value: 100,
        source: "Ley CABA 4078 / Ley Prov. 14.107",
        sourceKind: "statutory-obligation",
      },
      "percent",
    );
    expect(out).toBe("Meta: 100% — Ley CABA 4078 / Ley Prov. 14.107");
  });

  it("benchmark renders plainly (no legal weight to conflate)", () => {
    const out = formatKpiTarget(
      { value: 39, source: "benchmark RSPCA (Reino Unido)", sourceKind: "benchmark" },
      "percent",
    );
    // A source with its own parenthetical keeps it, and is no longer wrapped in
    // a second pair — this expectation used to read "…(benchmark RSPCA (Reino
    // Unido))", copied from the output rather than decided.
    expect(out).toBe("Meta: 39% — benchmark RSPCA (Reino Unido)");
  });

  it("never renders a source nested inside a second pair of parentheses", () => {
    // Catalog-wide, because the defect was systemic: five descriptors carry a
    // parenthetical inside `target.source`, and the briefing's highest-priority
    // alert was one of them. Asserting only the two hand-written cases above
    // would leave the next one to be found on a funcionario's screen.
    const rendered = Object.values(KPI_CATALOG)
      .filter((d) => d.target)
      .map((d) => ({ id: d.id, copy: formatKpiTarget(d.target as KpiTarget, d.unit) }));

    // Non-vacuity in two directions: the catalog must actually have targets,
    // and at least one of them must carry a parenthetical — otherwise this
    // fence would pass on a catalog where the hazard simply is not present.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.some((r) => r.copy.includes("("))).toBe(true);

    const nested = rendered.filter((r) => /\([^()]*\(/.test(r.copy));
    expect(nested.map((r) => `${r.id}: ${r.copy}`)).toEqual([]);
  });

  it("rabies_coverage_dogs_12m (law-sourced obligation, non-statutory %) is classified programmatic-target", () => {
    expect(KPI_CATALOG.rabies_coverage_dogs_12m.target?.sourceKind).toBe("programmatic-target");
  });

  // microchip_penetration was here too until 2026-08-17, on the premise that
  // its obligation was law-sourced and only the 80% was programmatic. The
  // legal research killed the premise: no Argentine norm mandates the chip
  // (engram legal/claims-refutadas-2026-08-17). "programmatic-target" is now
  // the WRONG kind for it, because formatKpiTarget prints the literal word
  // "Obligación:" ahead of the source for that kind — there is no obligation
  // to print. It is a benchmark: a goal with no legal weight to conflate.
  it("microchip_penetration is a benchmark — the target has no legal source at all", () => {
    expect(KPI_CATALOG.microchip_penetration.target?.sourceKind).toBe("benchmark");
    const target = KPI_CATALOG.microchip_penetration.target;
    expect(target && formatKpiTarget(target, "percent")).not.toContain("Obligación");
  });

  it("ppp_registry_compliance and rabies_observation_compliance_10d (100% IS the legal literal) are classified statutory-obligation", () => {
    expect(KPI_CATALOG.ppp_registry_compliance.target?.sourceKind).toBe("statutory-obligation");
    expect(KPI_CATALOG.rabies_observation_compliance_10d.target?.sourceKind).toBe(
      "statutory-obligation",
    );
  });
});
