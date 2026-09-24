// Offline guard for the scope-discipline fence (scripts/check-scope-discipline.ts).
//
// WHY THIS TEST EXISTS
// ---------------------------------------------------------------------------
// The fence itself was never the problem — its GLOB was. It guarded
// `lib/analytics/dashboards/*.ts` while nine sibling modules one directory up
// hand-rolled the exact predicates it exists to catch, and it reported "clean"
// the whole time. Widening the glob (2026-07-28, plan unit H.6) turned 2
// watched occurrences into 44.
//
// A fence that silently stops matching is worse than no fence, because it is
// believed. So the territory is asserted here by NAMING files that must be in
// it: if someone narrows the glob back, `listScannedFiles()` stops returning
// `lib/analytics/govt-home-kpis.ts` and this test fails loudly. Asserting
// `SCANNED_GLOBS` against its own literal value would prove nothing — it would
// only restate the source.

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BASELINE_FILE,
  type Baseline,
  SCOPE_FILE,
  extractOffenses,
  listScannedFiles,
  stripComments,
} from "@/scripts/check-scope-discipline";

const scanned = listScannedFiles();

describe("territory — the glob covers where the code actually lives", () => {
  it("scans the dashboards directory the fence was written for", () => {
    expect(scanned).toContain("lib/analytics/dashboards/surveillance.ts");
  });

  it("scans lib/analytics/*.ts, where nine modules hid from it until H.6", () => {
    // Each of these was flagged the moment the glob widened. Naming them means
    // a narrowed glob cannot pass this test quietly.
    for (const file of [
      "lib/analytics/govt-home-kpis.ts",
      "lib/analytics/analytics-ranking.ts",
      "lib/analytics/campaign-metrics.ts",
      "lib/analytics/senasa-export-query.ts",
      "lib/analytics/surveillance-metrics.ts",
    ]) {
      expect(scanned).toContain(file);
    }
  });

  it("every scanned path really exists — a glob can match nothing and still 'pass'", () => {
    expect(scanned.length).toBeGreaterThan(20);
    for (const file of scanned) expect(existsSync(file)).toBe(true);
  });

  it("excludes _scope.ts, the one sanctioned home for these predicates", () => {
    expect(scanned).not.toContain(SCOPE_FILE);
  });

  it("excludes test files", () => {
    expect(scanned.filter((f) => f.includes(".test."))).toEqual([]);
  });
});

describe("extraction rules", () => {
  it("flags a direct jurisdictionPairClause() call", () => {
    const offenses = extractOffenses("x.ts", "const c = jurisdictionPairClause(js, a, b);");
    expect(offenses.map((o) => o.rule)).toEqual(["direct-pair-clause-call"]);
  });

  it("flags a raw eq() predicate on a jurisdiction column", () => {
    const offenses = extractOffenses("x.ts", "conditions.push(eq(pets.jurisdictionProvince, p));");
    expect(offenses.map((o) => o.rule)).toEqual(["raw-eq-predicate"]);
  });

  it("flags a raw sql-template predicate", () => {
    const offenses = extractOffenses("x.ts", "sql`${pets.jurisdictionLocality} = ${loc}`");
    expect(offenses.map((o) => o.rule)).toEqual(["raw-template-predicate"]);
  });

  it("does not flag prose — the fence's own doctrine is written in comments", () => {
    const src = [
      "// Never call jurisdictionPairClause(...) outside _scope.ts, and never",
      "// hand-roll eq(pets.jurisdictionProvince, x) here.",
      "const safe = petsScopeClause(actor);",
    ].join("\n");
    expect(extractOffenses("x.ts", src)).toEqual([]);
  });

  it("does not flag a select projection or a groupBy", () => {
    const src = [
      ".select({ jurisdictionProvince: pets.jurisdictionProvince })",
      ".groupBy(cases.jurisdictionProvince)",
    ].join("\n");
    expect(extractOffenses("x.ts", src)).toEqual([]);
  });

  it("reports the line number of the offending line, not of the file", () => {
    const src = ["const a = 1;", "const b = 2;", "eq(pets.jurisdictionLocality, l);"].join("\n");
    expect(extractOffenses("x.ts", src)[0]?.line).toBe(3);
  });

  it("KNOWN LIMITATION: a non-SQL template literal is flagged too", () => {
    // welfare-exports.ts:185 builds a display label, not a query. Rule 3 cannot
    // tell a sql`` tag from an ordinary template, so this over-reports into the
    // audited baseline rather than being special-cased — narrowing the rule
    // would create a hiding place. Asserted so the behaviour is a decision on
    // record, not a surprise the next reader has to rediscover.
    const src = "const label = `Unidad Fiscal — ${report.jurisdictionProvince}`;";
    expect(extractOffenses("x.ts", src).map((o) => o.rule)).toEqual(["raw-template-predicate"]);
  });
});

describe("stripComments preserves line numbers", () => {
  it("keeps the same number of lines so offense lines stay accurate", () => {
    const src = ["/* a\n   multi-line\n   comment */", "eq(pets.jurisdictionProvince, p);"].join(
      "\n",
    );
    expect(stripComments(src).split("\n")).toHaveLength(src.split("\n").length);
  });
});

describe("the baseline is an audited list, not a dumping ground", () => {
  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));

  it("carries a real reason for every entry — never the generated TODO", () => {
    for (const [file, entry] of Object.entries(baseline)) {
      expect(entry.reason, `${file} still has the placeholder reason`).not.toMatch(/^TODO/);
      expect(entry.reason.length, `${file}'s reason is too short to be an audit`).toBeGreaterThan(
        80,
      );
    }
  });

  it("every baselined file is one the fence actually scans", () => {
    // A baseline entry for an unscanned path is dead weight that reads as
    // coverage — the same lie the narrowed glob told.
    for (const file of Object.keys(baseline)) expect(scanned).toContain(file);
  });

  it("records the lib/analytics debt the widened glob exposed", () => {
    expect(Object.keys(baseline)).toContain("lib/analytics/govt-home-kpis.ts");
    const counts = baseline["lib/analytics/govt-home-kpis.ts"]?.counts ?? {};
    const total = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(total).toBeGreaterThan(10);
  });
});
