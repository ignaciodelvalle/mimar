// The result-to-exit-code mapping of the report-only Panorama QA harnesses
// (T1-C4). panorama-qa-nightly.yml was red 20 nights because a FINDING — a
// dock that timed out, a recovery that did not recover — exited 1. These pin
// the rule both scripts now share: findings exit 0, only a harness that could
// not run exits non-zero.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chaosFindings } from "../qa-panorama-chaos";
import {
  type QaRunOutcome,
  appendJobSummary,
  errorMessage,
  outcomeSummaryMarkdown,
  reportOnlyExitCode,
} from "./qa-report-outcome";

describe("reportOnlyExitCode", () => {
  it("exits 0 for a completed run with no findings", () => {
    expect(reportOnlyExitCode({ kind: "completed", findings: [] })).toBe(0);
  });

  // The defect: this is the run that used to exit 1.
  it("exits 0 for a completed run WITH findings — a finding is not an outage", () => {
    const outcome: QaRunOutcome = {
      kind: "completed",
      findings: [
        { where: "national", kind: "step-failed", detail: "panorama-dock not visible in 20000ms" },
        { where: "recovery geojson-kill", kind: "recovery-failed", detail: "honest-error=false" },
      ],
    };
    expect(reportOnlyExitCode(outcome)).toBe(0);
  });

  it("exits 1 when the harness itself could not run", () => {
    expect(reportOnlyExitCode({ kind: "harness-crash", message: "chromium did not launch" })).toBe(
      1,
    );
  });

  // The bug this closes: qa-panorama-vis's login step failed, the run
  // "completed" with a single "the login did not land" finding, and exited
  // 0 — a green report with zero real coverage of the product, reading
  // exactly like a clean night to anyone scanning the job.
  it("exits 1 for a 'completed' run that reports zero successful steps", () => {
    const outcome: QaRunOutcome = {
      kind: "completed",
      findings: [
        { where: "login", kind: "step-failed", detail: "Timeout 25000ms exceeded" },
        { where: "run", kind: "skipped", detail: "every view: the login did not land" },
      ],
      successfulSteps: 0,
    };
    expect(reportOnlyExitCode(outcome)).toBe(1);
  });

  it("exits 0 when at least one step succeeded, even alongside findings", () => {
    const outcome: QaRunOutcome = {
      kind: "completed",
      findings: [{ where: "national-1920", kind: "step-failed", detail: "boom" }],
      successfulSteps: 3,
    };
    expect(reportOnlyExitCode(outcome)).toBe(0);
  });

  // Callers that don't track successfulSteps at all (report-panorama-a11y,
  // qa-panorama-chaos) must see NO behavior change — the field is optional.
  it("exits 0 when successfulSteps is not reported at all", () => {
    expect(
      reportOnlyExitCode({
        kind: "completed",
        findings: [{ where: "round-1", kind: "no-map", detail: "canvas never attached" }],
      }),
    ).toBe(0);
  });
});

describe("chaosFindings", () => {
  it("turns violations and FAILED recoveries into rows, and leaves working recoveries out", () => {
    const rows = chaosFindings(
      [{ round: "round-3", kind: "console-error", detail: "TypeError: x" }],
      [
        { name: "webgl-loss", ok: true, detail: "restored" },
        { name: "geojson-kill", ok: false, detail: "honest-error=false; recovered-on-retry=false" },
      ],
    );
    expect(rows).toEqual([
      { where: "round-3", kind: "console-error", detail: "TypeError: x" },
      {
        where: "recovery geojson-kill",
        kind: "recovery-failed",
        detail: "honest-error=false; recovered-on-retry=false",
      },
    ]);
  });

  it("a run whose only failure is a recovery still completes with exit 0", () => {
    const findings = chaosFindings(
      [],
      [{ name: "geojson-kill", ok: false, detail: "recovered-on-retry=false" }],
    );
    expect(findings).toHaveLength(1);
    expect(reportOnlyExitCode({ kind: "completed", findings })).toBe(0);
  });
});

describe("the job summary keeps the findings visible", () => {
  it("lists every finding as a table row", () => {
    const md = outcomeSummaryMarkdown("Panorama chaos harness", {
      kind: "completed",
      findings: [{ where: "round-1", kind: "no-map", detail: "canvas | never attached" }],
    });
    expect(md).toContain("**1 finding(s)**");
    // A pipe inside a cell would split the row; it is escaped.
    expect(md).toContain("| round-1 | no-map | canvas \\| never attached |");
  });

  it("says plainly when the harness did not run, instead of reporting no findings", () => {
    const md = outcomeSummaryMarkdown("Panorama a11y report", {
      kind: "harness-crash",
      message: "chromium did not launch: boom",
    });
    expect(md).toContain("The harness could not run");
    expect(md).toContain("chromium did not launch: boom");
    expect(md).not.toContain("No findings");
  });

  describe("appendJobSummary", () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    it("appends to $GITHUB_STEP_SUMMARY when it is set", () => {
      dir = mkdtempSync(join(tmpdir(), "qa-summary-"));
      const file = join(dir, "summary.md");
      expect(appendJobSummary("### one", { GITHUB_STEP_SUMMARY: file })).toBe(true);
      expect(appendJobSummary("### two", { GITHUB_STEP_SUMMARY: file })).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("### one\n### two\n");
    });

    it("does nothing outside Actions", () => {
      expect(appendJobSummary("### one", {})).toBe(false);
    });
  });
});

describe("errorMessage", () => {
  it("keeps the first line of a Playwright error, not its call log", () => {
    const err = new Error(
      "locator.waitFor: Timeout 20000ms exceeded.\nCall log:\n  - waiting for getByTestId('panorama-dock')",
    );
    expect(errorMessage(err)).toBe("locator.waitFor: Timeout 20000ms exceeded.");
  });
});
