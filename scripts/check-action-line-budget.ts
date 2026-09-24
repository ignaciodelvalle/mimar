// app/actions/ line-budget ratchet — CI guard (strangler migration).
//
// Enforces two rules to stop the bleeding while the strangler migration is in
// progress (see docs/architecture/hexagonal-lite.md and
// docs/superpowers/plans/2026-06-26-strangler-finish-plan.md):
//
//   (A) EXISTING files must not GROW beyond baseline + SLACK lines.
//       Existing fat actions can only shrink or stay flat — no new code
//       is allowed in files that are already scheduled for migration.
//
//   (B) NEW app/actions/*.ts files must stay under NEW_FILE_THRESHOLD lines.
//       New actions should be thin shims from day one.
//
// The baseline (scripts/action-line-budget-baseline.json) was recorded on
// 2026-06-26 at the start of branch integration/session-review.
//
// Run: pnpm tsx scripts/check-action-line-budget.ts   (or: pnpm lint:actions)
// Exits 0 when clean; exits 1 listing each offending file with its counts.
//
// Regex-based line counter — mirrors the sibling linters
// (check-dependency-direction.ts, check-ui-invariants.ts, etc.).

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How many extra lines an existing file may grow before triggering a failure.
 *  Small enough to block accidental bloat; large enough to allow minor edits. */
const EXISTING_FILE_SLACK = 20;

/** Maximum line count for a brand-new app/actions/*.ts file.
 *  New actions must be thin shims or narrow controllers from the start. */
const NEW_FILE_THRESHOLD = 150;

const BASELINE_PATH = "scripts/action-line-budget-baseline.json";
const ACTIONS_GLOB = "app/actions/*.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BudgetViolation = {
  file: string;
  kind: "existing-grew" | "new-too-large";
  baseline?: number;
  actual: number;
  limit: number;
};

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

export type Baseline = Record<string, number>;

/** Count the lines in a string (same convention as wc -l: trailing newline
 *  does not add an extra line). */
export function countLines(src: string): number {
  return src.split("\n").length;
}

export function checkActionBudget(
  baseline: Baseline,
  files: Array<{ name: string; src: string }>,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];

  for (const { name, src } of files) {
    const actual = countLines(src);
    const baselineCount = baseline[name];

    if (baselineCount !== undefined) {
      // (A) Existing file — must not grow.
      const limit = baselineCount + EXISTING_FILE_SLACK;
      if (actual > limit) {
        violations.push({
          file: name,
          kind: "existing-grew",
          baseline: baselineCount,
          actual,
          limit,
        });
      }
    } else {
      // (B) New file — must stay thin.
      if (actual > NEW_FILE_THRESHOLD) {
        violations.push({
          file: name,
          kind: "new-too-large",
          actual,
          limit: NEW_FILE_THRESHOLD,
        });
      }
    }
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
    console.error(`✗ check-action-line-budget: cannot read baseline at ${BASELINE_PATH}`);
    process.exit(1);
  }

  // Discover action files — PRODUCTION actions only.
  //
  // The glob `app/actions/*.ts` also matches colocated `*.test.ts`, so this
  // fence used to ratchet test files too. That is not what it is for: rule (A)
  // above is "existing fat actions can only shrink — no new code in files
  // already scheduled for migration", and a test file is neither fat-by-
  // migration nor scheduled for anything. The effect was backwards — it billed
  // ADDED TEST COVERAGE against a budget meant to discourage business logic in
  // the wrong layer, and a security fix had to shed comments from its own test
  // to get through (2026-08-12, cowork audit follow-up).
  //
  // Excluding them does not open a hole: a test file cannot host the leaking
  // business logic this fence exists to catch, and the production sibling
  // (sign-timeline-attachments.ts, 47 lines) is still ratcheted.
  const paths = globSync(ACTIONS_GLOB)
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .sort();
  if (paths.length === 0) {
    console.error("✗ check-action-line-budget: no files found under app/actions/.");
    process.exit(1);
  }

  // Build file records (name = basename only, matching baseline keys).
  const files = paths.map((p) => ({
    name: p.replaceAll("\\", "/").replace(/^.*app\/actions\//, ""),
    src: readFileSync(resolve(p), "utf8"),
  }));

  const violations = checkActionBudget(baseline, files);

  if (violations.length > 0) {
    for (const v of violations) {
      if (v.kind === "existing-grew") {
        console.error(
          `app/actions/${v.file}: ${v.actual} lines — grew beyond baseline ${v.baseline} + slack ${EXISTING_FILE_SLACK} = ${v.limit}. Migrate logic to src/modules/<domain>/application/ instead of adding to this fat action.`,
        );
      } else {
        console.error(
          `app/actions/${v.file}: ${v.actual} lines — new action exceeds the ${NEW_FILE_THRESHOLD}-line threshold. New actions must be thin controllers; extract business logic to src/modules/<domain>/application/.`,
        );
      }
    }
    console.error(
      `\n✗ ${violations.length} line-budget violation(s) in app/actions/. Baseline: ${BASELINE_PATH}. To update the baseline after a legitimate shrink, re-run the generate script (see scripts/action-line-budget-baseline.json) and update manually.`,
    );
    process.exit(1);
  }

  const existingCount = files.filter((f) => baseline[f.name] !== undefined).length;
  const newCount = files.length - existingCount;
  console.log(
    `✓ app/actions/ line-budget clean — ${existingCount} baselined file(s) within budget (slack ±${EXISTING_FILE_SLACK}); ${newCount} new file(s) within ${NEW_FILE_THRESHOLD}-line threshold.`,
  );
}

// Guard: only scan when run directly.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-action-line-budget.ts") ||
    process.argv[1].endsWith("check-action-line-budget.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
