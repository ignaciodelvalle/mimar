// lib/ root-file ratchet — CI guard (F2 bucketize setup).
//
// Enforces that no NEW .ts files are added at the lib/ root while the
// bucketize migration is in progress (see
// docs/superpowers/plans/2026-06-26-lib-bucketize-plan.md).
//
// Rule:
//   Any .ts file found directly under lib/ (not in a subdir) MUST appear
//   in the baseline (scripts/lib-root-baseline.json).  If a file is new —
//   i.e. not in the baseline and not already in a lib/<subdir>/ — this
//   script exits 1.
//
//   .test.ts files are allowed to follow their sibling: if "foo.ts" is
//   baselined, "foo.test.ts" is also treated as allowed regardless of
//   whether it appears in the baseline (handles the common "test file
//   created alongside its sibling" pattern).
//
// The baseline was recorded on 2026-06-26 (branch integration/session-review)
// and contains all 208 .ts files then present at lib/ root.  New lib code
// MUST go into a subdir (lib/domain/, lib/infra/, lib/reference/, etc.).
// Existing root files are expected to migrate gradually; as each file moves
// out, it is simply removed from the baseline in the same PR that moves it.
//
// Run: pnpm tsx scripts/check-lib-root-files.ts   (or: pnpm lint:lib-root)
// Exits 0 when clean; exits 1 listing each unexpected root-level file.
//
// Regex-based, not a full AST analyzer — mirrors the sibling linters
// (check-dependency-direction.ts, check-action-line-budget.ts, etc.).

import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASELINE_PATH = "scripts/lib-root-baseline.json";

/** Glob that matches .ts files DIRECTLY at lib/ root (depth 1). */
const LIB_ROOT_GLOB = "lib/*.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RootViolation = {
  file: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

export type Baseline = Record<string, true>;

/**
 * Returns the basename of a lib/ root file path.
 * "lib/foo.ts" → "foo.ts", "lib\\foo.ts" → "foo.ts".
 */
export function basenamFromLibPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^.*lib\//, "");
}

/**
 * Derive the "sibling name" for a test file:
 * "foo.test.ts" → "foo.ts".  Returns undefined if not a test file.
 */
export function siblingOf(basename: string): string | undefined {
  if (basename.endsWith(".test.ts")) {
    return basename.replace(/\.test\.ts$/, ".ts");
  }
  return undefined;
}

export function checkLibRootFiles(baseline: Baseline, rootFiles: string[]): RootViolation[] {
  const violations: RootViolation[] = [];

  for (const filePath of rootFiles) {
    const name = basenamFromLibPath(filePath);

    // Allowed if directly in baseline.
    if (baseline[name]) continue;

    // Allowed if it is a .test.ts whose sibling is baselined.
    const sibling = siblingOf(name);
    if (sibling !== undefined && baseline[sibling]) continue;

    violations.push({
      file: filePath.replaceAll("\\", "/"),
      reason: `"${name}" is not in the lib/ root baseline. New lib code must go into a subdir (lib/domain/, lib/infra/, lib/reference/, …). See docs/superpowers/plans/2026-06-26-lib-bucketize-plan.md.`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan(): void {
  // Load baseline.
  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch {
    console.error(`✗ check-lib-root-files: cannot read baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }

  // Discover root-level lib files (max-depth 1 via glob pattern lib/*.ts).
  const paths = globSync(LIB_ROOT_GLOB).sort();
  if (paths.length === 0) {
    // Bucketize complete: no .ts remain at lib/ root — every module lives in a
    // subdir. Sanity-check we're in the repo (lib/ exists) so this isn't a
    // wrong-cwd false positive.
    if (!existsSync("lib")) {
      console.error("✗ check-lib-root-files: no lib/ directory — is the cwd correct?");
      process.exit(1);
    }
    console.log(
      "✓ lib/ root clean — 0 root files (bucketize complete; all lib code lives in subdirs).",
    );
    return;
  }

  const violations = checkLibRootFiles(baseline, paths);

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}: ${v.reason}`);
    }
    console.error(
      `\n✗ ${violations.length} unexpected lib/ root file(s). Baseline: ${BASELINE_PATH}. Place new code in lib/<subdir>/ or add it to an existing module under src/modules/.`,
    );
    process.exit(1);
  }

  const baselineCount = Object.keys(baseline).length;
  const newCount = paths.filter((p) => {
    const n = basenamFromLibPath(p);
    return !baseline[n];
  }).length;

  console.log(
    `✓ lib/ root clean — ${paths.length} root file(s) checked; ${baselineCount} in baseline; ${newCount} allowed test siblings; no unexpected files.`,
  );
}

// Guard: only scan when run directly; importing from tests exposes helpers
// without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-lib-root-files.ts") ||
    process.argv[1].endsWith("check-lib-root-files.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
