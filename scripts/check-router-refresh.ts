// Client-router navigation linter — CI guardrail for the nav burn-down (N2,
// 2026-07-04, dim-interno:docs/design/handoffs/2026-07-04-router-refresh-tiers.md).
//
// WHY: Next.js 15.5.x's App Router has a production-mode defect where a
// client-router transition (router.push / router.replace / router.refresh)
// can silently drop — the fetch resolves, but no history update and no
// re-render ever happen (engram #621/#622, verify-report #650 WARNING-1).
// Post-mutation UI truth therefore comes from either:
//   a) a FULL document navigation — navigateAfterActionSuccess() /
//      closeSheetNavWithFullReload() (lib/ui/full-page-action-nav.ts,
//      lib/ui/sheet-nav.ts), or
//   b) Tier B optimistic local state with revert-on-error.
//
// TWO RULES, TWO STRENGTHS
// ---------------------------------------------------------------------------
//   1. BAN — router.refresh() is never a safe substitute for either answer.
//      Zero call sites, empty allowlist, any new one fails the build.
//   2. RATCHET — router.push() / router.replace() are the SAME defect (the
//      docblock above has always said so) but they are also how a great deal of
//      ordinary navigation is written in this app. Failing all of them at once
//      would block every branch on a 25-call-site rewrite, so they are frozen
//      per file: the count may fall, never grow.
//
// Rule 2 is new as of 2026-08-05, and it closes a gap this file's own header
// created. The header named push and replace as the defect; the regex only ever
// matched `router.refresh(`. `pnpm lint:nav` printed "0 runtime router.refresh()
// calls" while 25 push/replace call sites sat in the tree — a fence narrower
// than its own doctrine, reporting success for the thing it was not measuring.
//
// Mechanics: scans production .ts/.tsx under app/, components/, src/ (tests
// excluded), strips comments (the SHARED stripper — scripts/lib/strip-comments.mjs),
// and matches on the stripped source. Comment mentions (e.g. the Tier C files
// documenting the ban: SheetMounter.tsx, MisTurnosSheetMounter.tsx,
// JurisdictionSwitcher.tsx) are fine — only runtime code is flagged.
//
// Run: pnpm tsx scripts/check-router-refresh.ts   (or: pnpm lint:nav)
//      pnpm tsx scripts/check-router-refresh.ts --write-baseline  (after a migration)
// Exits 1 with file:line on each hit. Exits 0 if clean.

import { globSync, readFileSync, writeFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Allowlist — relative paths (forward slashes) permitted to call
// router.refresh() at runtime. Empty by design: every call site was burned
// down in the 2026-07-04 N2 pass. Add an entry ONLY with a written
// justification for why neither a full document navigation nor optimistic
// local state can work, and link the discussion.
// ---------------------------------------------------------------------------
export const ROUTER_REFRESH_ALLOWLIST = new Set<string>([]);

const REFRESH_CALL = /\brouter\s*\.\s*refresh\s*\(|\buseRouter\s*\(\s*\)\s*\.\s*refresh\s*\(/;

// Rule 2: the two client-router transitions that CHANGE the URL. Same App
// Router defect, same silent-drop symptom; ratcheted rather than banned because
// they are load-bearing across the existing navigation surface.
const PUSH_REPLACE_CALL =
  /\brouter\s*\.\s*(?:push|replace)\s*\(|\buseRouter\s*\(\s*\)\s*\.\s*(?:push|replace)\s*\(/;

export const BASELINE_PATH = "scripts/router-nav-baseline.json";

type BaselineFile = {
  _comment: string;
  files: Record<string, number>;
};

export type Offender = { file: string; line: number; text: string };

/**
 * Comment stripping is the SHARED implementation (scripts/lib/strip-comments.mjs).
 *
 * This file used to carry its own line-based copy. That copy also blanked
 * everything after a `//` INSIDE a string literal, so a line like
 * `logUrl("a//b"); router.push("/x")` lost its `router.push(` and the fence went
 * quiet — a comment stripper that can delete real code is a fence that fails
 * OPEN. The shared version preserves string contents and substitutes whitespace
 * 1:1, so it is strictly the stricter of the two.
 */
export function findOffenders(relativePath: string, source: string): Offender[] {
  if (ROUTER_REFRESH_ALLOWLIST.has(relativePath)) return [];
  const offenders: Offender[] = [];
  const lines = stripComments(source).split("\n");
  lines.forEach((line, idx) => {
    if (REFRESH_CALL.test(line)) {
      offenders.push({ file: relativePath, line: idx + 1, text: line.trim() });
    }
  });
  return offenders;
}

/** router.push() / router.replace() call sites in one file (comments ignored). */
export function findNavCalls(relativePath: string, source: string): Offender[] {
  const offenders: Offender[] = [];
  const lines = stripComments(source).split("\n");
  lines.forEach((line, idx) => {
    if (PUSH_REPLACE_CALL.test(line)) {
      offenders.push({ file: relativePath, line: idx + 1, text: line.trim() });
    }
  });
  return offenders;
}

/** Compare live per-file counts against the frozen baseline. Only GROWTH fails. */
export function ratchetNavCalls(
  baseline: Record<string, number>,
  byFile: Record<string, Offender[]>,
): string[] {
  const problems: string[] = [];
  for (const [file, calls] of Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))) {
    const allowed = baseline[file];
    const sites = calls.map((c) => `      ${c.file}:${c.line}  ${c.text}`);
    if (allowed === undefined) {
      problems.push(
        [
          `✗ ${file} — ${calls.length} router.push()/replace() call(s) and this file is NOT baselined.`,
          "    Use navigateAfterActionSuccess() / closeSheetNavWithFullReload() for a full",
          "    document navigation, or Tier B optimistic local state with revert-on-error.",
          ...sites,
        ].join("\n"),
      );
    } else if (calls.length > allowed) {
      problems.push(
        [
          `✗ ${file} — ${calls.length} router.push()/replace() call(s), baselined at ${allowed}. The debt grew.`,
          ...sites,
        ].join("\n"),
      );
    }
  }
  return problems;
}

function isProductionSource(path: string): boolean {
  if (path.includes("__tests__")) return false;
  if (/\.test\.[jt]sx?$/.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  return true;
}

function readBaseline(): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile).files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every router.push()/replace() will fail.\n  Regenerate with: pnpm tsx scripts/check-router-refresh.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(byFile: Record<string, Offender[]>): void {
  const files: Record<string, number> = {};
  for (const [file, calls] of Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b))) {
    files[file] = calls.length;
  }
  const payload: BaselineFile = {
    _comment:
      "Client-router router.push()/router.replace() call sites (nav burn-down N2). " +
      "This is DEBT, not approval: Next.js 15.5.x can drop the transition and the user sees " +
      "nothing happen. Counts may only go DOWN. Regenerate after a migration with: " +
      "pnpm tsx scripts/check-router-refresh.ts --write-baseline",
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  console.log(`✓ Baseline written — ${Object.keys(files).length} file(s), ${total} call(s).`);
}

function main(argv: string[]): void {
  const files = [
    ...globSync("app/**/*.{ts,tsx}"),
    ...globSync("components/**/*.{ts,tsx}"),
    ...globSync("src/**/*.{ts,tsx}"),
  ]
    .map((p) => p.replaceAll("\\", "/"))
    .filter(isProductionSource)
    .sort();

  const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

  // ---- Rule 2 first: collect push/replace so --write-baseline can short-circuit.
  const navByFile: Record<string, Offender[]> = {};
  for (const [file, src] of sources) {
    const calls = findNavCalls(file, src);
    if (calls.length > 0) navByFile[file] = calls;
  }

  if (argv.includes("--write-baseline")) {
    writeBaseline(navByFile);
    return;
  }

  // ---- Rule 1: absolute ban on router.refresh().
  const offenders = files.flatMap((file) => findOffenders(file, sources.get(file) ?? ""));

  if (offenders.length > 0) {
    console.error("router.refresh() is banned in production code (nav burn-down N2).");
    console.error("Use navigateAfterActionSuccess() / closeSheetNavWithFullReload() for a full");
    console.error("document navigation, or Tier B optimistic local state with revert-on-error.");
    console.error("See dim-interno:docs/design/handoffs/2026-07-04-router-refresh-tiers.md.\n");
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.text}`);
    }
    process.exit(1);
  }

  // ---- Rule 2: ratchet on push/replace.
  const baseline = readBaseline();
  const problems = ratchetNavCalls(baseline, navByFile);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(
      [
        "",
        `✗ ${problems.length} file(s) grew the client-router navigation debt.`,
        "  router.push()/replace() carry the SAME App Router silent-drop defect as",
        "  router.refresh(); they are ratcheted rather than banned only because the",
        "  existing call sites have to be migrated flow by flow.",
        "  See dim-interno:docs/design/handoffs/2026-07-04-router-refresh-tiers.md.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const navTotal = Object.values(navByFile).reduce((a, c) => a + c.length, 0);
  const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
  console.log(
    `lint:nav OK — ${files.length} files scanned, 0 runtime router.refresh() calls; ` +
      `${navTotal} baselined router.push()/replace() call(s) across ${Object.keys(navByFile).length} file(s)` +
      `${navTotal < baselineTotal ? ` (down from ${baselineTotal}; run --write-baseline to lock it in)` : ""}.`,
  );
}

main(process.argv.slice(2));
