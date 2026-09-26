// The shadow classifier (localidades-por-id D1, design "Shadow comparator").
//
// Before a consumer flips from the name path to the id path, both answers are
// computed and every disagreement is classified. Only three kinds are the
// point of the change (a homonym split apart, a spelling joined, an
// unresolved row that now reaches only its province); a fourth (a person
// confirmed a unit wider than the old grant) is reported, not blocking. A
// legacy grant (authority_unit_id NULL) must answer IDENTICALLY on both paths,
// so any disagreement there blocks the flip, like OTHER.

import { describe, expect, it } from "vitest";

import { type ShadowFacts, classifyShadow, flipGateVerdict, worstShadowKind } from "./shadow";

const agree: ShadowFacts = {
  namePath: true,
  idPath: true,
  legacyOnly: false,
  rowLocalityId: "loc-1",
  rowNameAmbiguous: false,
  rowNameFoldsToCatalogue: true,
  grantNamesRowLocality: true,
};

describe("classifyShadow", () => {
  it("returns null when both paths agree, visible or not", () => {
    expect(classifyShadow(agree)).toBeNull();
    expect(classifyShadow({ ...agree, namePath: false, idPath: false })).toBeNull();
  });

  it("any disagreement under legacy grants only is legacy_grant, whatever else is true", () => {
    expect(classifyShadow({ ...agree, idPath: false, legacyOnly: true })).toBe("legacy_grant");
    expect(
      classifyShadow({ ...agree, namePath: false, legacyOnly: true, rowLocalityId: null }),
    ).toBe("legacy_grant");
  });

  it("a row only the name path reached, with no locality, is unresolved_to_province", () => {
    expect(classifyShadow({ ...agree, idPath: false, rowLocalityId: null })).toBe(
      "unresolved_to_province",
    );
  });

  it("a row only the name path reached, whose name two catalogue rows share, is homonym_split", () => {
    // Mechita (Bragado) matched a Mechita (Alberti) grant by name.
    expect(classifyShadow({ ...agree, idPath: false, rowNameAmbiguous: true })).toBe(
      "homonym_split",
    );
  });

  it("a resolved, unambiguous row the id path dropped is OTHER", () => {
    expect(classifyShadow({ ...agree, idPath: false })).toBe("other");
  });

  it("a row only the id path reached, spelled differently from its grant, is spelling_join", () => {
    // "Nunez" stored, the grant says "Núñez": the id joins them.
    expect(classifyShadow({ ...agree, namePath: false })).toBe("spelling_join");
  });

  it("a row only the id path reached whose stored name is not a spelling of its locality is OTHER", () => {
    expect(classifyShadow({ ...agree, namePath: false, rowNameFoldsToCatalogue: false })).toBe(
      "other",
    );
  });

  it("a row only the id path reached outside every old grant is unit_widening", () => {
    expect(classifyShadow({ ...agree, namePath: false, grantNamesRowLocality: false })).toBe(
      "unit_widening",
    );
    expect(
      classifyShadow({
        ...agree,
        namePath: false,
        grantNamesRowLocality: false,
        rowLocalityId: null,
      }),
    ).toBe("unit_widening");
  });
});

describe("worstShadowKind", () => {
  it("orders blocking kinds before accepted ones", () => {
    expect(worstShadowKind(["homonym_split", "other", "spelling_join"])).toBe("other");
    expect(worstShadowKind(["other", "legacy_grant"])).toBe("legacy_grant");
    expect(worstShadowKind(["spelling_join", "unit_widening"])).toBe("unit_widening");
    expect(worstShadowKind([])).toBeNull();
  });
});

describe("flipGateVerdict", () => {
  it("passes only with zero OTHER and zero legacy_grant", () => {
    expect(flipGateVerdict({ homonym_split: 3, spelling_join: 2, unit_widening: 1 })).toEqual({
      pass: true,
      blocking: {},
    });
    expect(flipGateVerdict({ homonym_split: 3, other: 1 })).toEqual({
      pass: false,
      blocking: { other: 1 },
    });
    expect(flipGateVerdict({ legacy_grant: 2 })).toEqual({
      pass: false,
      blocking: { legacy_grant: 2 },
    });
  });
});
