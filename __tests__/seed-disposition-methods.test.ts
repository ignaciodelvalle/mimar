// Seeds may only write disposition_method values the deathRecorded enum knows.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The real death flow validates death_recorded payloads through
// lib/events/event-schemas.ts (disposition_method is a closed enum). The seeds
// insert pet_events rows directly, bypassing that gate — and it cost a real
// defect: seed-panorama wrote disposition_method: "cremation" (not an enum
// member; the enum spells it cremation_collective / cremation_individual_ashes),
// so /gob/mortalidad bucketed those deaths as unrecognized "other" instead of
// cremation, and the raw value leaked into any per-method rendering
// (surveillance-disposal slice, 2026-08-02). Same fence rationale as
// __tests__/seed-vaccine-names.test.ts: a demo that contains impossible data
// teaches the wrong lesson to everyone who reads it.
//
// Scope: every scripts/seed-*.ts file, so a new seed cannot reintroduce the
// bug class.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DISPOSITION_BUCKETS } from "@/lib/domain/disposition";

const VALID_METHODS = new Set(Object.keys(DISPOSITION_BUCKETS));

const seedFiles = readdirSync("scripts")
  .filter((f) => /^seed-.*\.ts$/.test(f))
  .map((f) => join("scripts", f));

/**
 * Every string literal assigned to a `disposition_method:` key — covers the
 * simple form (`disposition_method: "x"`) and the pick-list form
 * (`disposition_method: pick(["a", "b", ...])`, optionally `] as const)`).
 */
function dispositionMethodLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /disposition_method:\s*(?:pick\(\[([\s\S]*?)\]|"([^"]+)")/g;
  for (const m of source.matchAll(re)) {
    if (m[2] !== undefined) {
      out.push(m[2]);
    } else {
      for (const lit of m[1].matchAll(/"([^"]+)"/g)) out.push(lit[1]);
    }
  }
  return out;
}

describe("seed disposition_method values are deathRecorded enum members", () => {
  it("extracts the literals it is meant to check (the regex must not go inert)", () => {
    // A fence whose extractor silently matches nothing passes forever.
    const found = seedFiles.flatMap((f) => dispositionMethodLiterals(readFileSync(f, "utf8")));
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it("resolves the pick-list form, not only the simple one", () => {
    const sample = `disposition_method: pick([
      "owner_burial",
      "cremation_collective",
    ] as const),`;
    expect(dispositionMethodLiterals(sample)).toEqual(["owner_burial", "cremation_collective"]);
  });

  it("rejects the shape that shipped", () => {
    // The exact literal seed-panorama used to carry.
    expect(VALID_METHODS.has("cremation")).toBe(false);
  });

  it.each(seedFiles)("%s writes only enum-member disposition methods", (file) => {
    const methods = dispositionMethodLiterals(readFileSync(file, "utf8"));
    for (const method of methods) {
      expect(
        VALID_METHODS.has(method),
        `${file} writes disposition_method "${method}", which is not a deathRecorded enum member (lib/events/event-schemas.ts). The real death flow would refuse this; the seed inserts directly and does not. Valid values: ${[...VALID_METHODS].join(", ")}.`,
      ).toBe(true);
    }
  });
});
