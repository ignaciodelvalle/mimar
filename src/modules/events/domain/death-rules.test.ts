// Unit tests for death-rules domain (TDD — written before implementation).
import { describe, expect, it } from "vitest";
import {
  DEATH_CAUSES,
  DISPOSITION_METHODS,
  type DeathCrossFieldInput,
  VET_CONTACT_VALUES,
  validateDeathCrossFields,
} from "./death-rules";

describe("DEATH_CAUSES", () => {
  it("contains the expected causes", () => {
    expect(DEATH_CAUSES).toContain("known");
    expect(DEATH_CAUSES).toContain("disease");
    expect(DEATH_CAUSES).toContain("euthanasia");
    expect(DEATH_CAUSES).toHaveLength(9);
  });
});

describe("DISPOSITION_METHODS", () => {
  it("contains the expected disposition methods", () => {
    expect(DISPOSITION_METHODS).toContain("cremation_collective");
    expect(DISPOSITION_METHODS).toContain("owner_burial");
    expect(DISPOSITION_METHODS).toContain("unknown");
    expect(DISPOSITION_METHODS).toHaveLength(7);
  });
});

describe("VET_CONTACT_VALUES", () => {
  it("contains yes, no, not_applicable", () => {
    expect(VET_CONTACT_VALUES).toEqual(["yes", "no", "not_applicable"]);
  });
});

describe("validateDeathCrossFields", () => {
  const base: DeathCrossFieldInput = {
    cause: "natural",
    dispositionMethod: null,
    vetContactedOwner: null,
    deathAtClinic: false,
    clinicName: null,
    vetDecidedAlone: false,
    diseaseCode: null,
    confirmedByLab: false,
  };

  it("returns null for a valid simple death", () => {
    expect(validateDeathCrossFields(base)).toBeNull();
  });

  it("returns error when clinicName provided but deathAtClinic=false", () => {
    const input: DeathCrossFieldInput = {
      ...base,
      deathAtClinic: false,
      clinicName: "Clínica San Jorge",
    };
    const error = validateDeathCrossFields(input);
    expect(error).not.toBeNull();
    expect(error).toContain("clínica");
  });

  it("returns error when vetContactedOwner set but deathAtClinic=false", () => {
    const input: DeathCrossFieldInput = {
      ...base,
      deathAtClinic: false,
      vetContactedOwner: "yes",
    };
    const error = validateDeathCrossFields(input);
    expect(error).not.toBeNull();
    expect(error).toContain("veterinario");
  });

  it("returns error when vetDecidedAlone=true but vetContactedOwner is not 'no'", () => {
    // vetContactedOwner='yes' + vetDecidedAlone=true → error
    const input: DeathCrossFieldInput = {
      ...base,
      deathAtClinic: true,
      vetContactedOwner: "yes",
      vetDecidedAlone: true,
    };
    const error = validateDeathCrossFields(input);
    expect(error).not.toBeNull();
    expect(error).toContain("decidió");
  });

  it("passes when deathAtClinic=true and vetContactedOwner='no' and vetDecidedAlone=true", () => {
    const input: DeathCrossFieldInput = {
      ...base,
      deathAtClinic: true,
      vetContactedOwner: "no",
      vetDecidedAlone: true,
    };
    expect(validateDeathCrossFields(input)).toBeNull();
  });

  it("returns error when cause='disease' and diseaseCode is null", () => {
    const input: DeathCrossFieldInput = {
      ...base,
      cause: "disease",
      diseaseCode: null,
    };
    const error = validateDeathCrossFields(input);
    expect(error).not.toBeNull();
  });

  it("passes when cause='disease' and diseaseCode is provided", () => {
    // "leptospirosis" is a known disease code in the catalog
    const input: DeathCrossFieldInput = {
      ...base,
      cause: "disease",
      diseaseCode: "leptospirosis",
    };
    expect(validateDeathCrossFields(input)).toBeNull();
  });

  it("returns error for invalid disease code when cause=disease", () => {
    const input: DeathCrossFieldInput = {
      ...base,
      cause: "disease",
      diseaseCode: "NOT_A_REAL_CODE",
    };
    const error = validateDeathCrossFields(input);
    expect(error).not.toBeNull();
    expect(error).toContain("Enfermedad");
  });

  it("strips disease fields silently when cause is not disease", () => {
    // Non-disease cause with a diseaseCode should still validate (fields are ignored)
    const input: DeathCrossFieldInput = {
      ...base,
      cause: "natural",
      diseaseCode: "lepto",
    };
    expect(validateDeathCrossFields(input)).toBeNull();
  });
});
