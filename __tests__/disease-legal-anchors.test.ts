// Unit tests for the disease-legal-anchors catalog
// (spec 2026-05-19-eno-vet-direct-report-and-owner-alerts §4).

import { describe, expect, it } from "vitest";

import {
  DISEASE_LEGAL_ANCHORS,
  getLegalAnchorsForDisease,
} from "@/lib/reference/disease-legal-anchors";
import { DISEASES, findDisease } from "@/lib/reference/diseases";
import { SYMPTOMS } from "@/lib/reference/symptoms";
import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

describe("disease-legal-anchors — coverage", () => {
  it("every reportable disease has at least one legal anchor", () => {
    for (const d of DISEASES) {
      if (!d.reportable) continue;
      const anchors = DISEASE_LEGAL_ANCHORS[d.code];
      expect(anchors, `Disease ${d.code} missing legal anchor`).toBeDefined();
      expect(anchors.length, `Disease ${d.code} has empty legal anchor list`).toBeGreaterThan(0);
    }
  });
});

describe("getLegalAnchorsForDisease — jurisdiction filter", () => {
  it("national anchors apply everywhere (no jurisdiction)", () => {
    const result = getLegalAnchorsForDisease("rabies_confirmed", {
      country: "AR",
    });
    expect(result.some((r) => r.id === "ley_15465_60")).toBe(true);
    expect(result.some((r) => r.id === "res_ms_1144_2018")).toBe(true);
  });

  it("CABA rabies returns the CABA ord. 41.831", () => {
    const result = getLegalAnchorsForDisease("rabies_confirmed", {
      country: "AR",
      province: "CABA",
      locality: "Palermo",
    });
    expect(result.some((r) => r.id === "ord_caba_41831_87")).toBe(true);
    // PBA-only anchors filtered out.
    expect(result.some((r) => r.id === "dl_8056_73_pba")).toBe(false);
  });

  it("Mendoza leptospirosis returns only national anchors (no PBA-specific)", () => {
    const result = getLegalAnchorsForDisease("leptospirosis", {
      country: "AR",
      province: "Mendoza",
      locality: "Godoy Cruz",
    });
    expect(result.some((r) => r.id === "ley_15465_60")).toBe(true);
    expect(result.some((r) => r.id === "res_ms_1715_2007")).toBe(true);
    // PBA-only filtered out.
    expect(result.some((r) => r.id === "res_cvpba_05_2020")).toBe(false);
    expect(result.some((r) => r.id === "ley_5325_48_pba")).toBe(false);
  });

  it("returns an empty list for a non-reportable disease (no anchors registered)", () => {
    const result = getLegalAnchorsForDisease("parvovirus", { country: "AR" });
    expect(result).toEqual([]);
  });
});

// PO legal research (2026-09-26). The catalogue follows the norms in force.
describe("disease catalogue and anchors follow the norms in force", () => {
  it("toxoplasmosis is not reportable and carries no anchor (no norm for dogs/cats; 15.465 is human)", () => {
    expect(findDisease("toxoplasmosis")?.reportable).toBe(false);
    expect(DISEASE_LEGAL_ANCHORS.toxoplasmosis).toBeUndefined();
  });

  it("anthrax is anchored on Res. SENASA 153/2021 Grupo I", () => {
    const ids = (DISEASE_LEGAL_ANCHORS.anthrax ?? []).map((a) => a.id);
    expect(ids).toContain("res_senasa_153_2021_g1");
  });

  it("esporotricosis and dirofilariosis are reportable under Res. CVPBA 05/2020", () => {
    for (const code of ["sporotrichosis", "dirofilariasis"]) {
      expect(findDisease(code)?.reportable).toBe(true);
      expect((DISEASE_LEGAL_ANCHORS[code] ?? []).map((a) => a.id)).toContain("res_cvpba_05_2020");
    }
  });

  it("no anchor cites the derogated Res. SENASA 422/2003", () => {
    for (const anchors of Object.values(DISEASE_LEGAL_ANCHORS)) {
      for (const a of anchors) expect(`${a.id} ${a.label}`).not.toMatch(/422\s*\/\s*2003|422_2003/);
    }
  });

  // Only a vet or a lab raises a vet-only ENO disease (anthrax, dirofilariosis)
  // — never an owner's or a witness's free text.
  it("no symptom links to a vet-only ENO disease", () => {
    for (const symptom of SYMPTOMS) {
      for (const link of symptom.related_diseases) {
        expect(
          getEnoDisease(diseaseCodeToEnoCode(link.disease_code))?.vetOnly,
          `${symptom.code} → ${link.disease_code}`,
        ).not.toBe(true);
      }
    }
  });

  it("esporotricosis has the symptoms the owner actually describes", () => {
    const linked = SYMPTOMS.filter((s) =>
      s.related_diseases.some((l) => l.disease_code === "sporotrichosis"),
    ).flatMap((s) => s.synonyms);
    expect(linked).toEqual(
      expect.arrayContaining(["herida que no cura", "heridas en la nariz", "rasguñó a alguien"]),
    );
  });
});
