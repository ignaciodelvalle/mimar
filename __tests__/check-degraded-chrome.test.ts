/**
 * Tests for scripts/check-degraded-chrome.ts.
 *
 * The planted-violation tests take a REAL screen off disk and cut one line out
 * of it. The detector never sees text this file wrote, so it cannot pass by
 * agreeing with a reimplementation of its own rule — the failure mode
 * docs/agents/README.md names as "no self-referential assertions".
 *
 * Each mutation asserts `expect(mutated).not.toBe(original)` FIRST. Without
 * that, refactoring the reference screen would silently turn the mutation into
 * a no-op and the test would keep passing while verifying nothing.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { stripNonCode } from "@/scripts/check-db-budget";
import {
  MIN_DEGRADED_BRANCHES,
  MIN_FILTER_BAR_SCREENS,
  UNBUDGETED,
  budgetBindings,
  chromeVocabulary,
  degradedBranches,
  designSystemChrome,
  elementSource,
  findMissingChrome,
  findUnbudgetedScreen,
  isFilterBarScreen,
  localChrome,
  readBaseline,
  scanAll,
  taintedNames,
} from "@/scripts/check-degraded-chrome";

const CANONICAL = "app/gob/censo/CensoScreen.tsx";
const HELPER_SHAPED = "app/org/[orgToken]/page.tsx";
const TAINTED = "app/admin/auditoria/AuditoriaScreen.tsx";

const DS = designSystemChrome();

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("chrome vocabulary — computed, not hardcoded", () => {
  it("derives the design-system chrome from components/ui/dashboard/index.ts", () => {
    expect(DS.has("ScreenHeader")).toBe(true);
    expect(DS.has("OpFilterBar")).toBe(true);
    expect(DS.has("ViewScopeCaption")).toBe(true);
  });

  // A `<thead>` cell cannot outlive the table whose rows failed to load.
  it("excludes OpSortHeader — that is table furniture, not page chrome", () => {
    expect(DS.has("OpSortHeader")).toBe(false);
  });

  it("picks up file-local chrome from the scanned file's own imports", () => {
    const src = `import { OrgMascotasFilterBar } from "./OrgMascotasFilterBar";
import { PetSearchInput } from "./_components/PetSearchInput";
import { somethingElse } from "./x";`;

    expect([...localChrome(src)].sort()).toEqual(["OrgMascotasFilterBar", "PetSearchInput"]);
  });
});

describe("the anchor is the budget-wrapper binding", () => {
  it("binds the name a budget wrapper's result is assigned to", () => {
    expect(budgetBindings(stripNonCode(read(CANONICAL)))).toContain("load");
  });

  // This is what keeps auth/capability early returns out WITHOUT an allowlist.
  it("ignores an `if (!x.ok)` whose x is not a budget-wrapper result", () => {
    const code = `const access = await requireOrgAccess(t);
  if (!access.ok) return <div>Permiso requerido</div>;`;

    expect(degradedBranches(code)).toEqual([]);
  });
});

describe("planted violations — the detector must still detect", () => {
  it("fires when the canonical screen stops hoisting its filters row", () => {
    const original = read(CANONICAL);
    const mutated = original.replace(/^\s*\{filtersRow\}\n/m, "");

    expect(mutated).not.toBe(original);
    expect(findMissingChrome(CANONICAL, original, DS)).toEqual([]);
    expect(findMissingChrome(CANONICAL, mutated, DS).map((m) => m.name)).toContain("OpFilterBar");
  });

  it("fires when the canonical screen stops hoisting its header", () => {
    const original = read(CANONICAL);
    const mutated = original.replace(/^\s*\{header\}\n/m, "");

    expect(mutated).not.toBe(original);
    expect(findMissingChrome(CANONICAL, mutated, DS).map((m) => m.name)).toContain("ScreenHeader");
  });
});

describe("hoisted-variable expansion", () => {
  // The canonical shape renders {header} in both branches, so the literal
  // <ScreenHeader> appears once, ABOVE the load. Comparing raw text would call
  // the reference implementation a violation.
  it("does not flag the canonical screen, whose chrome is behind {header}", () => {
    expect(findMissingChrome(CANONICAL, read(CANONICAL), DS)).toEqual([]);
  });

  // `return degradedPanel(load.reason);` — a bare call, no JSX braces. Missing
  // this shape reported three real branches of the org home as violations.
  it("resolves a degraded branch factored into a helper call", () => {
    expect(findMissingChrome(HELPER_SHAPED, read(HELPER_SHAPED), DS)).toEqual([]);
  });
});

describe("taint — both directions, or the fence is a no-op", () => {
  const code = stripNonCode(read(TAINTED));

  // Seeded through `const { …, actorOptions }: AuditData = load.value;` — the
  // type annotation between the pattern and the `=` is what the seed used to
  // choke on.
  it("seeds through a destructuring with a type annotation", () => {
    expect(taintedNames(code, "load").has("actorOptions")).toBe(true);
  });

  it("does not taint a name resolved before the load", () => {
    const tainted = taintedNames(code, "load");
    expect(tainted.has("fromValid")).toBe(false);
    expect(tainted.has("toValid")).toBe(false);
  });

  it("reads a whole element, children included, when deciding dependence", () => {
    const jsx = "<OpFilterBar axes={[{ options: actorOptions }]}><Child /></OpFilterBar>";
    expect(elementSource(jsx, "OpFilterBar")).toContain("actorOptions");
  });
});

// Decision 5 (T1-L6). The three screens that had NO wrapper, and so no branch
// for decisions 1-4 to judge, are the reference: each must now pass both
// halves, and each must go red the moment its wrapper is taken away.
const T1_L6_SCREENS = [
  "app/admin/casos/page.tsx",
  "app/admin/historial/ActividadScreen.tsx",
  "app/gob/historial/page.tsx",
] as const;

describe("a filter-bar screen with no budget wrapper is an offender", () => {
  for (const file of T1_L6_SCREENS) {
    it(`${file} is a filter-bar screen, budgeted, and keeps its chrome degraded`, () => {
      const src = read(file);
      expect(isFilterBarScreen(src, DS)).toBe(true);
      expect(findUnbudgetedScreen(file, src, DS)).toBeNull();
      expect(degradedBranches(stripNonCode(src)).length).toBeGreaterThan(0);
      expect(findMissingChrome(file, src, DS)).toEqual([]);
    });

    it(`${file} goes red when its wrapper is removed`, () => {
      const original = read(file);
      const mutated = original.replace(/await loadWithTimeout\(/, "await (");

      expect(mutated).not.toBe(original);
      expect(findUnbudgetedScreen(file, mutated, DS)).toEqual({
        file,
        binding: "",
        name: UNBUDGETED,
      });
    });

    it(`${file} goes red when its degraded branch drops the filter bar`, () => {
      const original = read(file);
      // The degraded branch is the FIRST `{filterBar(` in each of the three.
      const mutated = original.replace(/\{filterBar\(/, "{void (");

      expect(mutated).not.toBe(original);
      expect(findMissingChrome(file, mutated, DS).map((m) => m.name)).toContain("OpFilterBar");
    });
  }

  it("does not count a page whose only chrome is an <h1>", () => {
    const src = `export default async function P() {
  const rows = await loadRows();
  return <h1>Hola {rows.length}</h1>;
}`;
    expect(isFilterBarScreen(src, DS)).toBe(false);
  });

  it("does not count a filter bar whose only await is the route's own props", () => {
    const src = `import { OpFilterBar } from "@/components/ui/dashboard";
export default async function P({ searchParams }) {
  const sp = await searchParams;
  return <OpFilterBar axes={[]} />;
}`;
    expect(isFilterBarScreen(src, DS)).toBe(false);
  });
});

// scanAll() walks the repo per call — gate 0901f measured this test at
// 3218ms clean; 30s matches the repo's convention for machine-bound suites
// and leaves ample margin without weakening hang detection.
const SCAN_BUDGET = { timeout: 30_000 };

describe("anti-vacuity", SCAN_BUDGET, () => {
  // Rename a wrapper and the anchor stops matching; without this the check
  // prints "clean" having judged nothing. Three fences did exactly that.
  it("scans a corpus well above the floor", () => {
    const { branches, files, filterBarScreens } = scanAll();
    expect(files).toBeGreaterThan(0);
    expect(branches).toBeGreaterThanOrEqual(MIN_DEGRADED_BRANCHES);
    expect(filterBarScreens).toBeGreaterThanOrEqual(MIN_FILTER_BAR_SCREENS);
  });

  it("has a vocabulary to compare against at all", () => {
    expect(chromeVocabulary(read(CANONICAL), DS).size).toBeGreaterThan(0);
  });
});

describe("the baseline is documented, not just counted", () => {
  it("gives every exemption a written reason and at least one chrome name", () => {
    for (const [file, entry] of Object.entries(readBaseline())) {
      expect(entry.chrome.length, `${file} exempts nothing`).toBeGreaterThan(0);
      expect(entry.reason.length, `${file} has no reason`).toBeGreaterThan(40);
      expect(entry.reason, `${file} still has a TODO reason`).not.toMatch(/^TODO/);
    }
  });
});
