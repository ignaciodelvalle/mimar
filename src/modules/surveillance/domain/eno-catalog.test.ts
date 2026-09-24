// Unit tests for domain/eno-catalog.ts
// Spec source: task 1.2 — ENO_DISEASES_AR, getEnoDisease, isEnoCode, diseaseCodeToEnoCode.
// Parity: mirrors lib/eno-catalog.ts exactly — bridge codes + stigma flags are normative.

import { describe, expect, it } from "vitest";

import { ENO_DISEASES_AR, diseaseCodeToEnoCode, getEnoDisease, isEnoCode } from "./eno-catalog";

// ---------------------------------------------------------------------------
// ENO_DISEASES_AR catalog shape
// ---------------------------------------------------------------------------

describe("ENO_DISEASES_AR", () => {
  it("contains exactly 5 diseases", () => {
    expect(ENO_DISEASES_AR).toHaveLength(5);
  });

  it("contains rabies with critical severity and stigmaSensitive=false", () => {
    const rabies = ENO_DISEASES_AR.find((d) => d.code === "rabies");
    expect(rabies).toBeDefined();
    expect(rabies?.severity).toBe("critical");
    expect(rabies?.stigmaSensitive).toBe(false);
    expect(rabies?.notifyHours).toBe(24);
  });

  it("contains leptospirosis with high severity and stigmaSensitive=false", () => {
    const lepto = ENO_DISEASES_AR.find((d) => d.code === "leptospirosis");
    expect(lepto).toBeDefined();
    expect(lepto?.severity).toBe("high");
    expect(lepto?.stigmaSensitive).toBe(false);
    expect(lepto?.notifyHours).toBe(48);
  });

  it("contains hidatidosis with high severity and stigmaSensitive=false", () => {
    const hida = ENO_DISEASES_AR.find((d) => d.code === "hidatidosis");
    expect(hida).toBeDefined();
    expect(hida?.severity).toBe("high");
    expect(hida?.stigmaSensitive).toBe(false);
    expect(hida?.notifyHours).toBe(48);
  });

  it("contains brucelosis_canina with high severity and stigmaSensitive=true", () => {
    const bruc = ENO_DISEASES_AR.find((d) => d.code === "brucelosis_canina");
    expect(bruc).toBeDefined();
    expect(bruc?.severity).toBe("high");
    expect(bruc?.stigmaSensitive).toBe(true);
    expect(bruc?.notifyHours).toBe(72);
  });

  it("contains leishmaniasis with critical severity and stigmaSensitive=true", () => {
    const leish = ENO_DISEASES_AR.find((d) => d.code === "leishmaniasis");
    expect(leish).toBeDefined();
    expect(leish?.severity).toBe("critical");
    expect(leish?.stigmaSensitive).toBe(true);
    expect(leish?.notifyHours).toBe(48);
  });

  it("every disease has a non-empty code, label, and legalAnchor", () => {
    for (const disease of ENO_DISEASES_AR) {
      expect(disease.code.length).toBeGreaterThan(0);
      expect(disease.label.length).toBeGreaterThan(0);
      expect(disease.legalAnchor.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// getEnoDisease
// ---------------------------------------------------------------------------

describe("getEnoDisease", () => {
  it("returns the disease object for a known code", () => {
    const disease = getEnoDisease("rabies");
    expect(disease).not.toBeNull();
    expect(disease?.code).toBe("rabies");
    expect(disease?.label).toBe("Rabia");
  });

  it("returns null for an unknown code", () => {
    expect(getEnoDisease("unknown_disease")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(getEnoDisease("")).toBeNull();
  });

  it("returns the correct disease for leishmaniasis", () => {
    const disease = getEnoDisease("leishmaniasis");
    expect(disease?.severity).toBe("critical");
    expect(disease?.stigmaSensitive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isEnoCode
// ---------------------------------------------------------------------------

describe("isEnoCode", () => {
  it("returns true for 'rabies'", () => {
    expect(isEnoCode("rabies")).toBe(true);
  });

  it("returns true for 'leptospirosis'", () => {
    expect(isEnoCode("leptospirosis")).toBe(true);
  });

  it("returns true for 'hidatidosis'", () => {
    expect(isEnoCode("hidatidosis")).toBe(true);
  });

  it("returns true for 'brucelosis_canina'", () => {
    expect(isEnoCode("brucelosis_canina")).toBe(true);
  });

  it("returns true for 'leishmaniasis'", () => {
    expect(isEnoCode("leishmaniasis")).toBe(true);
  });

  it("returns false for 'rabies_confirmed' (form-emitted code — must go through bridge)", () => {
    expect(isEnoCode("rabies_confirmed")).toBe(false);
  });

  it("returns false for 'rabies_suspected'", () => {
    expect(isEnoCode("rabies_suspected")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isEnoCode("")).toBe(false);
  });

  it("returns false for a completely unknown code", () => {
    expect(isEnoCode("parvovirus")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diseaseCodeToEnoCode — bridge from form codes to catalog codes
// ---------------------------------------------------------------------------

describe("diseaseCodeToEnoCode", () => {
  it("maps 'rabies_confirmed' → 'rabies'", () => {
    expect(diseaseCodeToEnoCode("rabies_confirmed")).toBe("rabies");
  });

  it("maps 'rabies_suspected' → 'rabies'", () => {
    expect(diseaseCodeToEnoCode("rabies_suspected")).toBe("rabies");
  });

  it("maps 'canine_brucellosis' → 'brucelosis_canina'", () => {
    expect(diseaseCodeToEnoCode("canine_brucellosis")).toBe("brucelosis_canina");
  });

  it("maps 'visceral_leishmaniasis' → 'leishmaniasis'", () => {
    expect(diseaseCodeToEnoCode("visceral_leishmaniasis")).toBe("leishmaniasis");
  });

  it("maps 'hydatidosis' → 'hidatidosis'", () => {
    expect(diseaseCodeToEnoCode("hydatidosis")).toBe("hidatidosis");
  });

  it("passes through an unknown code unchanged", () => {
    expect(diseaseCodeToEnoCode("parvovirus")).toBe("parvovirus");
  });

  it("passes through an already-canonical ENO code unchanged", () => {
    // 'rabies' is already the catalog code — bridge should not double-map it
    expect(diseaseCodeToEnoCode("rabies")).toBe("rabies");
  });

  it("after bridging rabies_confirmed, isEnoCode returns true", () => {
    const eno = diseaseCodeToEnoCode("rabies_confirmed");
    expect(isEnoCode(eno)).toBe(true);
  });

  it("after bridging canine_brucellosis, getEnoDisease returns the disease", () => {
    const eno = diseaseCodeToEnoCode("canine_brucellosis");
    const disease = getEnoDisease(eno);
    expect(disease?.code).toBe("brucelosis_canina");
    expect(disease?.stigmaSensitive).toBe(true);
  });
});
