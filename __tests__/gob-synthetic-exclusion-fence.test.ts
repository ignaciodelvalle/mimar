// Fence: every raw jurisdiction-pair scope carries the synthetic-row exclusion
// (pilot item T1-P1, PO decision D3 2026-09-18).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The pilot runs in the environment that also holds the national demo seed
// (~41k seed-tagged pets and their reports). The exclusion lives INSIDE the
// table-aware scope helpers (lib/metrics/scope.ts `withoutSyntheticRows`), so a
// fetcher that scopes through a helper is clean without knowing it. The way to
// bypass it is to hand-roll a scope with the raw, table-blind primitive
// `jurisdictionPairClause(` — which is exactly how the /gob read paths were
// written before the helpers existed, and how a new one would be written in a
// hurry.
//
// THE RULE, per call site of `jurisdictionPairClause(` in lib/, src/, app/:
// within WINDOW lines of the call there must be ONE of
//   - `withoutSyntheticRows(` / `syntheticRowExclusion.` / `seesSyntheticRows(`
//     (the exclusion applied right there), or
//   - `// synthetic: covered — <fn> …` naming a function IN THE SAME FILE whose
//     body applies `withoutSyntheticRows(` (an inner jurisdiction-only helper
//     behind a wrapper) — checked, not trusted, or
//   - `// synthetic: exempt — <reason>` for a table that carries no seed marker
//     (organizations, service offerings, approval requests, assignments…).
//
// NON-VACUITY: a sweep that silently finds nothing reports "clean" forever, so
// the call-site count and the number of sites that really apply the exclusion
// both have floors, and named sites that must be in the sweep are asserted.
//
// The behaviour itself (a govt viewer sees exactly the real pet, admin sees
// both) is proven against the database in
// __tests__/gob-synthetic-exclusion.test.ts.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOTS = ["lib", "src", "app"];
const WINDOW = 12;
const CALL = "jurisdictionPairClause(";
const APPLIED = /withoutSyntheticRows\(|syntheticRowExclusion\.|seesSyntheticRows\(/;
const COVERED = /synthetic: covered — (\w+)/;
const EXEMPT = /synthetic: exempt — (\S.*)/;

type Site = {
  file: string;
  line: number;
  verdict: "applied" | "covered" | "exempt" | "missing";
  detail?: string;
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** The body of `function <name>(` in `source`, up to the next top-level function. */
function functionBody(source: string, name: string): string | null {
  const start = source.search(new RegExp(`function ${name}\\(`));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(export )?(async )?function \w+\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

function sweep(): Site[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(root, files);
  const sites: Site[] = [];
  for (const full of files) {
    const file = relative(".", full).replaceAll("\\", "/");
    const source = readFileSync(full, "utf8");
    if (!source.includes(CALL)) continue;
    const lines = source.split("\n");
    lines.forEach((text, i) => {
      if (!text.includes(CALL)) return;
      const trimmed = text.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
      if (text.includes("export function jurisdictionPairClause")) return;
      const window = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
      const covered = window.match(COVERED);
      const exempt = window.match(EXEMPT);
      let site: Site;
      if (APPLIED.test(window)) {
        site = { file, line: i + 1, verdict: "applied" };
      } else if (covered) {
        const body = functionBody(source, covered[1]);
        site = body?.includes("withoutSyntheticRows(")
          ? { file, line: i + 1, verdict: "covered", detail: covered[1] }
          : {
              file,
              line: i + 1,
              verdict: "missing",
              detail: `tag names ${covered[1]}, whose body does not apply withoutSyntheticRows`,
            };
      } else if (exempt) {
        site = { file, line: i + 1, verdict: "exempt", detail: exempt[1] };
      } else {
        site = { file, line: i + 1, verdict: "missing" };
      }
      sites.push(site);
    });
  }
  return sites;
}

const sites = sweep();

describe("synthetic-row exclusion fence (T1-P1)", () => {
  it("every raw jurisdictionPairClause scope applies the exclusion, is covered, or is exempt", () => {
    const missing = sites
      .filter((s) => s.verdict === "missing")
      .map((s) => `${s.file}:${s.line}${s.detail ? ` (${s.detail})` : ""}`);
    expect(missing).toEqual([]);
  });

  it("the sweep is not vacuous — it finds the call sites that exist today", () => {
    // 33 at the time of writing (2026-09-18). A floor, not an exact count: new
    // sites are welcome, a sweep that stops seeing them is not.
    expect(sites.length).toBeGreaterThanOrEqual(30);
    // Most of them must REALLY apply the exclusion — an exemption tag is a
    // statement about a table, and cannot be the common case.
    const real = sites.filter((s) => s.verdict === "applied" || s.verdict === "covered");
    expect(real.length).toBeGreaterThanOrEqual(20);
  });

  it("names the govt read paths the exclusion was written for", () => {
    const files = new Set(sites.filter((s) => s.verdict !== "exempt").map((s) => s.file));
    for (const file of [
      "lib/metrics/scope.ts", // petsScopeClause / petEventsScopeClause
      "lib/analytics/dashboards/_scope.ts", // cases / welfare / disputes / pets-current
      "src/modules/panorama/infrastructure/repository-scope.ts", // panorama loaders
      "lib/infra/case-queries.ts", // /gob/casos queue + count
      "lib/infra/outbox-query.ts", // /gob/outbox (ENO)
      "lib/analytics/senasa-export-query.ts", // SENASA export
      "lib/infra/omnibox-search.ts", // operator search
      "lib/metrics/observaciones-query.ts", // /gob/observaciones
      "app/gob/decomisos/page.tsx", // decomisos list
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it("every exemption states a reason", () => {
    for (const s of sites.filter((x) => x.verdict === "exempt")) {
      expect(s.detail?.length ?? 0, `${s.file}:${s.line}`).toBeGreaterThan(10);
    }
  });
});
