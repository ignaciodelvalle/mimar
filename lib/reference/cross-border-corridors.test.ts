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
