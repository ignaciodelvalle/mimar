// lib/ui/view-scope-caption.test.ts — unit tests for describeNarrowedView
// (C3, ONE VIEWSCOPE). Pure function, no DB.

import { describe, expect, it } from "vitest";

import { describeNarrowedView } from "@/lib/ui/view-scope-caption";

describe("describeNarrowedView", () => {
  it("admin, national (no province drill) → null", () => {
    expect(describeNarrowedView({ role: "admin", mandateJurisdictions: [] })).toBeNull();
  });

  it("admin drilled to a province (no locality) → the province", () => {
    expect(
      describeNarrowedView({
        role: "admin",
        mandateJurisdictions: [],
        adminProvince: "CABA",
      }),
    ).toBe("CABA");
  });

  it("admin drilled to province + locality → 'locality, province'", () => {
    expect(
      describeNarrowedView({
        role: "admin",
        mandateJurisdictions: [],
        adminProvince: "CABA",
        adminLocality: "Palermo",
      }),
    ).toBe("Palermo, CABA");
  });

  it("govt, unfiltered — effective view equals the mandate → null", () => {
    const jurisdictions = [
      { province: "CABA", locality: "Palermo" },
      { province: "CABA", locality: "Recoleta" },
    ];
    expect(
      describeNarrowedView({
        role: "govt",
        mandateJurisdictions: jurisdictions,
        effectiveJurisdictions: jurisdictions,
      }),
    ).toBeNull();
  });

  it("govt, multi-locality mandate filtered down to ONE of them → that locality", () => {
    expect(
      describeNarrowedView({
        role: "govt",
        mandateJurisdictions: [
          { province: "CABA", locality: "Palermo" },
          { province: "CABA", locality: "Recoleta" },
        ],
        effectiveJurisdictions: [{ province: "CABA", locality: "Palermo" }],
      }),
    ).toBe("Palermo, CABA");
  });

  it("THE FIX — single WHOLE-PROVINCE mandate drilled to ONE locality (same length!) → that locality", () => {
    // Mandate is length-1 (whole CABA); a ?locality= drill to Palermo is ALSO
    // length-1 — a naive length comparison would miss this narrowing entirely.
    expect(
      describeNarrowedView({
        role: "govt",
        mandateJurisdictions: [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
        effectiveJurisdictions: [{ province: "CABA", locality: "Palermo" }],
      }),
    ).toBe("Palermo, CABA");
  });

  it("govt, single whole-province mandate with NO drill → null (view equals mandate)", () => {
    const jurisdictions = [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }];
    expect(
      describeNarrowedView({
        role: "govt",
        mandateJurisdictions: jurisdictions,
        effectiveJurisdictions: jurisdictions,
      }),
    ).toBeNull();
  });

  it("govt, multi-locality mandate filtered to several (still a subset, one province) → 'N localidades · province'", () => {
    expect(
      describeNarrowedView({
        role: "govt",
        mandateJurisdictions: [
          { province: "CABA", locality: "Palermo" },
          { province: "CABA", locality: "Recoleta" },
          { province: "CABA", locality: "Retiro" },
        ],
        effectiveJurisdictions: [
          { province: "CABA", locality: "Palermo" },
          { province: "CABA", locality: "Recoleta" },
        ],
      }),
    ).toBe("2 localidades · CABA");
  });

  it("govt, empty effective view (no-scope state) → null (handled elsewhere)", () => {
    expect(
      describeNarrowedView({
        role: "govt",
        mandateJurisdictions: [{ province: "CABA", locality: "Palermo" }],
        effectiveJurisdictions: [],
      }),
    ).toBeNull();
  });
});
