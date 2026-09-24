// File-size ratchet — CI guard (large-file burn-down).
//
// A handful of source files have grown past a reviewable size (the worst is
// components/panorama/PanoramaConsole.tsx at ~5.3k lines). Giant files hide
// bugs, blow up review diffs, and resist testing. This guard stops the bleed
// the same way check-design-tokens.ts and check-action-line-budget.ts do: with
// a RATCHET baseline.
//
// Rules (source files under app/, components/, lib/, packages/, src/ — .ts/.tsx,
// tests excluded. `packages/` joined the corpus on 2026-08-20 with the first
// workspace package: a new top-level source root that no fence globs is a
// silent hole, and this repo has been bitten by exactly that before):
//   (A) A file OVER THRESHOLD lines that is NOT in the baseline FAILS. New
//       large files are forbidden — split them from the start.
//   (B) A baselined file that GROWS beyond its recorded size + SLACK FAILS.
//       Grandfathered debt may only shrink or stay flat, never accrete more.
//   (C) A baselined file now AT/UNDER THRESHOLD is reported as ready to drop
//       from the baseline (the ratchet only ever tightens). Not a failure —
//       the script prints the exact lines to delete.
//
// Baseline: scripts/file-size-baseline.json — regenerate with
//   pnpm tsx scripts/check-file-size.ts --write-baseline
// (records every current over-threshold file at its measured line count).
//
// Run: pnpm tsx scripts/check-file-size.ts   (or: pnpm lint:file-size)
// Exits 0 when clean; exits 1 listing each offending file.

import { globSync, readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Line count above which a source file must be grandfathered to pass. */
const THRESHOLD = 1500;

/** Extra lines a baselined file may gain before rule (B) fails. Small enough to
 *  block real bloat, large enough that a routine edit to a huge file doesn't
 *  trip CI mid-refactor. */
const GROWTH_SLACK = 25;

const BASELINE_PATH = "scripts/file-size-baseline.json";

/** Source roots to scan. Tests, generated files, and non-source dirs excluded. */
const SOURCE_GLOB = "{app,components,lib,packages,src}/**/*.{ts,tsx}";

const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BaselineFile = {
  _meta: {
    generatedAt: string;
    threshold: number;
    description: string;
  };
  files: Record<string, number>;
};

export type SizeViolation = {
  file: string;
  kind: "new-too-large" | "baselined-grew";
  actual: number;
  limit: number;
};

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

/** Line count using the `wc -l` convention (trailing newline adds no line). */
export function countLines(src: string): number {
  const n = src.split("\n").length;
  return src.endsWith("\n") ? n - 1 : n;
}

/**
 * Compare measured file sizes against the baseline.
 * Returns violations (rule A + B) and stale entries (rule C).
 */
export function checkFileSizes(
  baseline: Record<string, number>,
  files: Array<{ name: string; lines: number }>,
): { violations: SizeViolation[]; staleBaselineEntries: string[] } {
  const violations: SizeViolation[] = [];

  for (const { name, lines } of files) {
    const recorded = baseline[name];
    if (recorded === undefined) {
      // (A) Not baselined — must stay at/under threshold.
      if (lines > THRESHOLD) {
        violations.push({ file: name, kind: "new-too-large", actual: lines, limit: THRESHOLD });
      }
    } else {
      // (B) Baselined — must not grow beyond recorded + slack.
      const limit = recorded + GROWTH_SLACK;
      if (lines > limit) {
        violations.push({ file: name, kind: "baselined-grew", actual: lines, limit });
      }
    }
  }

  // (C) Baselined files that have dropped to/under threshold can be removed.
  const measured = new Map(files.map((f) => [f.name, f.lines]));
  const staleBaselineEntries = Object.keys(baseline).filter((name) => {
    const lines = measured.get(name);
    return lines !== undefined && lines <= THRESHOLD;
  });

  return { violations, staleBaselineEntries };
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function isTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function collectSourceFiles(): Array<{ name: string; lines: number }> {
  return globSync(SOURCE_GLOB)
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"))
    .filter((f) => !isTestFile(f))
    .map((name) => ({ name, lines: countLines(readFileSync(name, "utf8")) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadBaseline(): Record<string, number> {
  try {
    const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
    return data.files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — every over-${THRESHOLD}-line file will fail. Regenerate with: pnpm tsx scripts/check-file-size.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(files: Array<{ name: string; lines: number }>): void {
  const over = files.filter((f) => f.lines > THRESHOLD).sort((a, b) => b.lines - a.lines);
  const baseline: BaselineFile = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      threshold: THRESHOLD,
      description:
        `Files over ${THRESHOLD} lines are grandfathered at the recorded count. ` +
        `New over-threshold files, or baselined files growing past recorded+${GROWTH_SLACK}, ` +
        `fail lint:file-size. A baselined file that drops to/under ${THRESHOLD} should be removed.`,
    },
    files: Object.fromEntries(over.map((f) => [f.name, f.lines])),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`✓ Wrote ${over.length} over-${THRESHOLD}-line file(s) to ${BASELINE_PATH}.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runChecks(): void {
  const files = collectSourceFiles();
  const baseline = loadBaseline();
  const { violations, staleBaselineEntries } = checkFileSizes(baseline, files);

  for (const v of violations) {
    if (v.kind === "new-too-large") {
      console.error(
        `${v.file}: ${v.actual} lines — over the ${THRESHOLD}-line limit and not baselined. Split it into smaller modules. (New large files are forbidden.)`,
      );
    } else {
      console.error(
        `${v.file}: ${v.actual} lines — baselined debt is growing (limit ${v.limit}). Shrink it or split it; do not feed a file that is already too large.`,
      );
    }
  }

  if (staleBaselineEntries.length > 0) {
    console.warn(
      `\n[info] ${staleBaselineEntries.length} baselined file(s) are now at/under ${THRESHOLD} lines. ` +
        `Remove them from ${BASELINE_PATH} to tighten the ratchet:`,
    );
    for (const name of staleBaselineEntries) console.warn(`  - "${name}"`);
    console.warn("Or regenerate: pnpm tsx scripts/check-file-size.ts --write-baseline");
  }

  if (violations.length > 0) {
    console.error(`\n✗ ${violations.length} file-size violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓ File sizes clean — ${Object.keys(baseline).length} file(s) grandfathered over ${THRESHOLD} ` +
      `lines; no new offenders, no baselined bloat across ${files.length} source files.`,
  );
}

// Only run when invoked as a CLI (tsx / pnpm lint:file-size). Importing this
// module from unit tests must not trigger the scan or process.exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-file-size.ts") ||
    process.argv[1].endsWith("check-file-size.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(collectSourceFiles());
  } else {
    runChecks();
  }
}
