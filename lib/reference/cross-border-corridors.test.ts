// Tests for the corridor reference registry (movilidad-jurisdiccional Fase 1,
// spec R3.1-R3.4, scenario S8). The 5-corridor hard bound is the enforcement
// mechanism for "never a world engine": the load-time coverage check throws
// on any registry that is not exactly {chile, uruguay, brasil, ue_espana, usa}.

import { describe, expect, it } from "vitest";

import {
  CORRIDORS,
  CORRIDOR_IDS,
  type Corridor,
  assertCorridorCoverage,
  getCorridor,
} from "@/lib/reference/cross-border-corridors";

describe("corridor registry — 5-corridor hard bound (S8)", () => {
  it("contains exactly the 5 Fase 1 corridors", () => {
    expect([...CORRIDOR_IDS].sort()).toEqual(["brasil", "chile", "ue_espana", "uruguay", "usa"]);
    expect(CORRIDORS).toHaveLength(5);
    expect(CORRIDORS.map((c) => c.id).sort()).toEqual([...CORRIDOR_IDS].sort());
  });

  it("assertCorridorCoverage throws when a corridor is missing (4 corridors)", () => {
    const four = CORRIDORS.filter((c) => c.id !== "usa");
    expect(() => assertCorridorCoverage(four)).toThrow(/exactly/i);
  });

  it("assertCorridorCoverage throws when a 6th corridor is added", () => {
    const six = [...CORRIDORS, { ...CORRIDORS[0], id: "mexico" } as unknown as Corridor];
    expect(() => assertCorridorCoverage(six)).toThrow(/exactly/i);
  });

  it("assertCorridorCoverage throws on a duplicated id even at length 5", () => {
    const dup = [...CORRIDORS.slice(0, 4), { ...CORRIDORS[0] }];
    expect(() => assertCorridorCoverage(dup)).toThrow(/exactly/i);
  });

  it("assertCorridorCoverage passes on the shipped registry", () => {
    expect(() => assertCorridorCoverage(CORRIDORS)).not.toThrow();
  });
});

describe("corridor registry — per-corridor invariants (R3.2, R3.4)", () => {
  it("every corridor carries version, effectiveFrom and a non-empty sourceUrl", () => {
    for (const c of CORRIDORS) {
      expect(c.version.length, c.id).toBeGreaterThan(0);
      expect(c.effectiveFrom, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.sourceUrl, c.id).toMatch(/^https:\/\//);
    }
  });

  it("every corridor is outbound_from_ar only (inbound out of scope, R3.4)", () => {
    for (const c of CORRIDORS) {
      expect(c.appliesTo.direction, c.id).toBe("outbound_from_ar");
    }
  });

  it("every corridor applies to dogs and cats", () => {
    for (const c of CORRIDORS) {
      expect(c.appliesTo.species, c.id).toEqual(expect.arrayContaining(["dog", "cat"]));
    }
  });

  it("getCorridor resolves each registered id to its corridor", () => {
    expect(getCorridor("chile").label).toBe("Chile");
    expect(getCorridor("ue_espana").jurisdiction.country).not.toBe("AR");
  });

  it("every corridor has an es-AR display label", () => {
    const labels = CORRIDORS.map((c) => c.label);
    expect(labels).toContain("Uruguay");
    expect(labels).toContain("Brasil");
    expect(labels).toContain("Estados Unidos");
  });
});

describe("corridor registry — 2026-09-30 corrections (viajes-fase-2)", () => {
  it("no corridor is left citation-pending", () => {
    for (const c of CORRIDORS) {
      expect(Object.keys(c.rules).length, c.id).toBeGreaterThan(0);
    }
  });

  it("Chile: 10-day CZI window, 21-day rabies wait, deworming 5–30, microchip mandatory", () => {
    const chile = getCorridor("chile");
    expect(chile.rules.document_issuance_window_days?.value).toBe(10);
    expect(chile.rules.document_issuance_window_days?.document).toBe("senasa_cvi");
    expect(chile.rules.rabies_vaccination_to_travel_wait_days?.value).toBe(21);
    expect(chile.rules.parasite_treatment_window_days?.value).toBe(30);
    expect(chile.rules.parasite_treatment_min_days_before?.value).toBe(5);
    expect(chile.rules.microchip_required?.value).toBe(true);
    expect(chile.rules.microchip_required?.appliesToSpecies).toBeUndefined();
    // No quarantine is declared — the "10-day confinement" is in no source.
    expect(chile.rules.quarantine_days_required).toBeUndefined();
  });

  it("Brasil: 60-day CVI, 21-day rabies wait, 15-day deworming, microchip optional", () => {
    const brasil = getCorridor("brasil");
    expect(brasil.rules.document_issuance_window_days?.value).toBe(60);
    expect(brasil.rules.rabies_vaccination_to_travel_wait_days?.value).toBe(21);
    expect(brasil.rules.parasite_treatment_window_days?.value).toBe(15);
    expect(brasil.rules.microchip_required).toBeUndefined();
    expect(brasil.rules.required_documents?.value.join("\n")).toMatch(/Microchip opcional/);
  });

  it("USA: the CDC 6-month minimum is a dog-only min_animal_age_days rule", () => {
    const usa = getCorridor("usa");
    expect(usa.rules.min_animal_age_days?.value).toBe(183);
    expect(usa.rules.min_animal_age_days?.appliesToSpecies).toEqual(["dog"]);
    // The 5-day window is the miasis certificate's, never the CVI's.
    expect(usa.rules.document_issuance_window_days?.document).toBe("miasis_certificate");
  });

  it("Uruguay's microchip is scoped to dogs", () => {
    expect(getCorridor("uruguay").rules.microchip_required?.appliesToSpecies).toEqual(["dog"]);
  });

  it("every declared rule is an envelope with its own provenance", () => {
    for (const c of CORRIDORS) {
      for (const [ruleType, envelope] of Object.entries(c.rules)) {
        expect(envelope?.sourceUrl, `${c.id}.${ruleType}`).toMatch(/^https:\/\//);
        expect(envelope?.lastVerifiedAt, `${c.id}.${ruleType}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(envelope?.reviewBy, `${c.id}.${ruleType}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});
