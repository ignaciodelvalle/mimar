// Unit tests: THE HARD GATE — atender vaccine catalog gate (#5, PO decision).
// Covers the three paths: conservative autoselect, ambiguous/no-candidate
// block+review, and the uncatalogued-vaccine notes flag round-trip.

import { describe, expect, it } from "vitest";

import {
  UNCATALOGUED_VACCINE_NOTE_PREFIX,
  hasUncataloguedVaccineFlag,
  resolveVaccineGate,
  speciesForVaccineMatch,
  withUncataloguedVaccineFlag,
} from "./atender-vaccine-gate";

describe("resolveVaccineGate — autoselect", () => {
  it("autoselects an exact catalog name", () => {
    const decision = resolveVaccineGate("Antirrábica", "dog");
    expect(decision).toEqual({ kind: "autoselect", canonicalName: "Antirrábica" });
  });

  it("autoselects a substring match embedded in a longer sentence", () => {
    const decision = resolveVaccineGate("le di la antirrabica hoy", "dog");
    expect(decision).toEqual({ kind: "autoselect", canonicalName: "Antirrábica" });
  });

  it("autoselects a single-edit typo of the root", () => {
    const decision = resolveVaccineGate("antirravica", "dog");
    expect(decision.kind).toBe("autoselect");
    if (decision.kind === "autoselect") expect(decision.canonicalName).toBe("Antirrábica");
  });
});

describe("resolveVaccineGate — ambiguous block", () => {
  it("blocks and returns 2+ candidates when both full names are literally present", () => {
    const decision = resolveVaccineGate("no sé si le dieron la quintuple o la sextuple", "dog");
    expect(decision.kind).toBe("review");
    if (decision.kind === "review") {
      expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
      // Neither tied candidate reaches the autoselect cutoff (demoted by the
      // shared matcher's resolveAmbiguousTies).
      for (const c of decision.candidates) {
        expect(c.confidence).toBeLessThan(0.85);
      }
    }
  });
});

describe("resolveVaccineGate — no candidate", () => {
  it("blocks with an empty candidate list for text outside the catalog", () => {
    const decision = resolveVaccineGate("una vacuna experimental xyz123", "dog");
    expect(decision.kind).toBe("review");
    if (decision.kind === "review") {
      expect(decision.candidates).toEqual([]);
    }
  });

  it("caps the review list at 3 candidates", () => {
    // A vague single-token match ("vacuna") on its own scores nothing useful,
    // but a partial word overlap against several multi-word catalog roots can
    // surface more than 3 — the gate must still cap the list at 3.
    const decision = resolveVaccineGate("tos perreras coronavirus giardia bordetella", "dog");
    expect(decision.kind).toBe("review");
    if (decision.kind === "review") {
      expect(decision.candidates.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("uncatalogued vaccine notes flag", () => {
  it("appends the flag to empty notes", () => {
    const notes = withUncataloguedVaccineFlag("", "Vacuna rara importada");
    expect(notes).toBe(`${UNCATALOGUED_VACCINE_NOTE_PREFIX} Vacuna rara importada`);
    expect(hasUncataloguedVaccineFlag(notes)).toBe(true);
  });

  it("appends the flag on a new line when notes already has content", () => {
    const notes = withUncataloguedVaccineFlag("Paciente tranquilo durante la aplicación.", "XYZ-9");
    expect(notes).toBe(
      `Paciente tranquilo durante la aplicación.\n${UNCATALOGUED_VACCINE_NOTE_PREFIX} XYZ-9`,
    );
    expect(hasUncataloguedVaccineFlag(notes)).toBe(true);
  });

  it("hasUncataloguedVaccineFlag is false for ordinary notes / null / undefined", () => {
    expect(hasUncataloguedVaccineFlag("Todo normal.")).toBe(false);
    expect(hasUncataloguedVaccineFlag(null)).toBe(false);
    expect(hasUncataloguedVaccineFlag(undefined)).toBe(false);
  });
});

describe("speciesForVaccineMatch", () => {
  it("passes through dog/cat and normalizes anything else to other", () => {
    expect(speciesForVaccineMatch("dog")).toBe("dog");
    expect(speciesForVaccineMatch("cat")).toBe("cat");
    expect(speciesForVaccineMatch("rabbit")).toBe("other");
    expect(speciesForVaccineMatch("")).toBe("other");
  });
});
