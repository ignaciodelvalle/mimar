// The wizard's draft, judged by the server's own schema.
//
// These tests are not really about the mapping function — they are about the
// claim the mapping function makes: that this app and the route handler reach
// the SAME verdict on the same input, because they run the same zod schema. So
// most of what is asserted below is the schema's behaviour as seen through the
// draft: the coercions a hand-rolled native form would have got wrong, and the
// refusals it would have worded differently.
//
// If any of these ever disagree with `app/api/v1/pets/route.ts`, the answer is
// not to change the expectation here. It is that the two have stopped sharing a
// definition of "valid", which is the failure `packages/contract` exists to make
// impossible.

import { describe, expect, it } from "@jest/globals";

import { REGISTER_PET_INPUT_CODES, registerPetInputSchema } from "@dim/contract/input";

import { createAttemptSession } from "./idempotency";
import {
  EMPTY_DRAFT,
  type PetDraft,
  WIZARD_STEPS,
  advanceBlockedReason,
  ageFieldError,
  canAdvance,
  draftErrorMessage,
  provinceLabel,
  toRegisterPetInput,
} from "./register-input";

const VALID: PetDraft = {
  ...EMPTY_DRAFT,
  name: "Pampa",
  species: "dog",
  sex: "female",
  provinceCode: "AR-C",
  localityName: "Palermo",
};

function inputFor(overrides: Partial<PetDraft>) {
  const verdict = toRegisterPetInput({ ...VALID, ...overrides });
  if (!verdict.ok) throw new Error(`expected a valid draft, got ${verdict.code}`);
  return verdict.input;
}

describe("toRegisterPetInput — what the server requires", () => {
  it("accepts the minimum: a name, a species and a place", () => {
    expect(toRegisterPetInput(VALID).ok).toBe(true);
  });

  it("refuses each missing required field with its own sentence", () => {
    const cases: Array<[Partial<PetDraft>, string]> = [
      [{ name: "   " }, "NAME_REQUIRED"],
      [{ species: "" }, "SPECIES_REQUIRED"],
      [{ provinceCode: "" }, "PROVINCE_REQUIRED"],
      [{ localityName: "" }, "LOCALITY_REQUIRED"],
    ];
    for (const [overrides, expectedCode] of cases) {
      const verdict = toRegisterPetInput({ ...VALID, ...overrides });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.code).toBe(expectedCode);
      expect(verdict.message.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives EVERY declared code a sentence", () => {
    // Iterating the contract's array rather than listing codes: when
    // REGISTER_PET_INPUT_CODES widens, this widens with it.
    for (const code of REGISTER_PET_INPUT_CODES) {
      expect(draftErrorMessage(code).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("toRegisterPetInput — the coercions a hand-rolled form would get wrong", () => {
  it("turns blank optional text into null, not into an empty string", () => {
    const input = inputFor({ breed: "  ", color: "", estimatedWeightKg: "   " });
    expect(input.breed).toBeNull();
    expect(input.color).toBeNull();
    expect(input.estimatedWeightKg).toBeNull();
  });

  it("trims what it keeps", () => {
    expect(inputFor({ name: "  Pampa  " }).name).toBe("Pampa");
    expect(inputFor({ breed: "  Mestizo " }).breed).toBe("Mestizo");
  });

  it("parses ages from strings", () => {
    expect(inputFor({ ageYears: "3", ageMonths: "5" }).ageYears).toBe(3);
    expect(inputFor({ ageYears: "3", ageMonths: "5" }).ageMonths).toBe(5);
    expect(inputFor({ ageYears: "40" }).ageYears).toBe(40);
  });

  // alta-validacion-edad (QA on a real phone): "3310" used to CLAMP to 250 and
  // read as valid, so the confirm step showed "3310 años" and the server would
  // have stored a different number than the one on screen. Refused now, with
  // its own sentence.
  it("refuses an implausible or malformed age instead of clamping it", () => {
    const codeFor = (overrides: Partial<PetDraft>) => {
      const verdict = toRegisterPetInput({ ...VALID, ...overrides });
      return verdict.ok ? null : verdict.code;
    };
    expect(codeFor({ ageYears: "3310" })).toBe("AGE_TOO_HIGH");
    expect(codeFor({ ageYears: "41" })).toBe("AGE_TOO_HIGH");
    expect(codeFor({ ageMonths: "999999" })).toBe("AGE_TOO_HIGH");
    expect(codeFor({ ageYears: "-4" })).toBe("AGE_YEARS_INVALID");
    expect(codeFor({ ageYears: "tres" })).toBe("AGE_YEARS_INVALID");
    expect(codeFor({ ageMonths: "6,5" })).toBe("AGE_MONTHS_INVALID");
    expect(codeFor({ ageYears: "2", ageMonths: "14" })).toBe("AGE_MONTHS_OUT_OF_RANGE");
    // A cachorro's age in months alone is how people say it.
    expect(codeFor({ ageMonths: "18" })).toBeNull();
  });

  it("words the age cap with the number the schema enforced for THIS species", () => {
    expect(draftErrorMessage("AGE_TOO_HIGH", "dog")).toBe(
      "Revisá la edad: no puede pasar de 40 años.",
    );
    // `other` keeps the wider ceiling (a tortuga terrestre) — the sentence must
    // not tell its owner "40".
    expect(draftErrorMessage("AGE_TOO_HIGH", "other")).toBe(
      "Revisá la edad: no puede pasar de 250 años.",
    );
    expect(toRegisterPetInput({ ...VALID, species: "other", ageYears: "80" }).ok).toBe(true);
  });

  it("leaves an untouched age as null, which is not the same as zero", () => {
    // "Sin registrar" and "recién nacida" are different claims about an animal.
    expect(inputFor({}).ageYears).toBeNull();
    expect(inputFor({}).ageMonths).toBeNull();
  });

  it("falls back to unknown sex instead of refusing", () => {
    expect(inputFor({ sex: "" }).sex).toBe("unknown");
    expect(inputFor({ sex: "no-idea" }).sex).toBe("unknown");
    expect(inputFor({ sex: "male" }).sex).toBe("male");
  });

  it("nulls an acquisition method outside the enum", () => {
    expect(inputFor({ acquisitionMethod: "" }).acquisitionMethod).toBeNull();
    expect(inputFor({ acquisitionMethod: "teleported" }).acquisitionMethod).toBeNull();
    expect(inputFor({ acquisitionMethod: "adopted" }).acquisitionMethod).toBe("adopted");
  });

  it("defaults duplicateOverride to false and carries it when set", () => {
    expect(inputFor({}).duplicateOverride).toBe(false);
    expect(inputFor({ duplicateOverride: true }).duplicateOverride).toBe(true);
  });

  // `alta.tsx` posts `verdict.input` — this function's OUTPUT — and the route
  // re-parses it with the same schema. The promise this module's header makes
  // ("the same verdict") is only true if that re-parse succeeds. It did not,
  // for every blank optional, on the first real registration from the Play
  // build (2026-09-05): `null` went out and `null` was refused back.
  it.each([
    ["every optional blank", VALID],
    ["optionals filled", { ...VALID, breed: "Caniche", ageYears: "3", color: "Blanco" }],
  ])("produces a body the server's schema accepts back — %s", (_label, draft) => {
    const verdict = toRegisterPetInput(draft);
    if (!verdict.ok) throw new Error(`draft refused: ${verdict.code}`);
    const wire = JSON.parse(JSON.stringify(verdict.input));
    const again = registerPetInputSchema.safeParse(wire);
    expect(again.success).toBe(true);
    expect(again.success && again.data).toEqual(verdict.input);
  });
});

describe("canAdvance", () => {
  it("blocks the two steps that carry required fields", () => {
    expect(canAdvance("nombre", EMPTY_DRAFT)).toBe(false);
    expect(canAdvance("especie", EMPTY_DRAFT)).toBe(false);
    expect(canAdvance("lugar", EMPTY_DRAFT)).toBe(false);
  });

  it("lets the optional steps through — a step you cannot skip is a required field", () => {
    expect(canAdvance("raza", EMPTY_DRAFT)).toBe(true);
    expect(canAdvance("detalles", EMPTY_DRAFT)).toBe(true);
  });

  it("requires BOTH halves of the place", () => {
    expect(canAdvance("lugar", { ...EMPTY_DRAFT, provinceCode: "AR-C" })).toBe(false);
    expect(canAdvance("lugar", { ...EMPTY_DRAFT, localityName: "Palermo" })).toBe(false);
    expect(
      canAdvance("lugar", { ...EMPTY_DRAFT, provinceCode: "AR-C", localityName: "Palermo" }),
    ).toBe(true);
  });

  it("defers the final verdict to the schema", () => {
    expect(canAdvance("confirmar", VALID)).toBe(true);
    expect(canAdvance("confirmar", EMPTY_DRAFT)).toBe(false);
  });
});

describe("ageFieldError — the age refusal shown on 'detalles', not three screens later", () => {
  it("is null for a blank or plausible age", () => {
    expect(ageFieldError(VALID)).toBeNull();
    expect(ageFieldError({ ...VALID, ageYears: "12", ageMonths: "3" })).toBeNull();
  });

  it("points at the field that carries the refusal", () => {
    expect(ageFieldError({ ...VALID, ageYears: "3310" })).toEqual({
      field: "ageYears",
      message: "Revisá la edad: no puede pasar de 40 años.",
    });
    expect(ageFieldError({ ...VALID, ageYears: "2", ageMonths: "14" })).toEqual({
      field: "ageMonths",
      message: "Si pusiste años, los meses van de 0 a 11.",
    });
  });

  it("ignores other fields' refusals — the name is not this step's business", () => {
    expect(ageFieldError({ ...EMPTY_DRAFT, ageYears: "3" })).toBeNull();
    expect(ageFieldError({ ...VALID, estimatedWeightKg: "gordito" })).toBeNull();
    // …and another field failing does not hide the age's own refusal.
    expect(ageFieldError({ ...VALID, name: "", ageYears: "3310" })?.field).toBe("ageYears");
  });

  it("holds 'Continuar' on 'detalles' and says why", () => {
    const draft = { ...VALID, ageYears: "3310" };
    expect(canAdvance("detalles", draft)).toBe(false);
    expect(advanceBlockedReason("detalles", draft)).toBe(
      "Revisá la edad: no puede pasar de 40 años.",
    );
    expect(canAdvance("confirmar", draft)).toBe(false);
  });
});

describe("advanceBlockedReason — the disabled button stops being mute (CA-M5)", () => {
  it("says WHAT is missing on each step that can block", () => {
    // The button was disabled and silent: a screen reader announces "atenuado"
    // and nothing else, so nobody was told which field was holding the wizard.
    expect(advanceBlockedReason("nombre", EMPTY_DRAFT)).toBe("Escribí el nombre para seguir.");
    // U-7 (native review): the old sentence named two of the six species the
    // picker actually offers.
    expect(advanceBlockedReason("especie", EMPTY_DRAFT)).toBe("Elegí la especie para seguir.");
    expect(advanceBlockedReason("lugar", EMPTY_DRAFT)).toBe(
      "Elegí la localidad donde vive para seguir.",
    );
    // The confirm step defers to the SCHEMA'S verdict rather than naming three
    // fields it guessed at (A2-alta-asentar-01/-09/-11 gave this step rules the
    // old sentence knew nothing about: a weight, a name shape, two caps). An
    // empty draft fails on the first field of the form, and that is what it says.
    expect(advanceBlockedReason("confirmar", EMPTY_DRAFT)).toBe("Poné el nombre de tu mascota.");
  });

  it("names the field the SCHEMA refused, not the three the old copy guessed", () => {
    // The regression this replaced: "Faltan datos: revisá el nombre, la especie
    // y el lugar" under a form whose name, species and place are all filled in
    // and whose weight is the problem.
    expect(advanceBlockedReason("confirmar", { ...VALID, estimatedWeightKg: "gordito" })).toBe(
      "Poné el peso en kilos, por ejemplo 12,5.",
    );
    expect(advanceBlockedReason("confirmar", { ...VALID, name: "​​" })).toBe(
      "Ese nombre no se puede mostrar. Escribilo con letras.",
    );
  });

  it("says NOTHING when the step can advance — silence is the normal state", () => {
    // Including the two optional steps, which never block at all.
    expect(advanceBlockedReason("nombre", { ...EMPTY_DRAFT, name: "Pampa" })).toBeNull();
    expect(advanceBlockedReason("raza", EMPTY_DRAFT)).toBeNull();
    expect(advanceBlockedReason("detalles", EMPTY_DRAFT)).toBeNull();
    expect(advanceBlockedReason("confirmar", VALID)).toBeNull();
  });

  it("agrees with `canAdvance` on every step — one gate, two voices", () => {
    // The sentence is derived from the same predicate the button reads, so the
    // two cannot drift into a mute disabled button or a reason under an
    // enabled one.
    for (const step of WIZARD_STEPS) {
      for (const draft of [EMPTY_DRAFT, VALID]) {
        expect(advanceBlockedReason(step, draft) === null).toBe(canAdvance(step, draft));
      }
    }
  });
});

describe("the idempotency key across retries", () => {
  it("hands back the SAME key for every retry of one attempt", () => {
    // A new key per HTTP attempt turns the retry after a timeout — the case
    // where the first request may well have succeeded and the phone never heard
    // the answer — into a second pet. That is the failure the header exists to
    // prevent, and it is invisible until it happens to somebody.
    let generated = 0;
    const attempt = createAttemptSession(() => `key-${++generated}`);

    const first = attempt.key();
    expect(attempt.key()).toBe(first);
    expect(attempt.key()).toBe(first);
    expect(generated).toBe(1);
  });

  it("keeps the same key when the user answers a 409 with 'Registrar igual'", () => {
    // Re-sending with duplicateOverride is the SAME registration, answered
    // differently. A new key there means a flaky connection can produce two
    // pets — precisely what the duplicate dialog exists to let the user avoid.
    let generated = 0;
    const attempt = createAttemptSession(() => `key-${++generated}`);
    const before = attempt.key();
    // (the wizard flips draft.duplicateOverride here — no key change)
    expect(attempt.key()).toBe(before);
    expect(generated).toBe(1);
  });

  it("issues a NEW key only when a new registration starts", () => {
    // The other half: the same key forever would make the second real animal a
    // replay, answered 201 `wasDuplicate: true` and never created.
    let generated = 0;
    const attempt = createAttemptSession(() => `key-${++generated}`);
    const first = attempt.key();
    attempt.restart();
    expect(attempt.key()).not.toBe(first);
    expect(generated).toBe(2);
  });
});

describe("provinceLabel — F-4, 2026-09-24 review", () => {
  it("maps the ISO code to the name a person reads, not the wire's own code", () => {
    expect(provinceLabel("AR-S")).toBe("Santa Fe");
    expect(provinceLabel("AR-C")).toBe("CABA");
  });

  it("falls back to the code itself for anything outside the 24 rows", () => {
    // Cannot happen from this wizard's own picker, but a confirm screen must
    // not throw over a contract mismatch it did not cause.
    expect(provinceLabel("AR-ZZ")).toBe("AR-ZZ");
  });
});
