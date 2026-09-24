// Unit tests for pet-form.ts — pure, no DB, no Next.js.
// Written FIRST (RED phase, task 1.1) before creating pet-form.ts.

import { describe, expect, it } from "vitest";

import { parsePetForm } from "../pet-form";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) fd.append(key, v);
    } else {
      fd.set(key, value);
    }
  }
  return fd;
}

const BASE_VALID: Record<string, string> = {
  name: "Rex",
  species: "dog",
  sex: "male",
  localityName: "La Plata",
  provinceCode: "AR-B",
};

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe("parsePetForm — required fields", () => {
  it("returns error when name is blank", () => {
    const fd = makeFormData({ ...BASE_VALID, name: "" });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "Falta el nombre." });
  });

  it("returns error when name is whitespace only", () => {
    const fd = makeFormData({ ...BASE_VALID, name: "   " });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "Falta el nombre." });
  });

  it("returns error when species is blank", () => {
    const fd = makeFormData({ ...BASE_VALID, species: "" });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "Falta la especie." });
  });

  it("returns parsed when both name and species are present", () => {
    const fd = makeFormData(BASE_VALID);
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed).not.toBeNull();
    expect(result.parsed?.name).toBe("Rex");
    expect(result.parsed?.species).toBe("dog");
  });

  it("returns LOCALITY_REQUIRED when localityName is missing", () => {
    const { localityName: _omitted, ...withoutLocality } = BASE_VALID;
    const fd = makeFormData(withoutLocality);
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "LOCALITY_REQUIRED" });
  });

  it("returns LOCALITY_REQUIRED when localityName is blank", () => {
    const fd = makeFormData({ ...BASE_VALID, localityName: "  " });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "LOCALITY_REQUIRED" });
  });
});

// ---------------------------------------------------------------------------
// Locality must resolve to a real catalog row (PO decision 2026-07-08)
// A locality typed by hand that never resolved via the autocomplete arrives
// with NO province (the autocomplete only emits a province when a real
// ar_localities result is picked). Such free text must be rejected so junk
// localities never enter the national registry.
// ---------------------------------------------------------------------------

describe("parsePetForm — locality must resolve to a real locality", () => {
  it("accepts a resolved locality (province + locality present)", () => {
    const fd = makeFormData(BASE_VALID);
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.jurisdictionProvince).toBe("Buenos Aires");
    expect(result.parsed?.jurisdictionLocality).toBe("La Plata");
  });

  it("accepts a CABA barrio picked via the province-first cascade (AR-C → Palermo)", () => {
    // The alta cascade scopes the locality search to CABA (AR-C) and the user
    // picks the Palermo barrio. The wire contract is identical to any other
    // resolved pick — provinceCode drives storage-name canonicalization.
    const fd = makeFormData({ ...BASE_VALID, localityName: "Palermo", provinceCode: "AR-C" });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.jurisdictionProvince).toBe("CABA");
    expect(result.parsed?.jurisdictionLocality).toBe("Palermo");
  });

  it("rejects a free-typed locality that never resolved (no provinceCode)", () => {
    const { provinceCode: _omitted, ...withoutProvince } = BASE_VALID;
    const fd = makeFormData({ ...withoutProvince, localityName: "Villa Inventada" });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "LOCALITY_UNRESOLVED" });
  });

  it("rejects when the provinceCode is unresolvable garbage", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      localityName: "Villa Inventada",
      provinceCode: "NOT-A-CODE",
    });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "LOCALITY_UNRESOLVED" });
  });

  it("checks locality emptiness before province resolution", () => {
    // Empty locality + empty province → LOCALITY_REQUIRED wins (locality first).
    const fd = makeFormData({ name: "Rex", species: "dog", localityName: "" });
    const result = parsePetForm(fd);
    expect(result).toMatchObject({ parsed: null, error: "LOCALITY_REQUIRED" });
  });
});

// ---------------------------------------------------------------------------
// Age → DOB conversion
// ---------------------------------------------------------------------------

describe("parsePetForm — age to dateOfBirth", () => {
  it("computes DOB from ageYears only and sets birthDateIsEstimated=true", () => {
    const fd = makeFormData({ ...BASE_VALID, ageYears: "2" });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.birthDateIsEstimated).toBe(true);
    expect(result.parsed?.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("computes DOB from ageMonths only", () => {
    const fd = makeFormData({ ...BASE_VALID, ageMonths: "6" });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.birthDateIsEstimated).toBe(true);
    expect(result.parsed?.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("produces null dateOfBirth when neither ageYears nor ageMonths present", () => {
    const fd = makeFormData(BASE_VALID);
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.dateOfBirth).toBeNull();
    expect(result.parsed?.birthDateIsEstimated).toBe(false);
  });

  it("clamps negative age values to 0", () => {
    const fd = makeFormData({ ...BASE_VALID, ageYears: "-3" });
    const result = parsePetForm(fd);
    // -3 clamped to 0; same as 0 months → same as no age provided in practice
    expect(result.error).toBeNull();
    // 0 years 0 months → still triggers DOB path (ageYears !== null)
    expect(result.parsed?.birthDateIsEstimated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chip-field gating (chip sub-fields only populated when microchipId present)
// ---------------------------------------------------------------------------

describe("parsePetForm — microchip field gating", () => {
  it("nullifies chip sub-fields when microchipId is blank", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      microchipId: "",
      microchipCountryCode: "076",
      microchipImplantedAt: "2023-01-01",
      microchipImplantedBy: "Dr. Smith",
      microchipLocation: "interscapular",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.microchipId).toBeNull();
    expect(result.parsed?.microchipCountryCode).toBeNull();
    expect(result.parsed?.microchipImplantedAt).toBeNull();
    expect(result.parsed?.microchipImplantedBy).toBeNull();
    expect(result.parsed?.microchipLocation).toBeNull();
  });

  it("preserves chip sub-fields when microchipId is set", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      microchipId: "982000411234567",
      microchipCountryCode: "076",
      microchipImplantedBy: "Dr. Smith",
      microchipLocation: "interscapular",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.microchipId).toBe("982000411234567");
    expect(result.parsed?.microchipCountryCode).toBe("076");
    expect(result.parsed?.microchipImplantedBy).toBe("Dr. Smith");
    expect(result.parsed?.microchipLocation).toBe("interscapular");
  });
});

// ---------------------------------------------------------------------------
// CSV / getAll merge for favouriteFoods and knownAllergies
// ---------------------------------------------------------------------------

describe("parsePetForm — csv/other merge for list fields", () => {
  it("merges getAll values and csv other for favouriteFoods", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      favouriteFoods: ["chicken", "rice"],
      favouriteFoodsOther: "tuna, sardines",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.favouriteFoods).toEqual(["chicken", "rice", "tuna", "sardines"]);
  });

  it("filters blank entries from list fields", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      favouriteFoodsOther: " , , ",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.favouriteFoods).toEqual([]);
  });

  it("merges knownAllergies with other field", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      knownAllergies: ["pollen"],
      knownAllergiesOther: "dust",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.knownAllergies).toEqual(["pollen", "dust"]);
  });
});

// ---------------------------------------------------------------------------
// permanentConditions sanitize (CSV column → catalog filter)
// ---------------------------------------------------------------------------

describe("parsePetForm — permanentConditions sanitize", () => {
  it("keeps valid condition codes from CSV string", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "ciego,epilepsia",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditions).toEqual(["ciego", "epilepsia"]);
  });

  it("drops unrecognized codes from CSV", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "ciego,NOT_A_CONDITION,epilepsia",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditions).toEqual(["ciego", "epilepsia"]);
  });

  it("returns empty array when permanentConditions is blank", () => {
    const fd = makeFormData({ ...BASE_VALID });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discloseConditionsPublicly normalize
// ---------------------------------------------------------------------------

describe("parsePetForm — disclose flag normalization", () => {
  it("sets discloseConditionsPublicly=false when no conditions", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "",
      discloseConditionsPublicly: "true",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.discloseConditionsPublicly).toBe(false);
  });

  it("preserves discloseConditionsPublicly=true when conditions are set", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "ciego",
      discloseConditionsPublicly: "true",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.discloseConditionsPublicly).toBe(true);
  });

  it("preserves discloseConditionsPublicly=false even when conditions are set", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "ciego",
      discloseConditionsPublicly: "false",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.discloseConditionsPublicly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// permanentConditionsOther — 'otra' gating
// ---------------------------------------------------------------------------

describe("parsePetForm — permanentConditionsOther normalize", () => {
  it("nullifies permanentConditionsOther when 'otra' is not selected", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "ciego",
      permanentConditionsOther: "some text",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditionsOther).toBeNull();
  });

  it("preserves permanentConditionsOther when 'otra' is selected", () => {
    const fd = makeFormData({
      ...BASE_VALID,
      permanentConditions: "otra",
      permanentConditionsOther: "rare disease",
    });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditionsOther).toBe("rare disease");
  });
});

// ---------------------------------------------------------------------------
// permanentConditionsOther — PII guard (privacy hardening 2026-07-04)
// The free text can render on the public credential; phone/email must be
// rejected on save.
// ---------------------------------------------------------------------------

describe("parsePetForm — permanentConditionsOther PII guard", () => {
  function parseWithOther(text: string) {
    return parsePetForm(
      makeFormData({
        ...BASE_VALID,
        permanentConditions: "otra",
        permanentConditionsOther: text,
      }),
    );
  }

  it("rejects an email address in the free text", () => {
    const result = parseWithOther("Condición rara, escribime a maria@example.com");
    expect(result.parsed).toBeNull();
    expect(result.error).toContain("teléfonos ni emails");
  });

  it("rejects a phone number with separators in the free text", () => {
    const result = parseWithOther("Diabetes, llamar al 11-5555-1234");
    expect(result.parsed).toBeNull();
    expect(result.error).toContain("teléfonos ni emails");
  });

  it("rejects an international-format phone number", () => {
    const result = parseWithOther("Urgencias: +54 9 11 5555 1234");
    expect(result.parsed).toBeNull();
    expect(result.error).toContain("teléfonos ni emails");
  });

  it("accepts medical free text with small numbers and dates", () => {
    const result = parseWithOther("Toma 2 pastillas cada 8 horas desde el 01/02/2020");
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditionsOther).toBe(
      "Toma 2 pastillas cada 8 horas desde el 01/02/2020",
    );
  });

  it("does not run the guard when 'otra' is not selected (text is dropped)", () => {
    const result = parsePetForm(
      makeFormData({
        ...BASE_VALID,
        permanentConditions: "ciego",
        permanentConditionsOther: "llamar al 11-5555-1234",
      }),
    );
    expect(result.error).toBeNull();
    expect(result.parsed?.permanentConditionsOther).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// custodyKind
// ---------------------------------------------------------------------------

describe("parsePetForm — custodyKind", () => {
  it("defaults custodyKind to owner when not provided", () => {
    const fd = makeFormData(BASE_VALID);
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.custodyKind).toBe("owner");
  });

  it("parses custodyKind=foster_in_transit correctly", () => {
    const fd = makeFormData({ ...BASE_VALID, custodyKind: "foster_in_transit" });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.custodyKind).toBe("foster_in_transit");
  });

  it("falls back to owner for unrecognized custodyKind values", () => {
    const fd = makeFormData({ ...BASE_VALID, custodyKind: "something_else" });
    const result = parsePetForm(fd);
    expect(result.error).toBeNull();
    expect(result.parsed?.custodyKind).toBe("owner");
  });
});
