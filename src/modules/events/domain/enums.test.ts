// Unit tests for events domain enums and disclosure-prefs (TDD).
import { describe, expect, it } from "vitest";
import { type DisclosurePrefsInput, parseDisclosurePrefsSnapshot } from "./disclosure-prefs";
import { CLINICAL_SUB_KINDS, DANGEROUS_BREED_REGISTRIES, NOTE_CATEGORIES } from "./enums";

describe("NOTE_CATEGORIES", () => {
  it("contains the 5 owner-facing categories", () => {
    expect(NOTE_CATEGORIES).toContain("comportamiento");
    expect(NOTE_CATEGORIES).toContain("dieta");
    expect(NOTE_CATEGORIES).toContain("grooming");
    expect(NOTE_CATEGORIES).toContain("estado_de_animo");
    expect(NOTE_CATEGORIES).toContain("otro");
    expect(NOTE_CATEGORIES).toHaveLength(5);
  });

  it("does NOT include the system category", () => {
    expect(NOTE_CATEGORIES).not.toContain("system");
  });
});

describe("CLINICAL_SUB_KINDS", () => {
  it("contains the 5 owner-facing sub-kinds", () => {
    expect(CLINICAL_SUB_KINDS).toContain("lab_work");
    expect(CLINICAL_SUB_KINDS).toContain("imaging");
    expect(CLINICAL_SUB_KINDS).toContain("surgery");
    expect(CLINICAL_SUB_KINDS).toContain("allergy_detection");
    expect(CLINICAL_SUB_KINDS).toContain("other");
    expect(CLINICAL_SUB_KINDS).toHaveLength(5);
  });
});

describe("DANGEROUS_BREED_REGISTRIES", () => {
  it("contains the 3 PPP registries", () => {
    expect(DANGEROUS_BREED_REGISTRIES).toContain("caba_4078");
    expect(DANGEROUS_BREED_REGISTRIES).toContain("prov_14107");
    expect(DANGEROUS_BREED_REGISTRIES).toContain("other");
    expect(DANGEROUS_BREED_REGISTRIES).toHaveLength(3);
  });
});

describe("parseDisclosurePrefsSnapshot", () => {
  it("maps DisclosurePrefsInput to the event-payload snake_case shape", () => {
    const input: DisclosurePrefsInput = {
      discloseFirstNameWhenLost: true,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: true,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: true,
    };

    const snapshot = parseDisclosurePrefsSnapshot(input);

    expect(snapshot.first_name).toBe(true);
    expect(snapshot.phone).toBe(false);
    expect(snapshot.email).toBe(true);
    expect(snapshot.last_location).toBe(false);
    expect(snapshot.finder_form).toBe(true);
  });

  it("maps all-false correctly", () => {
    const input: DisclosurePrefsInput = {
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: false,
    };

    const snapshot = parseDisclosurePrefsSnapshot(input);

    expect(snapshot.first_name).toBe(false);
    expect(snapshot.phone).toBe(false);
    expect(snapshot.email).toBe(false);
    expect(snapshot.last_location).toBe(false);
    expect(snapshot.finder_form).toBe(false);
  });
});
