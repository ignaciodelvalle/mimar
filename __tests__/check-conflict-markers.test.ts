// Offline guard for the merge-conflict marker fence
// (scripts/check-conflict-markers.ts).
//
// RED CONTROLS. A marker fence that matches nothing passes on every tree, so
// each of the four shapes must FIRE on a synthetic conflict here, and each
// near-miss one detail away (indented, too short, no space) must NOT. The
// markers are ASSEMBLED AT RUNTIME, so this file never carries one itself —
// the last test proves it by scanning this file and the fence with the fence.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  findMarkers,
  markerKind,
  scanConflictMarkers,
} from "../scripts/check-conflict-markers";

const lt = "<".repeat(7);
const gt = ">".repeat(7);
const eq = "=".repeat(7);
const bar = "|".repeat(7);

const conflict = [
  "const a = 1;",
  `${lt} HEAD`,
  "const b = 2;",
  `${bar} merged common ancestors`,
  "const b = 0;",
  eq,
  "const b = 3;",
  `${gt} feature/x`,
  "const c = 4;",
].join("\n");

describe("markerKind", () => {
  it("fires on each of git's four marker shapes", () => {
    expect(markerKind(`${lt} HEAD`)).toBe("ours");
    expect(markerKind(`${bar} base`)).toBe("base");
    expect(markerKind(eq)).toBe("separator");
    expect(markerKind(`${gt} main`)).toBe("theirs");
  });

  it("tolerates a CRLF line ending", () => {
    expect(markerKind(`${eq}\r`)).toBe("separator");
    expect(markerKind(`${lt} HEAD\r`)).toBe("ours");
  });

  it("ignores near-misses one detail away", () => {
    expect(markerKind(` ${lt} HEAD`)).toBeNull(); // indented
    expect(markerKind(`${"<".repeat(6)} HEAD`)).toBeNull(); // six, not seven
    expect(markerKind(`${lt}HEAD`)).toBeNull(); // no space
    expect(markerKind(`${eq}=`)).toBeNull(); // setext underline of eight
    expect(markerKind(`${eq} x`)).toBeNull(); // separator with trailing text
    expect(markerKind("=".repeat(6))).toBeNull();
    expect(markerKind("a >>>>>>> b")).toBeNull(); // mid-line
  });
});

describe("findMarkers", () => {
  it("reports every marker line of a synthetic conflict with its 1-based line", () => {
    expect(findMarkers("x.ts", conflict)).toEqual([
      { path: "x.ts", line: 2, kind: "ours" },
      { path: "x.ts", line: 4, kind: "base" },
      { path: "x.ts", line: 6, kind: "separator" },
      { path: "x.ts", line: 8, kind: "theirs" },
    ]);
  });

  it("finds nothing in clean text", () => {
    expect(findMarkers("x.md", "# Title\n=========\n\nbody\n")).toEqual([]);
  });
});

describe("scanConflictMarkers", () => {
  it("fails a conflicted file and passes a clean one", () => {
    const result = scanConflictMarkers(
      [
        { path: "docs/a.md", src: conflict },
        { path: "docs/b.md", src: "clean\n" },
      ],
      [],
    );
    expect(result.findings.map((f) => f.path)).toEqual([
      "docs/a.md",
      "docs/a.md",
      "docs/a.md",
      "docs/a.md",
    ]);
    expect(result.staleAllowlist).toEqual([]);
  });

  it("an allowlisted file is counted apart, not failed", () => {
    const entry = { path: "docs/quote.md", reason: "quotes git output" };
    const result = scanConflictMarkers([{ path: "docs/quote.md", src: conflict }], [entry]);
    expect(result.findings).toEqual([]);
    expect(result.allowed).toHaveLength(4);
    expect(result.staleAllowlist).toEqual([]);
  });

  it("an allowlist entry that matches nothing is reported stale", () => {
    const entry = { path: "docs/gone.md", reason: "used to quote git output" };
    const result = scanConflictMarkers([{ path: "docs/gone.md", src: "clean\n" }], [entry]);
    expect(result.staleAllowlist).toEqual([entry]);
  });

  it("the committed allowlist stays empty unless a reason is given", () => {
    for (const e of ALLOWLIST) expect(e.reason.length).toBeGreaterThan(0);
  });

  it("neither the fence nor this test carries a marker line itself", () => {
    const files = ["scripts/check-conflict-markers.ts", "__tests__/check-conflict-markers.test.ts"];
    const result = scanConflictMarkers(
      files.map((path) => ({ path, src: readFileSync(path, "utf8") })),
      [],
    );
    expect(result.findings).toEqual([]);
  });
});
