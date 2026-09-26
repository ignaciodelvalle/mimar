// Every per-row scope gate passes the row's catalogue row
// (localidades-por-id, stage D verify C1).
//
// jurisdictionScopeContains compares catalogue rows for a unit grant ONLY
// when the caller passes the row's locality id; without it the grant falls
// back to its stored name pair, so after the `scope` flip a unit grant
// confirmed from "Mechita" would open, or act on, Bragado's Mechita by URL
// while the list hides it. Each call either passes a 4th argument, or sits in
// a file allowlisted below for a stated reason, with an exact call count.
//
// Scanned: app, lib, src (TypeScript, not tests); comments stripped.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CALL = "jurisdictionScopeContains(";

/** Calls that compare something that is NOT a stored row with a catalogue id. */
const NAME_ONLY: Readonly<Record<string, { calls: number; reason: string }>> = {
  "lib/domain/revocation-scope.ts": {
    calls: 2,
    reason:
      "a vet's declared operational address (no catalogue id stored) and a whole-province assignment compared by province",
  },
  "lib/domain/jurisdiction-canonical.ts": {
    calls: 1,
    reason:
      "narrowGovtScope: a filter the operator selected, not a row; the list clause carries the id",
  },
  "app/api/panorama/unit-history/route.ts": {
    calls: 1,
    reason:
      "the clicked cell's label; every history query then runs under the actor's scope clause",
  },
  "src/modules/panorama/infrastructure/repository-history.ts": {
    calls: 1,
    reason: "the same click, second fence; the queries below are id-aware (D6)",
  },
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** The top-level argument count of the call opening at `start`, and where it ends. */
function countArgs(src: string, start: number): { args: number; end: number } {
  let depth = 0;
  let args = 1;
  let sawToken = false;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i] as string;
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) {
      // A trailing comma before `)` is not an argument.
      if (
        !src
          .slice(i + 1)
          .trimStart()
          .startsWith(")")
      )
        args++;
    } else if (!/\s/.test(ch)) sawToken = true;
  }
  return { args: sawToken ? args : 0, end: i };
}

/** Top-level argument count of each call (the definition skipped). */
function argCounts(src: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(CALL, from);
    if (at < 0) break;
    if (/function\s+$/.test(src.slice(Math.max(0, at - 16), at))) {
      from = at + CALL.length;
      continue;
    }
    const { args, end } = countArgs(src, at + CALL.length);
    out.push(args);
    from = end;
  }
  return out;
}

function scan() {
  const files: string[] = [];
  for (const d of ["app", "lib", "src"]) walk(join(ROOT, d), files);
  const bad: string[] = [];
  const nameOnlySeen: Record<string, number> = {};
  let calls = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, "");
    if (!src.includes(CALL)) continue;
    const rel = relative(ROOT, f).split(sep).join("/");
    for (const n of argCounts(src)) {
      calls++;
      if (n >= 4) continue;
      nameOnlySeen[rel] = (nameOnlySeen[rel] ?? 0) + 1;
    }
  }
  for (const [rel, n] of Object.entries(nameOnlySeen)) {
    const allowed = NAME_ONLY[rel];
    if (!allowed || allowed.calls !== n)
      bad.push(`${rel}: ${n} call(s) without the row's locality id`);
  }
  for (const [rel, a] of Object.entries(NAME_ONLY)) {
    if ((nameOnlySeen[rel] ?? 0) !== a.calls)
      bad.push(`${rel}: allowlist says ${a.calls}, found ${nameOnlySeen[rel] ?? 0}`);
  }
  return { bad, calls };
}

describe("per-row scope gates pass the row's locality id", () => {
  it("every jurisdictionScopeContains call passes it, or is allowlisted with a reason", () => {
    const { bad, calls } = scan();
    expect(bad).toEqual([]);
    // Non-vacuity: 33 calls on 2026-09-26.
    expect(calls).toBeGreaterThanOrEqual(30);
  });
});
