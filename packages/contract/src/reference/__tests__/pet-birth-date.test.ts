// The birth-date plausibility rule (alta-validacion-edad, 2026-10-07).
//
// Neither alta client asks for an exact birth date today — both state an age,
// and the server derives an estimated date from it. This is the rule that date
// must satisfy, and the one a client that grows a date field will run: not in
// the future, not before the species' plausibility floor, a real calendar day.

import { describe, expect, it } from "vitest";

import {
  MAX_STATED_AGE_YEARS,
  birthDateRefusal,
  estimatedBirthDateFromAge,
  maxStatedAgeYears,
} from "../pet-age.ts";

// 2026-10-07 at 15:00 in Buenos Aires (18:00 UTC) — the same day on both calendars.
const AFTERNOON_AR = new Date("2026-10-07T18:00:00Z");

describe("birthDateRefusal", () => {
  it("accepts today and an ordinary past date", () => {
    expect(birthDateRefusal("2026-10-07", "dog", AFTERNOON_AR)).toBeNull();
    expect(birthDateRefusal("2020-03-15", "cat", AFTERNOON_AR)).toBeNull();
  });

  it("refuses a date in the future", () => {
    expect(birthDateRefusal("2026-10-08", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_IN_FUTURE");
    expect(birthDateRefusal("3310-01-01", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_IN_FUTURE");
  });

  it("refuses a date before the floor, which is MAX_STATED_AGE_YEARS back, inclusive", () => {
    expect(MAX_STATED_AGE_YEARS).toBe(40);
    expect(birthDateRefusal("1986-10-07", "dog", AFTERNOON_AR)).toBeNull();
    expect(birthDateRefusal("1986-09-07", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_TOO_OLD");
    expect(birthDateRefusal("1716-01-01", "ferret", AFTERNOON_AR)).toBe("BIRTH_DATE_TOO_OLD");
    // A real day in the first century is old, not malformed.
    expect(birthDateRefusal("0050-01-01", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_TOO_OLD");
  });

  it("gives `other` (a tortuga terrestre) the wider floor", () => {
    expect(maxStatedAgeYears("other")).toBeGreaterThan(MAX_STATED_AGE_YEARS);
    expect(birthDateRefusal("1950-05-01", "other", AFTERNOON_AR)).toBeNull();
  });

  it("applies the generic cap to an unknown or absent species", () => {
    expect(maxStatedAgeYears(null)).toBe(MAX_STATED_AGE_YEARS);
    expect(birthDateRefusal("1950-05-01", undefined, AFTERNOON_AR)).toBe("BIRTH_DATE_TOO_OLD");
  });

  it("refuses something that is not a calendar day", () => {
    expect(birthDateRefusal("2026-02-30", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_INVALID");
    expect(birthDateRefusal("07/10/2026", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_INVALID");
    expect(birthDateRefusal("", "dog", AFTERNOON_AR)).toBe("BIRTH_DATE_INVALID");
  });

  // The derivation writes UTC's day. At 22:00 in Buenos Aires that is already
  // tomorrow in UTC; an age of 0 must not read as a future birth.
  it("accepts the date an age of 0 derives in Argentina's late evening", () => {
    const lateEvening = new Date("2026-10-08T01:00:00Z"); // 22:00 on the 7th in AR
    const derived = estimatedBirthDateFromAge({ years: 0, months: 0 }, lateEvening);
    expect(derived).toBe("2026-10-08");
    expect(birthDateRefusal(derived as string, "dog", lateEvening)).toBeNull();
  });

  it("accepts every date the derivation produces from the oldest age the schema allows", () => {
    for (const species of ["dog", "other"] as const) {
      const derived = estimatedBirthDateFromAge(
        { years: maxStatedAgeYears(species), months: 0 },
        AFTERNOON_AR,
      );
      expect(birthDateRefusal(derived as string, species, AFTERNOON_AR), species).toBeNull();
    }
  });
});
