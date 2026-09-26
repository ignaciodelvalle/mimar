// Fence: a scope clause over a table that HAS locality_id must offer it
// (localidades-por-id, stage D audit addendum (b)).
//
// jurisdictionPairClause matches a unit grant by catalogue row only when the
// caller passes the row's locality_id column; without it the grant falls back
// to its name pair, so with the `scope` flag on 'id' a list would still
// confuse homonyms (and list what the detail gate then refuses). Every call
// whose province/locality operands come from a table with a locality_id
// column must pass that column as the 4th argument. Payload-keyed calls
// (JSONB fields with no id) are out of scope by construction.
//
// Scanned: app, lib, src (TypeScript, not tests). A call is parsed from its
// opening parenthesis to the matching close.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Drizzle table → its locality-id column, for every table that has one. */
const ID_COLUMN: Readonly<Record<string, string>> = {
  pets: "localityId",
  cases: "localityId",
  welfareReports: "localityId",
  organizations: "localityId",
  custodyDisputes: "localityId",
  fosterVolunteers: "localityId",
  approvalRequests: "localityId",
  organizationCoverage: "localityId",
  serviceOfferings: "localityId",
  alertSubscriptions: "localityId",
  alertFirings: "localityId",
  govtBusinessRules: "localityId",
  eventNotificationOutbox: "targetLocalityId",
};

const CALL = "jurisdictionPairClause(";

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** The text of each call, from `(` to its matching `)`. */
function calls(src: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(CALL, from);
    if (at < 0) break;
    // Skip the definition itself.
    if (src.slice(Math.max(0, at - 9), at) === "function ") {
      from = at + CALL.length;
      continue;
    }
    let depth = 0;
    let end = at + CALL.length - 1;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    out.push({ text: src.slice(at, end + 1), line: src.slice(0, at).split("\n").length });
    from = end + 1;
  }
  return out;
}

function offenders(): string[] {
  const files: string[] = [];
  for (const d of ["app", "lib", "src"]) walk(join(ROOT, d), files);
  const bad: string[] = [];
  let tableCalls = 0;
  for (const f of files) {
    // Comments stripped (a JSDoc example is not a call), newlines kept so the
    // reported line numbers stay true.
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, "");
    if (!src.includes(CALL)) continue;
    for (const c of calls(src)) {
      const m = /\$\{(\w+)\.(?:jurisdictionProvince|targetJurisdictionProvince)\}/.exec(c.text);
      const table = m?.[1];
      if (!table || !(table in ID_COLUMN)) continue;
      tableCalls++;
      if (!c.text.includes(`\${${table}.${ID_COLUMN[table]}}`)) {
        bad.push(`${relative(ROOT, f).split(sep).join("/")}:${c.line} (${table})`);
      }
    }
  }
  if (tableCalls < 15) bad.push(`non-vacuity: only ${tableCalls} table-keyed calls found`);
  return bad;
}

describe("scope clauses offer the table's locality_id", () => {
  it("every table-keyed jurisdictionPairClause passes the locality-id column", () => {
    expect(offenders()).toEqual([]);
  });
});
