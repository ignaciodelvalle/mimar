// Every authority-routing call offers the place's catalogue row
// (localidades-por-id D3 extras).
//
// findAuthoritiesForJurisdiction takes the id path (flag `routing`) only when
// the caller passes `localityId`; without it a unit operator is paged by NAME,
// so a Bragado bite could page Alberti's Mechita. Each call either builds its
// place with a `localityId` (null = no single row: only the provincial unit),
// or forwards a jurisdiction object a use case built (a bare identifier — the
// use case's own call is checked where it is built). Nothing else passes.
//
// Scanned: app, lib, src (TypeScript, not tests); comments stripped.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CALL = "findAuthoritiesForJurisdiction(";

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** The first argument of each call, from `(` to its top-level comma or `)`. */
function firstArgs(src: string): Array<{ arg: string; line: number }> {
  const out: Array<{ arg: string; line: number }> = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(CALL, from);
    if (at < 0) break;
    const before = src.slice(Math.max(0, at - 16), at);
    // The definition, and a dependency property that merely NAMES the resolver.
    if (/function\s+$/.test(before) || /[.\w]$/.test(before)) {
      from = at + CALL.length;
      continue;
    }
    let depth = 0;
    let i = at + CALL.length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
    }
    out.push({
      arg: src.slice(at + CALL.length, i).trim(),
      line: src.slice(0, at).split("\n").length,
    });
    from = i;
  }
  return out;
}

function offenders(): { bad: string[]; calls: number } {
  const files: string[] = [];
  for (const d of ["app", "lib", "src"]) walk(join(ROOT, d), files);
  const bad: string[] = [];
  let calls = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, "");
    if (!src.includes(CALL)) continue;
    for (const { arg, line } of firstArgs(src)) {
      calls++;
      const forwarded = /^[A-Za-z_$][\w$]*$/.test(arg);
      // `...incidentPlaceId` (report-bite-from-org) spreads a built { localityId }.
      if (!forwarded && !/localityId|\.\.\.\w*PlaceId\b/.test(arg)) {
        bad.push(`${relative(ROOT, f).split(sep).join("/")}:${line} ${arg.replace(/\s+/g, " ")}`);
      }
    }
  }
  return { bad, calls };
}

describe("authority routing callers offer the place's locality id", () => {
  it("every findAuthoritiesForJurisdiction call builds its place with a localityId or forwards one", () => {
    const { bad, calls } = offenders();
    expect(bad).toEqual([]);
    // Non-vacuity: the inventory of 2026-09-26 counts 22 calls.
    expect(calls).toBeGreaterThanOrEqual(20);
  });
});
