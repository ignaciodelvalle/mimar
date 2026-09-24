// Which disclosure preferences may a CARETAKER flip?
//
// THE HOLE THIS CLOSES. `setPetDisclosurePrefsAction` guards on
// `requirePetAccess`, and a caretaker holds a Path-1 ownership row, so it
// passes. For the five original toggles that is pre-existing behaviour this
// change does not get to redefine. For the SIXTH it collapses the whole model:
// `discloseCaretakerContactWhenLost` is KEY 1, the TITULAR's half of a two-key
// decision whose entire purpose is that one party cannot publish the other's
// contact alone. A caretaker able to flip key 1 holds both keys, and the second
// one stops meaning anything.
//
// The rule is a pure predicate so it can be tested without a session, and so
// the next person adding a disclosure column has one obvious place to declare
// which side of the line it falls on.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TITULAR_ONLY_DISCLOSURE_KEYS, disclosureKeyRequiresTitular } from "../disclosure-scope";

describe("disclosureKeyRequiresTitular", () => {
  it("is TRUE for the caretaker-contact key — key 1 belongs to the titular", () => {
    expect(disclosureKeyRequiresTitular("discloseCaretakerContactWhenLost")).toBe(true);
  });

  it("is FALSE for the five original toggles", () => {
    // Deliberately unchanged. Tightening them is defensible and is a DIFFERENT
    // change: it would alter what a foster and a shelter_custody holder can do
    // today, and this one has no mandate for that.
    for (const key of [
      "discloseFirstNameWhenLost",
      "disclosePhoneWhenLost",
      "discloseEmailWhenLost",
      "discloseLastLocationWhenLost",
      "allowFinderFormWhenLost",
    ] as const) {
      expect(disclosureKeyRequiresTitular(key)).toBe(false);
    }
  });

  it("the titular-only set is not empty — anti-emptying anchor", () => {
    // A red build must not be curable by clearing the constant.
    expect(TITULAR_ONLY_DISCLOSURE_KEYS.length).toBeGreaterThan(0);
    expect(TITULAR_ONLY_DISCLOSURE_KEYS).toContain("discloseCaretakerContactWhenLost");
  });
});

// The predicate is only worth anything if the shim asks it. That shim is a
// `"use server"` module whose only other guard is a live Supabase session, so
// no unit test can drive it — a source-level assertion is the honest
// instrument, the same one the caretaker cron registration uses.
describe("the action actually consults it", () => {
  const shim = readFileSync(resolve(process.cwd(), "app/actions/lost-mode.ts"), "utf8");

  it("app/actions/lost-mode.ts calls disclosureKeyRequiresTitular", () => {
    expect(shim).toContain("disclosureKeyRequiresTitular");
  });

  it("and escalates to requireTitularAccess when it says yes", () => {
    expect(shim).toContain("requireTitularAccess");
  });
});
