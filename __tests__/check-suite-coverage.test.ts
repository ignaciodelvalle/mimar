// Tests for the suite verdict (scripts/check-suite-coverage.ts).
//
// WHY THIS FILE EXISTS. The verdict is the Definition of Done — the line an
// operator pastes as evidence — so it must be right in every direction vitest's
// exit code is wrong. It already caught the worker-died-mid-run case (a file
// that never reports). It did NOT catch a file that reports with an error
// OUTSIDE any test: a vi.mock factory missing an export, an import that throws,
// a hook or worker that dies after the tests ran. Such a file has zero failing
// tests, so `numFailedTests` stays 0, and the old verdict printed "every test
// file ran, nothing failed." On 2026-08-22 that happened four consecutive runs
// (three on CI) for the same file, and was read as the known worker-teardown
// crash for four runs because the verdict said nothing. These tests pin the
// grading against synthetic reports in vitest's JSON shape.

import { describe, expect, it } from "vitest";

import { formatVerdictLine, gradeSuiteReport, timedOut } from "@/scripts/check-suite-coverage";

// vitest emits ABSOLUTE paths with POSIX separators, drive letter included.
const ROOT = "C:\\fake\\dim";
const abs = (rel: string): string => `C:/fake/dim/${rel}`;

const passed = (rel: string, n = 2) => ({
  name: abs(rel),
  status: "passed",
  message: "",
  assertionResults: Array.from({ length: n }, (_, i) => ({
    status: "passed",
    fullName: `case ${i}`,
    failureMessages: [],
  })),
});

describe("gradeSuiteReport()", () => {
  it("grades a full, clean run as ok", () => {
    const expected = ["__tests__/a.test.ts", "lib/b.test.ts"];
    const v = gradeSuiteReport(
      { numFailedTests: 0, testResults: [passed(expected[0]), passed(expected[1])] },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.broken).toEqual([]);
    expect(v.assertions).toEqual([]);
    expect(v.timeouts).toEqual([]);
    expect(formatVerdictLine(v)).toBe(
      "reported 2 file(s); 2 discovered; 0 failing test(s); 0 broken file(s)",
    );
  });

  it("fails when a discovered file never reported (a worker died and took it)", () => {
    const expected = ["__tests__/a.test.ts", "__tests__/b.test.ts", "__tests__/c.test.ts"];
    const v = gradeSuiteReport(
      { numFailedTests: 0, testResults: [passed(expected[0]), passed(expected[2])] },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(["__tests__/b.test.ts"]);
    expect(formatVerdictLine(v)).toBe(
      "reported 2 file(s); 3 discovered; 0 failing test(s); 0 broken file(s)",
    );
  });

  // THE REGRESSION PIN. Exactly the shape vitest's JSON reporter wrote on
  // 2026-08-22 for __tests__/set-pet-lost-coord-range.test.ts: reported, status
  // "failed", zero assertions, the error in `message`, numFailedTests 0.
  it("fails on a file that reported an error outside any test (collection/mock error, zero tests)", () => {
    const expected = ["__tests__/a.test.ts", "__tests__/set-pet-lost-coord-range.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 0,
        testResults: [
          passed(expected[0]),
          {
            name: abs(expected[1]),
            status: "failed",
            message:
              '[vitest] No "authorRoleEnum" export is defined on the "@/db" mock. Did you forget to return it from "vi.mock"?',
            assertionResults: [],
          },
        ],
      },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([]);
    expect(v.failedTests).toBe(0);
    expect(v.broken).toEqual([
      {
        file: "__tests__/set-pet-lost-coord-range.test.ts",
        message:
          '[vitest] No "authorRoleEnum" export is defined on the "@/db" mock. Did you forget to return it from "vi.mock"?',
      },
    ]);
    expect(formatVerdictLine(v)).toBe(
      "reported 2 file(s); 2 discovered; 0 failing test(s); 1 broken file(s)",
    );
  });

  // THE LAST FALSE-GREEN CHANNEL (review of 2f962281). vitest's JSON reporter
  // maps a test whose state is still `run` / `queued` to `"pending"`
  // (node_modules/vitest/dist/chunks/index.UpGiHP7g.js StatusMap: `run:
  // "pending"`, `queued: "pending"`), and the file-status ternary only looks
  // at `fail`. A report written while a file's tests were still running —
  // a worker killed mid-file, a hung test at the global timeout — therefore
  // carries a `passed` file whose assertions never finished, and the grading
  // read it as green. A pending assertion is a test that did not run: the
  // file is BROKEN. Skipped/todo-only files stay green (the real report has
  // seed-demo-scenario.test.ts all-skipped → passed).
  it("fails on a file with a PENDING assertion — a test still running when the report was written", () => {
    const expected = ["__tests__/a.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 0,
        testResults: [
          {
            name: abs(expected[0]),
            status: "passed",
            message: "",
            assertionResults: [
              { status: "passed", fullName: "done case", failureMessages: [] },
              { status: "pending", fullName: "still running", failureMessages: [] },
            ],
          },
        ],
      },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(false);
    expect(v.failedTests).toBe(0);
    expect(v.broken).toHaveLength(1);
    expect(v.broken[0].file).toBe("__tests__/a.test.ts");
    expect(v.broken[0].message).toMatch(/pending/i);
    expect(v.broken[0].message).toContain("still running");
    expect(formatVerdictLine(v)).toBe(
      "reported 1 file(s); 1 discovered; 0 failing test(s); 1 broken file(s)",
    );
  });

  it("keeps a skipped/todo-only file green — a deliberate skip is not a test that failed to run", () => {
    const expected = ["__tests__/seed-demo-scenario.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 0,
        testResults: [
          {
            name: abs(expected[0]),
            status: "passed",
            message: "",
            assertionResults: [
              { status: "skipped", fullName: "needs the demo seed", failureMessages: [] },
              { status: "todo", fullName: "later", failureMessages: [] },
            ],
          },
        ],
      },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(true);
    expect(v.broken).toEqual([]);
  });

  // A DEFENSIVE shape, not an observed one. In vitest 4.1.6 a worker that
  // exits AFTER a file's tests reported cannot show up here: the error is
  // run-level (`state.catchError`) and JsonReporter.onTestRunEnd drops
  // unhandledErrors (node_modules/vitest/dist/chunks/index.UpGiHP7g.js
  // :3538-3609) — the file reads `passed`, the run exits 1, and the log carries
  // "Worker exited unexpectedly" (CLAUDE.md, Definition of Done). Pinned anyway:
  // if a future vitest attributes that error to the file, the verdict must
  // name it rather than read the file as green.
  it("fails on a file whose tests all passed but which reported a file-level error (defensive shape)", () => {
    const expected = ["__tests__/a.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 0,
        testResults: [
          { ...passed(expected[0], 3), status: "failed", message: "Worker exited unexpectedly" },
        ],
      },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(false);
    expect(v.broken).toEqual([
      { file: "__tests__/a.test.ts", message: "Worker exited unexpectedly" },
    ]);
  });

  it("does NOT count a file as broken when its failure is a failing assertion", () => {
    const expected = ["__tests__/a.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 1,
        testResults: [
          {
            name: abs(expected[0]),
            status: "failed",
            message: "",
            assertionResults: [
              { status: "passed", fullName: "ok case", failureMessages: [] },
              {
                status: "failed",
                fullName: "broken case",
                failureMessages: ["AssertionError: expected 1 to be 2"],
              },
            ],
          },
        ],
      },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(false);
    expect(v.broken).toEqual([]);
    expect(v.failedTests).toBe(1);
    expect(v.assertions).toEqual(["__tests__/a.test.ts › broken case"]);
    expect(v.timeouts).toEqual([]);
  });

  it("separates timed-out failures from assertion failures", () => {
    const expected = ["__tests__/a.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 2,
        testResults: [
          {
            name: abs(expected[0]),
            status: "failed",
            message: "",
            assertionResults: [
              {
                status: "failed",
                fullName: "slow case",
                failureMessages: ["Error: Test timed out in 5000ms."],
              },
              {
                status: "failed",
                fullName: "wrong case",
                failureMessages: ["AssertionError: expected 1 to be 2"],
              },
            ],
          },
        ],
      },
      expected,
      ROOT,
    );
    expect(v.timeouts).toEqual(["__tests__/a.test.ts › slow case"]);
    expect(v.assertions).toEqual(["__tests__/a.test.ts › wrong case"]);
  });

  it("matches Windows backslash report paths against posix discovered paths", () => {
    const expected = ["__tests__/a.test.ts"];
    const v = gradeSuiteReport(
      {
        numFailedTests: 0,
        testResults: [{ ...passed(expected[0]), name: "C:\\fake\\dim\\__tests__\\a.test.ts" }],
      },
      expected,
      ROOT,
    );
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });
});

describe("timedOut()", () => {
  it("recognises vitest's timeout message and the registration-stack sentinel", () => {
    expect(timedOut(["Error: Test timed out in 5000ms."])).toBe(true);
    expect(timedOut(["STACK_TRACE_ERROR"])).toBe(true);
    expect(timedOut(["AssertionError: expected 1 to be 2"])).toBe(false);
    expect(timedOut([])).toBe(false);
  });
});
