// Offline guard for the Node version fence (scripts/check-node-version.ts).
//
// The fence exists because `engines.node` was the open range ">=22.13.0" while
// the repo pinned 22.13.0 in three other places, and BOTH ends were wrong: 25 —
// which that range admits — breaks ~125 suites (its built-in Web Storage
// shadows jsdom's and has no .clear()), while 22.13.0 could not run a single
// seed script. These tests pin the parts that decide the verdict: what shapes
// the parsers accept, what counts as "outside the range", and what counts as a
// workflow DECLARING a version.
//
// The last one carries the same weight as its sibling in
// check-ci-lint-parity.test.ts: a version named in a comment is prose, not a
// declaration, and must not satisfy the check.

import { describe, expect, it } from "vitest";

import {
  compare,
  parseClosedRange,
  parseExact,
  satisfies,
  workflowNodeVersions,
} from "@/scripts/check-node-version";

describe("parseExact", () => {
  it("reads a pin file's MAJOR.MINOR.PATCH", () => {
    expect(parseExact("22.13.0")).toEqual({ major: 22, minor: 13, patch: 0 });
  });

  it("tolerates the trailing newline these files always carry", () => {
    expect(parseExact("22.13.0\n")).toEqual({ major: 22, minor: 13, patch: 0 });
  });

  // A pin file is a pin. `v22`, `lts/*` and `22` are all things people write in
  // an .nvmrc, and all of them leave the exact version unknowable.
  it.each(["v22.13.0", "22", "22.13", "lts/*", ">=22.13.0"])(
    "refuses %s — a pin file may not express a range or a prefix",
    (raw) => {
      expect(parseExact(raw)).toBeNull();
    },
  );
});

describe("parseClosedRange", () => {
  it("reads the closed range the manifest must carry", () => {
    expect(parseClosedRange(">=22.23.0 <23")).toEqual({
      floor: { major: 22, minor: 23, patch: 0 },
      ceilingMajor: 23,
    });
  });

  // THE 2026-08-28 DEFECT, as a red control. This is the exact string the
  // manifest carried while claiming Node 25 was supported.
  it("refuses the open range that started this", () => {
    expect(parseClosedRange(">=22.13.0")).toBeNull();
  });

  it.each(["^22.23.0", "22.x", ">=22.23.0 <23.0.0", ">= 22.23.0 <23"])(
    "refuses %s — a shape it cannot read is a shape it cannot police",
    (raw) => {
      expect(parseClosedRange(raw)).toBeNull();
    },
  );
});

describe("compare", () => {
  it("orders by major, then minor, then patch", () => {
    const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
    expect(compare(v(22, 13, 0), v(22, 13, 0))).toBe(0);
    expect(compare(v(22, 12, 9), v(22, 13, 0))).toBe(-1);
    expect(compare(v(22, 13, 1), v(22, 13, 0))).toBe(1);
    expect(compare(v(9, 0, 0), v(22, 0, 0))).toBe(-1);
  });

  // Lexicographic comparison would put "9" after "22". The versions are numbers.
  it("does not compare majors as strings", () => {
    expect(compare({ major: 9, minor: 0, patch: 0 }, { major: 22, minor: 0, patch: 0 })).toBe(-1);
  });
});

describe("satisfies", () => {
  const range = parseClosedRange(">=22.23.0 <23");
  if (!range) throw new Error("fixture range must parse");

  it("accepts the floor itself", () => {
    expect(satisfies({ major: 22, minor: 23, patch: 0 }, range)).toBe(true);
  });

  it("accepts a later patch on the same line — the pin tracks latest 22.x", () => {
    expect(satisfies({ major: 22, minor: 23, patch: 2 }, range)).toBe(true);
  });

  // Each of these is a REAL floor this repo measured on 2026-08-29, and every
  // one of them is inside the old open range that shipped before this fence.
  it.each([
    [{ major: 22, minor: 13, patch: 0 }, "no registerHooks — every seed:* dies"],
    [
      { major: 22, minor: 17, patch: 1 },
      "no type stripping — verify:mobile cannot read @dim/contract",
    ],
    [{ major: 22, minor: 22, patch: 0 }, "ICU 77 — windows-1252 0x97 is not an em dash"],
  ])("rejects %o (%s)", (version) => {
    expect(satisfies(version, range)).toBe(false);
  });

  // THE CASE THAT COST 125 MISREAD FAILURES.
  it("rejects Node 25, which the old open range admitted", () => {
    expect(satisfies({ major: 25, minor: 8, patch: 1 }, range)).toBe(false);
  });

  it("rejects the next major, quietly the same defect one year later", () => {
    expect(satisfies({ major: 23, minor: 0, patch: 0 }, range)).toBe(false);
  });
});

describe("workflowNodeVersions", () => {
  it("collects every setup-node declaration with its file and line", () => {
    const yaml = [
      "      - uses: actions/setup-node@v4",
      "        with:",
      '          node-version: "22"',
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
    ].join("\n");
    expect(workflowNodeVersions([{ path: "ci.yml", yaml }])).toEqual([
      { path: "ci.yml", line: 3, value: "22" },
      { path: "ci.yml", line: 6, value: "20" },
    ]);
  });

  it("does NOT count a version named only in a comment", () => {
    const yaml = [
      "      # node-version: 25 was tried and reverted; see the fence",
      '          node-version: "22"',
    ].join("\n");
    expect(workflowNodeVersions([{ path: "ci.yml", yaml }])).toEqual([
      { path: "ci.yml", line: 2, value: "22" },
    ]);
  });

  it("does not count a trailing comment on an otherwise real line", () => {
    const yaml = '          node-version: "22" # not 25, see scripts/check-node-version.ts';
    expect(workflowNodeVersions([{ path: "ci.yml", yaml }])).toEqual([
      { path: "ci.yml", line: 1, value: "22" },
    ]);
  });

  it("reports nothing for a workflow that never sets one", () => {
    expect(workflowNodeVersions([{ path: "codeql.yml", yaml: "jobs:\n  analyze:\n" }])).toEqual([]);
  });
});
