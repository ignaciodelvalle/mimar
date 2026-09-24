// The demo seed may only write vaccine names the catalog can resolve.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The real vet path already enforces this: app/org/[orgToken]/atender/actions.ts
// refuses to commit a vaccination whose name is outside the catalog unless it
// is explicitly flagged as uncatalogued. The SEED bypasses that gate entirely —
// it inserts pet_events rows directly — so it was manufacturing data no
// production path could have created.
//
// It cost a real, user-visible defect. seed-demo-polish wrote "Séxtuple" while
// the catalog spells it "Séxtuple (DHPPi-L)". findVaccineByName is exact
// equality (deliberately — fuzzy-matching a medical record risks asserting a
// vaccine nobody gave), so a matrícula-signed dose was filed as "1 vacuna fuera
// del calendario" AND the core entry reported missing: the libreta told an owner
// "2 vacunas del calendario recomendado sin aplicar" a few centimetres above the
// signed record (live review 2026-07-28).
//
// The libreta no longer asserts that absence, but the seed should not be
// producing the ambiguity either — a demo that contains impossible data teaches
// the wrong lesson to everyone who reads it, including the next reviewer.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { findVaccineByName } from "@/lib/reference/lookups";

const SEED_FILES = ["scripts/seed-demo-polish.ts", "scripts/seed-demo-scenario.ts"];

/** Every string literal assigned to a `vaccine_name:` key in a seed file. */
function vaccineNameLiterals(source: string): string[] {
  const out: string[] = [];
  // Matches `vaccine_name: "X"` and the ternary form
  // `vaccine_name: cond ? "A" : "B"` — both shapes the seeds use today.
  const re = /vaccine_name:\s*([^,\n]+)/g;
  for (const m of source.matchAll(re)) {
    for (const lit of m[1].matchAll(/"([^"]+)"/g)) out.push(lit[1]);
  }
  return out;
}

describe("seed vaccine names resolve against the catalog", () => {
  it("extracts the literals it is meant to check (the regex must not go inert)", () => {
    // A fence whose extractor silently matches nothing passes forever. Prove it
    // finds something before trusting what it says about the rest.
    const found = SEED_FILES.flatMap((f) => vaccineNameLiterals(readFileSync(f, "utf8")));
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it("resolves the ternary form, not only the simple one", () => {
    const sample = 'vaccine_name: isCat ? "Triple felina (FVRCP)" : "Séxtuple (DHPPi-L)",';
    expect(vaccineNameLiterals(sample)).toEqual(["Triple felina (FVRCP)", "Séxtuple (DHPPi-L)"]);
  });

  it("rejects a name the catalog cannot resolve — the shape that shipped", () => {
    // The exact literal seed-demo-polish used to carry.
    expect(findVaccineByName("Séxtuple")).toBeNull();
    expect(findVaccineByName("Triple felina")).toBeNull();
  });

  it.each(SEED_FILES)("%s writes only catalog-resolvable vaccine names", (file) => {
    const names = vaccineNameLiterals(readFileSync(file, "utf8"));
    for (const name of names) {
      expect(
        findVaccineByName(name),
        `${file} writes vaccine_name "${name}", which findVaccineByName cannot resolve. The real vet action would refuse this; the seed inserts directly and does not. Use the catalog spelling from lib/reference/lookups.ts.`,
      ).not.toBeNull();
    }
  });
});
