// Case open-reason bypass guard.
//
// WHY THIS EXISTS
// ---------------
// transfer-custody.ts — the change of legal responsible, the most consequential
// write in the system — passed a bare template string as its case open reason
// for months. Nothing type-checked it, so a funcionario read:
//
//     "Apertura automática — direct custody handoff to_role=owner"
//
// English plus a raw enum key, wrapped in a Spanish prefix so it read like a
// translation and nobody looked twice. `OpenCaseInput.openedReason` is now a
// closed Zod union, so `tsc` catches that class outright.
//
// WHAT tsc ALREADY COVERS (so this script does NOT)
//   - an unmapped code           → mapped-Record error in opened-reason-render.ts
//   - a code with no prose       → same, in opened-reason-prose.ts
//   - a bare string at openCase  → OpenCaseInput.openedReason is the union
//
// WHAT THIS SCRIPT COVERS — BYPASS. The one thing a type system cannot: going
// AROUND the choke point rather than through it. Three rules:
//
//   1. No string/template literal assigned to `openedReason:` outside
//      opened-reason-prose.ts. That is writer #19 reaching for the old habit.
//   2. No direct `db.insert(cases)` writing opened_reason outside
//      cases-repository.ts. That skips the dual-write entirely, producing a row
//      with prose and no code — indistinguishable from a legacy row, forever.
//   3. The frozen legacy rule count never grows. A 17th regex means someone
//      routed a NEW writer down the path reserved for historical prose.
//
// STATIC-ANALYSIS SCOPE (precision over recall — same posture as
// scripts/check-metric-labels.ts): only literal `openedReason: "..."` /
// `openedReason: \`...\`` assignments are flagged. `openedReason: someVar` is
// skipped — unverifiable without a type-checker, and tsc already types it.
//
// Run: pnpm tsx scripts/check-opened-reason-coverage.ts
// Or:  pnpm lint:opened-reason
//
// Exits 1 with file:line on each hit. Exits 0 if clean.

import { globSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// The three files that are ALLOWED to do what the rules forbid
// ---------------------------------------------------------------------------

/** The only module that may build open-reason prose from string literals. */
const PROSE_MODULE = "src/modules/cases/domain/opened-reason-prose.ts";

/** The only module that may write the opened_reason columns. */
const CASES_REPOSITORY = "src/modules/cases/infrastructure/cases-repository.ts";

/** The frozen regex layer. Its rule count is pinned below. */
const LEGACY_MODULE = "src/modules/cases/domain/opened-reason-legacy.ts";

/**
 * The number of writer grammars frozen at the 2026-07-16 cutover. THIS NUMBER
 * NEVER GROWS. It is not a budget — it is a statement that the legacy path is
 * closed. A new writer needs a union member and a renderer, not a 17th regex.
 */
const FROZEN_LEGACY_RULE_COUNT = 16;

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export type Violation = { file: string; line: number; rule: 1 | 2 | 3; detail: string };

// ---------------------------------------------------------------------------
// Rule 1 — literal prose assigned to openedReason outside the prose module
// ---------------------------------------------------------------------------

// `openedReason:` followed by a double-quoted string or a backtick template.
const LITERAL_OPENED_REASON = /openedReason:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;

export function scanRule1(relPath: string, content: string): Violation[] {
  if (relPath === PROSE_MODULE) return [];
  const out: Violation[] = [];
  for (const m of content.matchAll(LITERAL_OPENED_REASON)) {
    const line = content.slice(0, m.index).split("\n").length;
    out.push({
      file: relPath,
      line,
      rule: 1,
      detail: `openedReason assigned a string literal: ${m[1].slice(0, 60)}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2 — direct writes to the opened_reason columns outside the repository
// ---------------------------------------------------------------------------

const INSERT_CASES = /\.insert\(\s*cases\s*\)/;
const OPENED_REASON_COLUMN = /\bopenedReason\s*:|\bopened_reason\b/;

export function scanRule2(relPath: string, content: string): Violation[] {
  if (relPath === CASES_REPOSITORY) return [];
  const out: Violation[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!INSERT_CASES.test(lines[i])) continue;
    // Look ahead through the .values({...}) chain for an opened_reason write.
    const window = lines.slice(i, i + 30).join("\n");
    if (OPENED_REASON_COLUMN.test(window)) {
      out.push({
        file: relPath,
        line: i + 1,
        rule: 2,
        detail: "db.insert(cases) writes opened_reason directly, skipping the dual-write",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 3 — the frozen legacy rule count
// ---------------------------------------------------------------------------

export function scanRule3(relPath: string, content: string): Violation[] {
  if (relPath !== LEGACY_MODULE) return [];
  const actual = (content.match(/^\s{4}pattern:\s*\//gm) ?? []).length;
  if (actual === FROZEN_LEGACY_RULE_COUNT) return [];
  return [
    {
      file: relPath,
      line: 1,
      rule: 3,
      detail: `the FROZEN legacy path has ${actual} regex rules, expected ${FROZEN_LEGACY_RULE_COUNT}. ${
        actual > FROZEN_LEGACY_RULE_COUNT
          ? "A rule was ADDED: that path renders PRE-cutover prose only and is closed to new writers."
          : "A rule was REMOVED: pre-cutover rows still need it and can never be backfilled."
      }`,
    },
  ];
}

export function scanFile(relPath: string, content: string): Violation[] {
  return [
    ...scanRule1(relPath, content),
    ...scanRule2(relPath, content),
    ...scanRule3(relPath, content),
  ];
}

// ---------------------------------------------------------------------------
// Scan targets
// ---------------------------------------------------------------------------

const SCAN_FILES = globSync("{app,components,lib,packages,src,scripts}/**/*.{ts,tsx}").filter(
  (f) => {
    const p = normalizeRelPath(f);
    if (p.includes("node_modules/")) return false;
    // This file. It necessarily contains the patterns it hunts — in its own
    // regexes and in the docblock explaining them. A guard that flags itself is
    // just noise, and worse, it trains people to ignore the output.
    if (p === "scripts/check-opened-reason-coverage.ts") return false;
    // Test fixtures legitimately construct rows by hand (and are typed by tsc
    // through the same union). The guard is about production write paths.
    if (p.includes("__tests__/") || p.endsWith(".test.ts") || p.endsWith(".test.tsx")) return false;
    // db/seed scripts insert historical/demo rows directly and predate the union.
    if (p.startsWith("scripts/seed")) return false;
    return true;
  },
);

function runScan(): void {
  const violations: Violation[] = [];
  let sawLegacyModule = false;

  for (const file of SCAN_FILES) {
    const relPath = normalizeRelPath(file);
    if (relPath === LEGACY_MODULE) sawLegacyModule = true;
    violations.push(...scanFile(relPath, readFileSync(file, "utf8")));
  }

  // The frozen module vanishing would silently disable rule 3.
  if (!sawLegacyModule) {
    console.error(
      `\n✗ ${LEGACY_MODULE} not found. It renders every pre-cutover case row and cannot be deleted — those rows have no structured code and never will (backfilling audit prose is a retro-edit).`,
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    const byRule = {
      1: "Rule 1 — open-reason prose belongs in opened-reason-prose.ts, keyed by code",
      2: `Rule 2 — only ${CASES_REPOSITORY} may write the opened_reason columns`,
      3: "Rule 3 — the legacy regex path is FROZEN",
    } as const;
    for (const rule of [1, 2, 3] as const) {
      const hits = violations.filter((v) => v.rule === rule);
      if (!hits.length) continue;
      console.error(`\n✗ ${byRule[rule]}:`);
      for (const v of hits) console.error(`  ${v.file}:${v.line}  ${v.detail}`);
    }
    console.error(
      `\n✗ ${violations.length} open-reason bypass violation(s). Every case-open goes through CasesRepository.openCase with an OpenedReason from src/modules/cases/domain/opened-reason.ts. Need a new reason? Add a union member — tsc will then require a renderer and a prose template. Do not hand-write the string; that is the bug this fence exists to prevent.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ open-reason fence clean — ${SCAN_FILES.length} files scanned, legacy path frozen at ${FROZEN_LEGACY_RULE_COUNT} rules.`,
  );
}

if (process.argv[1]?.includes("check-opened-reason-coverage")) {
  runScan();
}
