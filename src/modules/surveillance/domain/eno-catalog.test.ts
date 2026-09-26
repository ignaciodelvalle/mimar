// Unit tests for domain/eno-catalog.ts
// Spec source: task 1.2 — ENO_DISEASES_AR, getEnoDisease, isEnoCode, diseaseCodeToEnoCode.
// Parity: mirrors lib/eno-catalog.ts exactly — bridge codes + stigma flags are normative.

import { describe, expect, it } from "vitest";

import { DISEASES } from "@/lib/reference/diseases";

import {
  ENO_DISEASES_AR,
  ENO_EXEMPT_REPORTABLE,
  diseaseCodeToEnoCode,
  getEnoDisease,
  isEnoCode,
} from "./eno-catalog";

// ---------------------------------------------------------------------------
// ENO_DISEASES_AR catalog shape
// ---------------------------------------------------------------------------

describe("ENO_DISEASES_AR", () => {
  it("contains exactly 6 diseases", () => {
    expect(ENO_DISEASES_AR).toHaveLength(6);
  });

  // PO S6 (2026-09-26): tuberculosis enters the list under Res. CVPBA 05/2020
  // ("micobacterias") + Ley PBA 6115. The norm names no hour count; the 24 h
  // is the "<24 hs" the legal framework states for ENO in general.
  it("contains tuberculosis, 24 h, citing Res. CVPBA 05/2020 and Ley PBA 6115", () => {
    const tb = ENO_DISEASES_AR.find((d) => d.code === "tuberculosis");
    expect(tb).toBeDefined();
    expect(tb?.notifyHours).toBe(24);
    expect(tb?.stigmaSensitive).toBe(false);
    expect(tb?.legalAnchor).toContain("CVPBA 05/2020");
    expect(tb?.legalAnchor).toContain("6115");
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

  // Health audit #2: disease_reported emits "lepto"; without the bridge a
  // future disease_reported outbox rule would never see it as ENO.
  it("maps disease_reported's 'lepto' → 'leptospirosis', an ENO code", () => {
    expect(diseaseCodeToEnoCode("lepto")).toBe("leptospirosis");
    expect(isEnoCode(diseaseCodeToEnoCode("lepto"))).toBe(true);
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

// ---------------------------------------------------------------------------
// Consistency with the disease catalog (health audit #9, PO S6 2026-09-26)
// ---------------------------------------------------------------------------
//
// A disease the catalog marks `reportable` used to get an owner alert and a
// "reportable" count while never entering the legal queue. Every reportable
// code must now either bridge to an ENO code or be exempted by name, with the
// reason, so a new reportable disease cannot slip past the legal queue silently.

describe("every reportable disease is in the ENO list or explicitly exempted", () => {
  const reportable = DISEASES.filter((d) => d.reportable).map((d) => d.code);

  it("the catalog has reportable diseases to check (non-vacuity)", () => {
    expect(reportable.length).toBeGreaterThan(5);
  });

  it.each(reportable)("%s bridges to an ENO code or carries an exemption", (code) => {
    const inList = isEnoCode(diseaseCodeToEnoCode(code));
    const exemption = ENO_EXEMPT_REPORTABLE[code];
    expect(inList || (typeof exemption === "string" && exemption.length > 0)).toBe(true);
    // Never both: an exemption for a code in the list would be dead text.
    expect(inList && exemption !== undefined).toBe(false);
  });

  it("exempts exactly anthrax and toxoplasmosis, pending the PO's legal research", () => {
    expect(Object.keys(ENO_EXEMPT_REPORTABLE).sort()).toEqual(["anthrax", "toxoplasmosis"]);
    for (const reason of Object.values(ENO_EXEMPT_REPORTABLE)) {
      expect(reason).toMatch(/PO/);
    }
  });

  it("every exemption names a code the catalog really marks reportable", () => {
    for (const code of Object.keys(ENO_EXEMPT_REPORTABLE)) {
      expect(reportable).toContain(code);
    }
  });
});
