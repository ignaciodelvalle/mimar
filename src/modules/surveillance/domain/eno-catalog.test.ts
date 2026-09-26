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

/** Norms no longer in force: Res. SENASA 422/2003 (derogated, art. 22 Res. SENASA 153/2021). */
const DEROGATED = /422\s*\/\s*2003/;

// ---------------------------------------------------------------------------
// ENO_DISEASES_AR catalog shape
// ---------------------------------------------------------------------------

describe("ENO_DISEASES_AR", () => {
  // PO legal research (2026-09-26): Res. CVPBA 05/2020 says "inmediata" for its
  // whole list, cited as 24 h (also SENASA 153/2021 Grupo I and Ley PBA 5325).
  // The old 48 h / 72 h had no source. Hidatidosis is not on the CVPBA list:
  // it keeps its window, flagged "a confirmar". Anthrax (SENASA 153/2021
  // Grupo I, 24 h from suspicion) goes to SENASA, vet/lab only.
  it.each([
    ["rabies", 24, "critical", false, "sourced"],
    ["leptospirosis", 24, "high", false, "sourced"],
    ["hidatidosis", 48, "high", false, "a_confirmar"],
    ["brucelosis_canina", 24, "high", true, "sourced"],
    ["leishmaniasis", 24, "critical", true, "sourced"],
    ["tuberculosis", 24, "high", false, "sourced"],
    ["anthrax", 24, "critical", false, "sourced"],
    ["esporotricosis", 24, "high", true, "sourced"],
    ["dirofilariosis", 24, "high", false, "sourced"],
  ] as const)("%s: %i h, %s, stigma=%s, plazo %s", (code, hours, severity, stigma, status) => {
    const d = ENO_DISEASES_AR.find((x) => x.code === code);
    expect(d).toBeDefined();
    expect(d?.notifyHours).toBe(hours);
    expect(d?.severity).toBe(severity);
    expect(d?.stigmaSensitive).toBe(stigma);
    expect(d?.deadline.status).toBe(status);
  });

  it("contains exactly the nine diseases above", () => {
    expect(ENO_DISEASES_AR).toHaveLength(9);
  });

  it("tuberculosis cites Res. CVPBA 05/2020 and Ley PBA 6115", () => {
    const tb = ENO_DISEASES_AR.find((d) => d.code === "tuberculosis");
    expect(tb?.legalAnchor).toContain("CVPBA 05/2020");
    expect(tb?.legalAnchor).toContain("6115");
  });

  it("anthrax cites Res. SENASA 153/2021 Grupo I, goes to SENASA and only a vet or a lab raises it", () => {
    const anthrax = ENO_DISEASES_AR.find((d) => d.code === "anthrax");
    expect(anthrax?.legalAnchor).toContain("SENASA 153/2021");
    expect(anthrax?.authority).toBe("senasa");
    expect(anthrax?.vetOnly).toBe(true);
  });

  it("dirofilariosis is vet/lab only; the CVPBA list goes to the municipal zoonosis centre", () => {
    expect(getEnoDisease("dirofilariosis")?.vetOnly).toBe(true);
    for (const code of ["rabies", "leptospirosis", "brucelosis_canina", "esporotricosis"]) {
      expect(getEnoDisease(code)?.authority).toBe("zoonosis");
    }
  });

  it("every disease has a non-empty code, label, and legalAnchor", () => {
    for (const disease of ENO_DISEASES_AR) {
      expect(disease.code.length).toBeGreaterThan(0);
      expect(disease.label.length).toBeGreaterThan(0);
      expect(disease.legalAnchor.length).toBeGreaterThan(0);
    }
  });

  // Res. SENASA 422/2003 was derogated by art. 22 of Res. SENASA 153/2021.
  it("no disease cites a derogated norm", () => {
    for (const disease of ENO_DISEASES_AR) {
      expect(disease.legalAnchor).not.toMatch(DEROGATED);
      expect(disease.deadline.source).not.toMatch(DEROGATED);
    }
  });

  it("every plazo is sourced or explicitly 'a confirmar', and says where it comes from", () => {
    for (const disease of ENO_DISEASES_AR) {
      expect(["sourced", "a_confirmar"]).toContain(disease.deadline.status);
      expect(disease.deadline.source.length).toBeGreaterThan(0);
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

  // PO legal research (2026-09-26): toxoplasmosis is no longer reportable (no
  // norm backs it for dogs and cats; Ley 15.465 covers human cases) and
  // anthrax entered the list — nothing is exempt today.
  it("no reportable disease is exempt today; any exemption carries its reason", () => {
    expect(Object.keys(ENO_EXEMPT_REPORTABLE)).toEqual([]);
    for (const reason of Object.values(ENO_EXEMPT_REPORTABLE)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("every exemption names a code the catalog really marks reportable", () => {
    for (const code of Object.keys(ENO_EXEMPT_REPORTABLE)) {
      expect(reportable).toContain(code);
    }
  });
});
