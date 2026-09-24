import { describe, expect, it } from "vitest";

import {
  DISCLOSURE_PREF_DEFAULTS,
  type FirstStepsChecklistInput,
  deriveFirstStepsChecklist,
  hasReviewedDisclosurePrefs,
} from "./first-steps-checklist";

function makeInput(over: Partial<FirstStepsChecklistInput> = {}): FirstStepsChecklistInput {
  return {
    petPublicToken: "DIM-PAMP-0001",
    hasPhoto: false,
    hasMicrochip: false,
    hasVaccineRecorded: false,
    hasEmergencyContact: false,
    disclosurePrefsDecided: false,
    dismissedKeys: [],
    ...over,
  };
}

describe("deriveFirstStepsChecklist", () => {
  it("returns every step pending for a freshly-created pet (nothing done, nothing dismissed)", () => {
    const items = deriveFirstStepsChecklist(makeInput());
    expect(items.map((i) => i.key)).toEqual([
      "disclosure_prefs",
      "photo",
      "microchip",
      "vaccines",
      "emergency_contact",
    ]);
  });

  it("puts the disclosure_prefs star item first and flags it", () => {
    const items = deriveFirstStepsChecklist(makeInput());
    expect(items[0].key).toBe("disclosure_prefs");
    expect(items[0].star).toBe(true);
    expect(items.slice(1).every((i) => !i.star)).toBe(true);
  });

  it("drops a DONE step from the list (derived from the ledger/pet fields)", () => {
    const items = deriveFirstStepsChecklist(
      makeInput({ hasPhoto: true, hasMicrochip: true, disclosurePrefsDecided: true }),
    );
    expect(items.map((i) => i.key)).toEqual(["vaccines", "emergency_contact"]);
  });

  it("drops a DISMISSED step from the list even though it is NOT done", () => {
    const items = deriveFirstStepsChecklist(makeInput({ dismissedKeys: ["photo", "microchip"] }));
    expect(items.map((i) => i.key)).toEqual(["disclosure_prefs", "vaccines", "emergency_contact"]);
  });

  it("hides the whole checklist (empty array) once every step is done or dismissed", () => {
    const items = deriveFirstStepsChecklist(
      makeInput({
        hasPhoto: true,
        hasMicrochip: true,
        hasVaccineRecorded: true,
        hasEmergencyContact: true,
        disclosurePrefsDecided: true,
      }),
    );
    expect(items).toEqual([]);
  });

  it("hides the whole checklist when the remaining steps are all dismissed", () => {
    const items = deriveFirstStepsChecklist(
      makeInput({
        hasPhoto: true,
        hasMicrochip: true,
        hasVaccineRecorded: true,
        dismissedKeys: ["disclosure_prefs", "emergency_contact"],
      }),
    );
    expect(items).toEqual([]);
  });

  it("every pending item links to a sheet on THIS pet's profile", () => {
    const items = deriveFirstStepsChecklist(makeInput());
    for (const item of items) {
      expect(item.actionHref.startsWith("/mis-mascotas/DIM-PAMP-0001?sheet=")).toBe(true);
    }
  });

  it("does not duplicate Cumplimiento vocabulary: the microchip item is a glance nudge, not a legal-obligation claim", () => {
    // Scope-boundary smoke test: this projection has no notion of jurisdiction
    // requirement at all (unlike pet-compliance.ts) — it only ever asks "does
    // the owner have ANY identifier on file", which is a strictly narrower,
    // never-contradicting question.
    const items = deriveFirstStepsChecklist(makeInput());
    const microchipItem = items.find((i) => i.key === "microchip");
    expect(microchipItem?.label).not.toMatch(/requerid|obligatori|ley/i);
  });
});

describe("hasReviewedDisclosurePrefs", () => {
  it("returns false when every column still holds the DB default", () => {
    expect(hasReviewedDisclosurePrefs(DISCLOSURE_PREF_DEFAULTS)).toBe(false);
  });

  it("returns true when the owner flipped even one toggle away from default", () => {
    expect(
      hasReviewedDisclosurePrefs({ ...DISCLOSURE_PREF_DEFAULTS, discloseEmailWhenLost: true }),
    ).toBe(true);
    expect(
      hasReviewedDisclosurePrefs({ ...DISCLOSURE_PREF_DEFAULTS, disclosePhoneWhenLost: false }),
    ).toBe(true);
  });
});
