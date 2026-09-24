// Scope-discipline linter for lib/analytics/** (task #57; territory widened
// from dashboards/ only to the whole directory 2026-07-28, plan unit H.6).
//
// Motivation: lib/analytics/dashboards/_scope.ts exists so every govt-facing
// dashboard fetcher enforces jurisdiction scope through ONE reviewed set of
// helpers (petsScopeClause, casesScopeClause, custodyDisputesScopeClause,
// petsCurrentJurisdictionClause). The 2026-07-04 scope-security review (Part
// A1/A2, see _scope.ts header) found and fixed a payload-vs-current-
// jurisdiction drift bug precisely because a fetcher had hand-rolled its own
// predicate instead of going through the shared helper. This linter makes
// that class of drift visible going forward: a raw `jurisdictionProvince` /
// `jurisdictionLocality` predicate — or a direct call to the lower-level
// `jurisdictionPairClause` — anywhere in a sibling dashboards/*.ts module is
// flagged, so new hand-rolled scope logic can't land silently. It does NOT
// forbid the pattern outright (existing occurrences are grandfathered in the
// baseline below); it forbids NEW, unreviewed occurrences.
//
// TERRITORY: lib/analytics/*.ts AND lib/analytics/dashboards/*.ts, excluding
// _scope.ts itself (the one sanctioned home for these predicates).
//
// The parent directory was added 2026-07-28 (plan unit H.6). Until then the
// fence globbed `lib/analytics/dashboards/*.ts` only — and five sibling modules
// one directory UP were hand-rolling exactly the predicates it exists to catch,
// completely unwatched: admin-metrics.ts, campaign-metrics.ts,
// analytics-ranking.ts, govt-home-kpis.ts, compliance-metrics.ts. The fence was
// not wrong; the code had moved and the glob had not. That is this wave's
// recurring shape (see also check-brand-casing's glob, widened the same week),
// and it is why SCANNED_GLOBS is exported and asserted by a test: a fence that
// silently stops matching reports "clean" forever, which is worse than no fence
// because it is believed.
//
// Still NOT scanned: lib/infra/case-queries.ts, outbox-query.ts,
// audit-history-query.ts, omnibox-search.ts, gob-pet-subview.ts. Those are a
// DIFFERENT domain (operator list-queries) that legitimately hand-rolls
// jurisdiction scoping via jurisdictionPairClause/jurisdictionScopeContains
// today, and are explicitly out of scope for this fence.
//
// -----------------------------------------------------------------------
// Extraction rules (regex-based, line-oriented — matches the sibling linters:
// check-authz-guards.ts, check-event-payload-parity.ts. Not a full AST
// analyzer; every current match in this repo was audited before landing).
// Comments are stripped first (line breaks preserved) so a prose mention of
// "jurisdictionProvince" in a doc comment never registers as an offense.
//
//   1. DIRECT CALL — any `jurisdictionPairClause(` call site. This helper is
//      deliberately low-level (parameterized by raw SQL operands); it should
//      only ever be invoked FROM a _scope.ts-exported wrapper, never from a
//      sibling module directly.
//
//   2. RAW eq() PREDICATE — `eq(...)` calls whose argument list references
//      `IDENT.jurisdictionProvince` or `IDENT.jurisdictionLocality` (in
//      either position — e.g. `eq(pets.jurisdictionProvince, x)` or
//      `eq(a, b.jurisdictionProvince)`). This is the hand-rolled equivalent
//      of what petsScopeClause/casesScopeClause already build.
//
//   3. RAW TEMPLATE PREDICATE — a `${IDENT.jurisdictionProvince}` /
//      `${IDENT.jurisdictionLocality}` interpolation inside a template
//      literal (the `sql\`${pets.jurisdictionProvince} = ${x}\`` shape used
//      throughout the admin-province-drilldown branches).
//
// Deliberately NOT flagged (false-positive classes audited out):
//   - SELECT-projection column refs, e.g. `.select({ jurisdictionProvince:
//     pets.jurisdictionProvince })` — naming/returning a column is not a
//     scope predicate.
//   - `.groupBy(cases.jurisdictionProvince)` — grouping does not restrict
//     which rows are visible; only WHERE-clause predicates do.
//   - Reading an already-fetched row's field back out, e.g.
//     `jurisdictionProvince: r.jurisdictionProvince ?? null` when building a
//     return object — passing an already-scoped value around, not a new
//     predicate.
//   - `import { jurisdictionPairClause } from "@/lib/metrics"` — an import
//     has no trailing `(`, so it never matches rule 1.
//   - Type declarations (`jurisdictionProvince: string | null;`) — these are
//     plain object-type members, never a `IDENT.jurisdictionProvince` member
//     expression, so no rule matches them.
//   - The outbreak_signal JSONB payload's snake_case
//     `pet_jurisdiction_province` / `pet_jurisdiction_locality` keys (an
//     event-time SNAPSHOT, a different concept from the live
//     pets/cases/welfareReports/custodyDisputes table columns this fence
//     guards) — the rules match the camelCase identifiers
//     `jurisdictionProvince`/`jurisdictionLocality` only, which never
//     collide with the snake_case payload keys.
//
// KNOWN LIMITATION: this is a per-line heuristic — it assumes `eq(...)` calls
// and `${...}` predicate interpolations referencing these columns are
// single-line in this codebase (true for every current occurrence). A
// hand-rolled predicate split across multiple lines would not be caught by
// rules 2/3 (though a `jurisdictionPairClause(` call itself is still caught
// by rule 1 regardless of how its arguments wrap).
//
// Run: pnpm tsx scripts/check-scope-discipline.ts   (or: pnpm lint:scope)
// Exits 0 clean; exits 1 listing each offending line, unless baselined.

import { globSync, readFileSync, writeFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

export const SCOPE_FILE = "lib/analytics/dashboards/_scope.ts";
export const BASELINE_FILE = "scripts/scope-discipline-baseline.json";

// ---------------------------------------------------------------------------
// Shared: comment stripping (preserves newlines so line numbers stay valid).
// Single source of truth: scripts/lib/strip-comments.mjs — re-exported here
// so existing `import { stripComments } from "./check-scope-discipline"`
// call sites (including this file's own test) keep working unchanged.
// ---------------------------------------------------------------------------

export { stripComments };

// ---------------------------------------------------------------------------
// Offense extraction — see header comment for the exact rules.
// ---------------------------------------------------------------------------

export type OffenseRule = "direct-pair-clause-call" | "raw-eq-predicate" | "raw-template-predicate";

export type Offense = {
  file: string;
  line: number;
  rule: OffenseRule;
  snippet: string;
};

const PAIR_CLAUSE_CALL_RE = /\bjurisdictionPairClause\s*\(/;
const EQ_JURISDICTION_RE = /\beq\([^;]*?\b\w+\.(?:jurisdictionProvince|jurisdictionLocality)\b/;
const TEMPLATE_JURISDICTION_RE = /\$\{\s*\w+\.(?:jurisdictionProvince|jurisdictionLocality)\s*\}/;

export function describeRule(rule: OffenseRule): string {
  switch (rule) {
    case "direct-pair-clause-call":
      return "direct call to jurisdictionPairClause() outside _scope.ts";
    case "raw-eq-predicate":
      return "raw eq() predicate on a jurisdictionProvince/jurisdictionLocality column";
    case "raw-template-predicate":
      return "raw sql-template predicate interpolating a jurisdictionProvince/jurisdictionLocality column";
  }
}

// Scans one already-comment-stripped file and returns every offending line.
// At most ONE offense per line (rules checked in priority order) — a line
// can only physically match one of these shapes in this codebase today.
export function extractOffenses(relPath: string, rawSrc: string): Offense[] {
  const src = stripComments(rawSrc);
  const lines = src.split("\n");
  const offenses: Offense[] = [];

  lines.forEach((lineText, idx) => {
    const line = idx + 1;
    if (PAIR_CLAUSE_CALL_RE.test(lineText)) {
      offenses.push({
        file: relPath,
        line,
        rule: "direct-pair-clause-call",
        snippet: lineText.trim(),
      });
      return;
    }
    if (EQ_JURISDICTION_RE.test(lineText)) {
      offenses.push({ file: relPath, line, rule: "raw-eq-predicate", snippet: lineText.trim() });
      return;
    }
    if (TEMPLATE_JURISDICTION_RE.test(lineText)) {
      offenses.push({
        file: relPath,
        line,
        rule: "raw-template-predicate",
        snippet: lineText.trim(),
      });
    }
  });

  return offenses;
}

/**
 * Every glob this fence scans. `lib/analytics/*.ts` was added 2026-07-28 (H.6)
 * because the fence had been guarding a directory the code had partly moved out
 * of — see the TERRITORY note in the header. Exported so a test can assert the
 * territory still covers both, which is the failure this whole wave keeps
 * finding: a fence whose glob quietly stops matching where the code lives.
 */
export const SCANNED_GLOBS = ["lib/analytics/*.ts", "lib/analytics/dashboards/*.ts"];

export function listScannedFiles(): string[] {
  const files = SCANNED_GLOBS.flatMap((g) => globSync(g));
  return [...new Set(files.map((f) => f.replaceAll("\\", "/")))]
    .filter((f) => f !== SCOPE_FILE)
    .filter((f) => !f.includes(".test."))
    .sort();
}

// ---------------------------------------------------------------------------
// Baseline — justified pre-existing exceptions, keyed by FILE + RULE COUNT.
//
// WHY counts, not file:line keys (2026-07-22 redesign): the original baseline
// was keyed `"relPath:line": "reason"`, which broke THREE times in one week —
// any edit ABOVE a grandfathered predicate shifted its line and the fence
// misread the shift as a new offense (surveillance.ts 524→546, then the C1
// metric-contract edits to analytics.ts, then Fase C's exports.ts changes).
// Counts per (file, rule) are line-shift-immune while keeping the ratchet
// honest: MORE occurrences than allowed fails (new drift), FEWER also fails
// (stale allowance — run --write-baseline to ratchet DOWN). Reasons live as
// per-file prose a reviewer can audit.
//
// Shape: { [relPath]: { reason: string, counts: { [rule]: number } } }
// Regenerate: pnpm tsx scripts/check-scope-discipline.ts --write-baseline
// (preserves existing reason strings; new files get a TODO reason that a
// human must replace before committing).
// ---------------------------------------------------------------------------

export type BaselineEntry = { reason: string; counts: Partial<Record<OffenseRule, number>> };
export type Baseline = Record<string, BaselineEntry>;

export function loadBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const RULES: OffenseRule[] = [
  "direct-pair-clause-call",
  "raw-eq-predicate",
  "raw-template-predicate",
];

function scanCounts(): {
  files: string[];
  perFile: Map<string, Map<OffenseRule, Offense[]>>;
  total: number;
} {
  const files = listScannedFiles();
  const perFile = new Map<string, Map<OffenseRule, Offense[]>>();
  let total = 0;
  for (const file of files) {
    const offenses = extractOffenses(file, readFileSync(file, "utf8"));
    total += offenses.length;
    const byRule = new Map<OffenseRule, Offense[]>();
    for (const o of offenses) {
      const list = byRule.get(o.rule) ?? [];
      list.push(o);
      byRule.set(o.rule, list);
    }
    if (offenses.length > 0) perFile.set(file, byRule);
  }
  return { files, perFile, total };
}

function writeBaseline(): void {
  const previous = loadBaseline();
  const { perFile } = scanCounts();
  const next: Baseline = {};
  for (const [file, byRule] of [...perFile.entries()].sort()) {
    const counts: Partial<Record<OffenseRule, number>> = {};
    for (const rule of RULES) {
      const n = byRule.get(rule)?.length ?? 0;
      if (n > 0) counts[rule] = n;
    }
    next[file] = {
      reason:
        previous[file]?.reason ??
        "TODO: audit these occurrences and replace this reason before committing.",
      counts,
    };
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ wrote ${BASELINE_FILE} — ${Object.keys(next).length} file(s).`);
}

function runScan(): void {
  const baseline = loadBaseline();
  const { files, perFile, total } = scanCounts();

  if (files.length === 0) {
    console.error(
      `✗ check-scope-discipline: found no files to scan under ${SCANNED_GLOBS.join(" or ")}.`,
    );
    process.exit(1);
  }

  const problems: string[] = [];
  let baselined = 0;

  for (const [file, byRule] of perFile.entries()) {
    const entry = baseline[file];
    for (const rule of RULES) {
      const offenses = byRule.get(rule) ?? [];
      const allowed = entry?.counts[rule] ?? 0;
      if (offenses.length > allowed) {
        const sample = offenses
          .slice(0, 3)
          .map((o) => `    ${o.file}:${o.line} \`${o.snippet}\``)
          .join("\n");
        problems.push(
          `${file} — ${offenses.length} ${describeRule(rule)} occurrence(s), baseline allows ${allowed}. Raw jurisdiction predicates outside ${SCOPE_FILE} have caused scope-security drift before (2026-07-04 review). Route NEW ones through a _scope.ts-exported helper, or if genuinely justified, regenerate with --write-baseline and update the file's reason.\n${sample}`,
        );
      } else if (offenses.length < allowed) {
        problems.push(
          `${file} — baseline allows ${allowed} ${describeRule(rule)} occurrence(s) but only ${offenses.length} remain. Ratchet down: run --write-baseline so the allowance can't silently rot.`,
        );
      } else {
        baselined += offenses.length;
      }
    }
  }

  for (const file of Object.keys(baseline)) {
    if (!perFile.has(file)) {
      problems.push(
        `${file} — baselined but has no occurrences (or no longer exists). Ratchet down: run --write-baseline.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n✗ scope-discipline drift (${files.length} files scanned, ${total} found).`);
    process.exit(1);
  }

  console.log(
    `✓ scope discipline clean — ${files.length} files scanned, ${total} raw jurisdiction references checked${
      baselined > 0 ? ` (${baselined} baselined by count)` : ""
    }.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-scope-discipline.ts") ||
    process.argv[1].endsWith("check-scope-discipline.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline();
  } else {
    runScan();
  }
}
