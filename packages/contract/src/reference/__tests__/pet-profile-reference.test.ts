// The pet-profile reference data, now in the contract so the app's "Editar
// datos" can draw the same pickers the web draws and run the same checks.
//
// TWO KINDS OF TEST LIVE HERE, and they prove different things:
//
//   · APPROVAL — the catalogs MOVED, they did not change. Each list is pinned
//     to the literal it had in `lib/reference/lookups.ts` and
//     `lib/reference/permanent-conditions.ts` before the move, so a value that
//     shifted on the way over fails here rather than surfacing as a stored
//     allergy the web picker no longer offers.
//   · BEHAVIOUR — the two age directions. The web computed "edad aproximada"
//     with `Date` getters in whatever zone the code ran in, which answers
//     differently in a browser in Buenos Aires and on a server in UTC. A drift
//     check that compares a client's age with the server's needs one answer.

import { describe, expect, it } from "vitest";

import { detectContactInfoInFreeText } from "../contact-in-free-text.ts";
import {
  PERMANENT_CONDITIONS,
  permanentConditionLabel,
  resolveLostSpecialConditions,
  sanitizeConditionCodes,
} from "../permanent-conditions.ts";
import { estimatedBirthDateFromAge, petAgeFromBirthDate } from "../pet-age.ts";
import {
  COMMON_ALLERGIES,
  COMMON_FOODS,
  INSURANCE_COMPANIES,
  TRAINING_LEVELS,
  TRAINING_LEVEL_VALUES,
} from "../pet-profile-options.ts";

describe("the profile catalogs moved without changing", () => {
  it("keeps the food list, in order", () => {
    expect(COMMON_FOODS).toEqual([
      "Comida seca (balanceada)",
      "Comida húmeda (lata / pouch)",
      "Dieta natural / BARF",
      "Dieta casera",
      "Premios / snacks",
      "Comida para edad senior",
      "Comida hipoalergénica",
      "Comida medicada / prescripción",
    ]);
  });

  it("keeps the allergy list, in order", () => {
    expect(COMMON_ALLERGIES).toEqual([
      "Pollo",
      "Carne vacuna",
      "Cerdo",
      "Pescado",
      "Lácteos",
      "Huevo",
      "Cereales (trigo, maíz)",
      "Pulgas",
      "Polen / ambiente",
      "Ácaros del polvo",
      "Picaduras de insectos",
    ]);
  });

  it("keeps the training levels with their labels, and the values the writer accepts", () => {
    expect(TRAINING_LEVELS).toEqual([
      { value: "none", label: "Ninguno" },
      { value: "basic", label: "Básico (sentarse, venir)" },
      { value: "intermediate", label: "Intermedio (obediencia general)" },
      { value: "advanced", label: "Avanzado" },
      { value: "professional", label: "Profesional / trabajo" },
    ]);
    expect(TRAINING_LEVEL_VALUES).toEqual(TRAINING_LEVELS.map((t) => t.value));
  });

  it("keeps the insurance companies offered for autocomplete", () => {
    expect(INSURANCE_COMPANIES).toEqual([
      "Mapfre Mascotas",
      "Sancor Seguros",
      "La Caja Mascotas",
      "Provincia Seguros",
      "Federación Patronal",
      "PetCheck",
    ]);
  });

  it("keeps the seventeen permanent-condition codes and their labels", () => {
    expect(PERMANENT_CONDITIONS).toEqual([
      "ciego",
      "vision_reducida",
      "sordo",
      "audicion_reducida",
      "tres_patas",
      "miembro_no_funcional",
      "paralisis_posterior",
      "usa_carrito",
      "incontinencia_urinaria",
      "incontinencia_fecal",
      "epilepsia",
      "diabetes",
      "fiv_positivo",
      "felv_positivo",
      "cardiopatia",
      "cognitiva",
      "otra",
    ]);
    expect(permanentConditionLabel("tres_patas")).toBe("Tres patas (amputación)");
    expect(sanitizeConditionCodes(["ciego", "no_existe", "otra"])).toEqual(["ciego", "otra"]);
    expect(resolveLostSpecialConditions(["sordo", "otra"], "displasia", true)).toEqual({
      labels: ["Sordo/a"],
      other: "displasia",
    });
  });
});

describe("detectContactInfoInFreeText — contact data must not reach a public field", () => {
  it("names an email", () => {
    expect(detectContactInfoInFreeText("escribime a ana@example.com")).toBe("email");
  });

  it("names a phone once the run reaches nine digits, separators included", () => {
    expect(detectContactInfoInFreeText("llamar al 11 4567-8901")).toBe("phone");
  });

  it("leaves dates and dosages alone", () => {
    expect(detectContactInfoInFreeText("desde el 01/02/2020, 2 comprimidos cada 12 horas")).toBe(
      null,
    );
  });
});

// Mid-day instants: the estimate below keeps the arithmetic the alta always
// used, which reads the clock of the machine it runs on. At noon in Buenos Aires
// that machine's day and Argentina's agree whatever its zone is.
const NOON_AR_1_OCT_2026 = new Date("2026-10-01T15:00:00Z");

describe("estimatedBirthDateFromAge — the alta's own arithmetic, unchanged", () => {
  it("subtracts the stated months from today", () => {
    expect(estimatedBirthDateFromAge({ years: 2, months: 3 }, NOON_AR_1_OCT_2026)).toBe(
      "2024-07-01",
    );
    expect(estimatedBirthDateFromAge({ years: null, months: 6 }, NOON_AR_1_OCT_2026)).toBe(
      "2026-04-01",
    );
  });

  it("answers null when no age was stated, and today when zero was", () => {
    expect(estimatedBirthDateFromAge({ years: null, months: null }, NOON_AR_1_OCT_2026)).toBeNull();
    expect(estimatedBirthDateFromAge({ years: 0, months: 0 }, NOON_AR_1_OCT_2026)).toBe(
      "2026-10-01",
    );
  });
});

describe("petAgeFromBirthDate — whole months, counted on Argentina's calendar", () => {
  it("does not count a month until its day has come", () => {
    expect(petAgeFromBirthDate("2020-03-15", new Date("2026-10-14T15:00:00Z"))).toEqual({
      years: 6,
      months: 6,
    });
    expect(petAgeFromBirthDate("2020-03-15", new Date("2026-10-15T15:00:00Z"))).toEqual({
      years: 6,
      months: 7,
    });
  });

  it("reads the day in Argentina, not the day in UTC", () => {
    // 02:00 UTC on the 15th is still 23:00 on the 14th in Buenos Aires.
    expect(petAgeFromBirthDate("2020-03-15", new Date("2026-10-15T02:00:00Z"))).toEqual({
      years: 6,
      months: 6,
    });
  });

  it("answers no age for no date, and zero for a date not yet reached", () => {
    expect(petAgeFromBirthDate(null, NOON_AR_1_OCT_2026)).toEqual({ years: null, months: null });
    expect(petAgeFromBirthDate("not-a-date", NOON_AR_1_OCT_2026)).toEqual({
      years: null,
      months: null,
    });
    expect(petAgeFromBirthDate("2027-01-01", NOON_AR_1_OCT_2026)).toEqual({ years: 0, months: 0 });
  });

  it("reads back the age an estimate was made from", () => {
    const age = { years: 2, months: 3 };
    const estimated = estimatedBirthDateFromAge(age, NOON_AR_1_OCT_2026);
    expect(petAgeFromBirthDate(estimated, NOON_AR_1_OCT_2026)).toEqual(age);
  });
});
