// Fence: who may WRITE authority_unit_id (localidades-por-id D, stage C
// verify S1).
//
// Setting authority_unit_id moves a grant, a rule, a coverage zone, an offering
// or a subscription from its name pair onto an authority unit: on the id path
// it then covers the unit's whole membership. On a per-locality row that is a
// widening, so it happens only through the writers named below, each of which
// is a person's explicit decision (the partial-grant confirm flow for grants).
// Every other file may READ the column; none may write it.
//
// The list of files that mention the column at all is exact, so a new reader
// or writer is a reviewed act, not an accident. Scanned: app, components,
// lib, src, scripts (TypeScript, never tests).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCANNED = ["app", "components", "lib", "src", "scripts"];

/** Every non-test file that mentions the column, and what it does with it. */
const MENTIONS: Readonly<Record<string, "writer" | "reader">> = {
  // The partial-grant confirm flow: the ONE writer of govt_assignments'.
  "src/modules/organizations/application/authority-units/grant-unit.ts": "writer",
  // Readers: the id-path consumers and the scope loader.
  "lib/infra/approval-routing.ts": "reader",
  "lib/infra/business-rules-resolver.ts": "reader",
  "lib/infra/request-cache.ts": "reader",
  "lib/place/scope.ts": "reader",
  "lib/place/govt-scope.ts": "reader",
  "lib/place/parity-sweep.ts": "reader",
  "lib/place/shadow.ts": "reader",
};

const MENTION = /\bauthorityUnitId\b|\bauthority_unit_id\b/;
// A Drizzle write (`.set({ … authorityUnitId … })`, `.values({ … })`) or a raw
// SQL write (UPDATE … SET … authority_unit_id, INSERT INTO … (… authority_unit_id …)).
const WRITE_SHAPES = [
  /\.(?:set|values)\(\s*\{[^}]*\bauthorityUnitId\b/s,
  /\bupdate\s+[\w."]+\s+set\b[^;`]*\bauthority_unit_id\s*=/is,
  /\binsert\s+into\s+[\w."]+\s*\([^)]*\bauthority_unit_id\b/is,
];

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.split(sep).includes("__tests__");
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !isTest(full)) out.push(full);
  }
}

function sources(): Array<{ file: string; text: string }> {
  const files: string[] = [];
  for (const d of SCANNED) walk(join(ROOT, d), files);
  return files.map((f) => ({
    file: relative(ROOT, f).split(sep).join("/"),
    text: readFileSync(f, "utf8"),
  }));
}

const writes = (text: string) => WRITE_SHAPES.some((re) => re.test(text));

describe("authority_unit_id writers", () => {
  const all = sources();
  const mentioning = all.filter((s) => MENTION.test(s.text));

  it("scans the tree (non-vacuity)", () => {
    expect(all.length).toBeGreaterThan(1000);
  });

  it("the files that mention the column are exactly the listed ones", () => {
    expect(mentioning.map((s) => s.file).sort()).toEqual(Object.keys(MENTIONS).sort());
  });

  it("only a listed writer writes it, and each listed writer does", () => {
    for (const s of mentioning) {
      expect(writes(s.text), `${s.file} is listed as ${MENTIONS[s.file]}`).toBe(
        MENTIONS[s.file] === "writer",
      );
    }
  });

  it("the write detector sees each shape", () => {
    expect(writes("tx.update(t).set({ authorityUnitId: unit.id })")).toBe(true);
    expect(writes("db.insert(t).values({ userId, authorityUnitId: x })")).toBe(true);
    expect(writes("update public.govt_assignments set authority_unit_id = $1")).toBe(true);
    expect(writes("insert into govt_assignments (user_id, authority_unit_id) values")).toBe(true);
    expect(writes("select({ unitId: govtAssignments.authorityUnitId })")).toBe(false);
  });
});
