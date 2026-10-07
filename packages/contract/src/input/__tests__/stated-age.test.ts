// The edit door's age rule (alta-validacion-edad, 2026-10-07): a TYPED age is
// held to the alta's rule; one posted back as the stored date reads is not.
//
// The alta side of the rule is pinned through `registerPetInputSchema` in
// `register-pet.test.ts`; this file pins what only an edit has — the stored date.

import { describe, expect, it } from "vitest";

import { ageMatchesBirthDate } from "../../reference/pet-age.ts";
import { editedAgeRefusal } from "../stated-age.ts";

// 2026-10-01, noon in Buenos Aires.
const NOW = new Date("2026-10-01T15:00:00.000Z");

const edit = (
  ageYears: unknown,
  ageMonths: unknown,
  stored: string | null = "2023-03-10",
  species = "dog",
) => editedAgeRefusal({ species, ageYears, ageMonths }, stored, NOW);

describe("editedAgeRefusal", () => {
  it("passes the age the stored date reads as, posted back as the form showed it", () => {
    // 2023-03-10 reads as 3 years 6 months on 2026-10-01.
    expect(edit("3", "6")).toBeNull();
    expect(edit(3, 6)).toBeNull();
  });

  it("passes an IMPLAUSIBLE stored age posted back untouched — no lock-out", () => {
    // A dog born in 1950 (76 years), written while the door clamped at 250.
    expect(edit("76", "4", "1950-05-01")).toBeNull();
  });

  it("refuses the same kind of number once it is TYPED", () => {
    expect(edit("3310", "")).toBe("AGE_TOO_HIGH");
    expect(edit("77", "0", "1950-05-01")).toBe("AGE_TOO_HIGH");
  });

  it("holds a typed age to the alta's boundaries", () => {
    expect(edit("40", "0")).toBeNull();
    expect(edit("40", "1")).toBe("AGE_TOO_HIGH");
    expect(edit("41", null)).toBe("AGE_TOO_HIGH");
    expect(edit("2", "12")).toBe("AGE_MONTHS_OUT_OF_RANGE");
    expect(edit(null, "18")).toBeNull();
    expect(edit("80", null, null, "other")).toBeNull();
  });

  it("refuses a malformed age always — a form only ever SHOWS whole numbers", () => {
    expect(edit("aprox 2", "")).toBe("AGE_YEARS_INVALID");
    expect(edit("3", "-1")).toBe("AGE_MONTHS_INVALID");
    expect(edit(2.5, null)).toBe("AGE_YEARS_INVALID");
  });

  it("passes a blank age, which clears the date", () => {
    expect(edit("", "")).toBeNull();
    expect(edit(null, null, null)).toBeNull();
  });

  it("applies the rule to a first age on an animal with no stored date", () => {
    expect(edit("3", "0", null)).toBeNull();
    expect(edit("3310", "0", null)).toBe("AGE_TOO_HIGH");
  });
});

describe("ageMatchesBirthDate — the ±1-day window an edit compares in", () => {
  it("matches today's reading and a reading a day either side", () => {
    // 2023-03-10 turns 3y7m on 2026-10-10; on the 9th it reads 3y6m.
    const eve = new Date("2026-10-09T15:00:00.000Z");
    expect(ageMatchesBirthDate("2023-03-10", { years: 3, months: 6 }, eve)).toBe(true);
    expect(ageMatchesBirthDate("2023-03-10", { years: 3, months: 7 }, eve)).toBe(true);
    expect(ageMatchesBirthDate("2023-03-10", { years: 3, months: 8 }, eve)).toBe(false);
  });
});
