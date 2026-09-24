// Unit tests for the disease-legal-anchors catalog
// (spec 2026-05-19-eno-vet-direct-report-and-owner-alerts §4).

import { describe, expect, it } from "vitest";

import {
  DISEASE_LEGAL_ANCHORS,
  getLegalAnchorsForDisease,
} from "@/lib/reference/disease-legal-anchors";
import { DISEASES } from "@/lib/reference/diseases";

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
