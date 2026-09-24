// Did every test file actually RUN?
//   pnpm vitest run --reporter=json --outputFile=<json>
//   pnpm tsx scripts/check-suite-coverage.ts <json>
//
// WHY THIS EXISTS — the suite's exit code is not a verdict, and it lies in both
// directions.
//
// FALSE RED: the `db` project holds a postgres.js pool. On teardown a worker can
// be killed with sockets still open; vitest reports an unhandled "Worker exited
// unexpectedly" and exits non-zero with every test green. vitest.config.ts
// already carries a globalSetup whose stated purpose is to drain the pool and
// prevent this; it does not always win the race.
//
// FALSE GREEN — the dangerous one: when a worker dies MID-RUN it takes its whole
// FILE with it. The report still says `success: true` with zero failures,
// because the tests in that file never executed. Seen twice on 2026-08-08/09 —
// "1217 passed | 1 skipped (1219)" and "1223 passed | 1 skipped (1225)". Both
// read like a pass unless you add them up.
//
// SECOND FALSE GREEN — the one this verdict itself produced (2026-08-22): a file
// that REPORTS, but with an error OUTSIDE any test. A vi.mock("@/db") factory
// was missing an export a new module-eval read needed (6131ec03); the file died
// at collection with ZERO tests. It was present in `testResults` (so not
// missing) and `numFailedTests` stayed 0 (no test ever ran), so this script
// printed "every test file ran, nothing failed." The only red was vitest's own
// exit code, which run-verified-suite.ts re-folds — and for four consecutive
// runs, three of them on CI, that red was read as the known worker-teardown
// crash, because the verdict had nothing to say about the file. A file whose
// `status` is failed while none of its assertions failed is BROKEN, and the
// verdict names it and quotes its message.
//
// THIRD FALSE GREEN — a file whose tests never FINISHED (review of 2f962281).
// vitest's JSON reporter maps a test still in state `run` / `queued` / `only`
// to `"pending"` (node_modules/vitest/dist/chunks/index.UpGiHP7g.js,
// StatusMap), and the file-status ternary there only looks at `fail`. So a
// report written while a file's tests were still running — a worker killed
// mid-file, a hang cut off at the global timeout — carries a `passed` file
// with pending assertions, and a grading that reads only `status` calls it
// green. A pending assertion is a test that did not run; the file is BROKEN.
// Skipped / todo assertions are deliberate and stay green.
//
// Green therefore means: exit code IGNORED, `numFailedTests === 0`, every test
// file present in `testResults`, no file failed outside its tests, AND no
// file left a test pending. This checks the last three — the ones nothing
// else checks.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The AUTHORITY for "which files does vitest run" — the same function
// vitest.config.ts feeds into `include` via computeTestPartition(). Using it
// (rather than `git ls-files`, as the first version of this script did) closes
// two silent gaps: an UNTRACKED new test file is run by vitest but invisible to
// the git index — exactly the newest, flakiest file, and exactly the one whose
// disappearance this script exists to catch — and the skip-list for
// `.claude`/`coverage`/`worktrees` stays in one place instead of two.
import { discoverTestFiles } from "../__tests__/db-reachability";

export type VitestFileResult = {
  name: string;
  /** "passed" | "failed" | "skipped" … — "failed" with no failing assertion is a FILE-level error. */
  status?: string;
  /** The first file-level error's message (collection error, hook error, worker exit). */
  message?: string;
  assertionResults?: { status: string; fullName: string; failureMessages?: string[] }[];
};

export type VitestJson = {
  numFailedTests?: number;
  testResults?: VitestFileResult[];
};

export interface SuiteVerdict {
  reported: number;
  discovered: number;
  failedTests: number;
  /** Discovered files absent from the report — a worker died and took them. */
  missing: string[];
  /** Reported files whose status is failed while no assertion in them failed. */
  broken: { file: string; message: string }[];
  /** Failing tests that asserted. */
  assertions: string[];
  /** Failing tests that timed out instead of asserting. */
  timeouts: string[];
  ok: boolean;
}

/**
 * A failure that TIMED OUT rather than asserting.
 *
 * READ THE HISTORY BEFORE CHANGING THIS. The first version of this function was
 * called `looksLikeDeadWorker` and told the reader such failures were "usually a
 * worker fork dying, not a defect". That was wrong, and dangerously so:
 * `STACK_TRACE_ERROR` is not a worker-death marker. In vitest 4.1.6 it is the
 * registration-time stack sentinel every `test()` and every hook is given, and
 * `makeTimeoutError` leaves it in `error.stack` verbatim. So the signature it
 * matched was TIMEOUT — including a test hanging on a degraded connection pool,
 * which is the exact failure the db-budget work exists to catch.
 *
 * A gate that files that under "probably not a defect" is worse than no gate.
 * The polarity is now inverted: a timeout is reported as MORE suspicious than an
 * assertion failure, not less.
 *
 * (What was really seen on 2026-08-09 — six file-walking fitness tests red in a
 * full run, all 44 assertions green in isolation seconds later — was almost
 * certainly I/O contention hitting the same timeout path. Correctly reported,
 * wrongly excused.)
 */
export function timedOut(messages: string[]): boolean {
  return messages.some((m) => m.includes("timed out in") || m.includes("STACK_TRACE_ERROR"));
}

/** vitest emits absolute POSIX-separator paths, Windows drive letter included. */
function toRepoRelative(p: string, repoRoot: string): string {
  return p.replace(/\\/g, "/").replace(`${repoRoot.replace(/\\/g, "/")}/`, "");
}

/** Grade a vitest JSON report against the files vitest was expected to run.
 * Pure — the CLI below feeds it the report file and discoverTestFiles(). */
export function gradeSuiteReport(
  report: VitestJson,
  expected: string[],
  repoRoot: string,
): SuiteVerdict {
  const results = report.testResults ?? [];
  const reported = new Set(results.map((f) => toRepoRelative(f.name, repoRoot)));
  const discovered = expected.map((f) => toRepoRelative(f, repoRoot));
  const failedTests = report.numFailedTests ?? 0;

  const missing = discovered.filter((f) => !reported.has(f));

  const broken: SuiteVerdict["broken"] = [];
  const timeouts: string[] = [];
  const assertions: string[] = [];
  for (const file of results) {
    const rel = toRepoRelative(file.name, repoRoot);
    let anyAssertionFailed = false;
    const pending: string[] = [];
    for (const a of file.assertionResults ?? []) {
      // `pending` is vitest's JSON word for run / queued / only — a test that
      // had not finished when the report was written. Not skipped, not todo.
      if (a.status === "pending") pending.push(a.fullName);
      if (a.status !== "failed") continue;
      anyAssertionFailed = true;
      const where = `${rel} › ${a.fullName}`;
      (timedOut(a.failureMessages ?? []) ? timeouts : assertions).push(where);
    }
    // Failed as a FILE while no test in it failed: it never ran its tests
    // (collection / mock / import error) — or, defensively, a file-level error
    // a future vitest attributes to the file after its tests reported.
    if (file.status === "failed" && !anyAssertionFailed) {
      broken.push({ file: rel, message: file.message ?? "" });
    } else if (pending.length > 0) {
      // The file reads `passed` and some of its tests never ran to an end.
      broken.push({
        file: rel,
        message: `${pending.length} test(s) still pending when the report was written (never finished): ${pending.join("; ")}`,
      });
    }
  }

  return {
    reported: reported.size,
    discovered: discovered.length,
    failedTests,
    missing,
    broken,
    assertions,
    timeouts,
    ok: missing.length === 0 && broken.length === 0 && failedTests === 0,
  };
}

/** The one line an operator pastes as evidence. Every count that can turn a
 * run red is on it, so "0 failing test(s)" can never again stand next to a file
 * that never ran. */
export function formatVerdictLine(v: SuiteVerdict): string {
  return `reported ${v.reported} file(s); ${v.discovered} discovered; ${v.failedTests} failing test(s); ${v.broken.length} broken file(s)`;
}

function main(): void {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("usage: tsx scripts/check-suite-coverage.ts <vitest-json-report>");
    process.exit(2);
  }

  const repoRoot = resolve(import.meta.dirname, "..");
  const report = JSON.parse(readFileSync(resolve(jsonPath), "utf8")) as VitestJson;
  const verdict = gradeSuiteReport(report, discoverTestFiles(), repoRoot);

  console.log(formatVerdictLine(verdict));

  if (verdict.missing.length > 0) {
    console.error(
      `\n${verdict.missing.length} test file(s) never reported — a worker died and took them with it.\nThe run is NOT green, whatever the summary said:\n`,
    );
    for (const m of verdict.missing) console.error(`   ${m}`);
  }

  if (verdict.broken.length > 0) {
    // Wording, deliberately: in vitest 4.1.6 the teardown crash ("Worker
    // exited unexpectedly" AFTER a file reported) never lands here — it is a
    // run-level unhandled error the JSON reporter drops, so it shows up as a
    // clean verdict line plus vitest's own exit 1 (see CLAUDE.md, Definition
    // of Done). A broken file is therefore a real failure, every time.
    console.error(
      `\n${verdict.broken.length} test file(s) broken — zero failing tests, and still not green.\nA mock/collection/import error means the file never ran its tests; a pending test means the\nreport was written before it finished. Fix it. (If a future vitest ever attributes a post-report\nworker exit to the file, it lands here too: name it, do not normalise it.)\n`,
    );
    for (const b of verdict.broken) {
      console.error(`   ${b.file}`);
      const firstLine = b.message.split("\n")[0]?.trim();
      if (firstLine) console.error(`      ${firstLine}`);
    }
  }

  if (verdict.assertions.length > 0) {
    console.error(`\n${verdict.assertions.length} failing assertion(s):\n`);
    for (const t of verdict.assertions) console.error(`   ${t}`);
  }
  if (verdict.timeouts.length > 0) {
    console.error(
      `\n${verdict.timeouts.length} test(s) TIMED OUT rather than asserting.\nTreat these as MORE serious than an assertion failure, not less: a test hanging on\na degraded connection pool is the exact failure the db-budget work defends against.\nRe-run them in isolation to separate machine contention from a real hang — and if they\npass, say WHY you believe that rather than calling the gate green:\n`,
    );
    for (const t of verdict.timeouts) console.error(`   ${t}`);
  }

  if (!verdict.ok) process.exit(1);
  console.log("every test file ran, nothing failed.");
}

// Guarded so the grading above is importable by its test without the CLI
// running on import (same convention as the sibling fences). The third clause
// used to build `file:///${argv[1]}` by hand, which on POSIX yields four
// slashes and never matched; pathToFileURL is the platform-correct spelling.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-suite-coverage.ts") ||
    process.argv[1].endsWith("check-suite-coverage.js") ||
    import.meta.url === pathToFileURL(process.argv[1]).href);

if (isMain) {
  main();
}
