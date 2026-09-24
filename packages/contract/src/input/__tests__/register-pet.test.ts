// The citizen-registration input contract.
//
// WHAT THIS FILE IS FOR
// ---------------------------------------------------------------------------
// A schema in the contract package is a PROMISE to a client that cannot be
// re-deployed on demand: a native app validates against it locally, shows
// per-field copy from its codes, and then sends a body the server re-validates
// with this exact object. Every property below is something a phone in the field
// depends on.
//
// The one that already earned its keep: `acquisitionMethod` is OPTIONAL, and the
// first version of it — `.nullish().catch(null)` — refused every body that
// simply omitted the field. It read as obviously correct. It shipped a 400 for
// the most ordinary request there is.

import { describe, expect, it } from "vitest";

import { PET_COLOR_MAX, PET_NAME_MAX } from "../pet-profile-edit.ts";
import {
  MAX_ESTIMATED_WEIGHT_KG,
  MAX_PET_AGE_MONTHS,
  MAX_PET_AGE_YEARS,
  REGISTER_PET_INPUT_CODES,
  firstRegisterPetInputCode,
  registerPetInputSchema,
} from "../register-pet.ts";

/** The smallest body the schema accepts: the four things a credential needs. */
const MINIMAL = {
  name: "Pampa",
  species: "dog",
  provinceCode: "AR-C",
  localityName: "Villa Crespo",
};

describe("registerPetInputSchema — the minimum", () => {
  it("accepts a body with only the four required fields", () => {
    const parsed = registerPetInputSchema.safeParse(MINIMAL);
    expect(parsed.success).toBe(true);
  });

  it("fills every optional field with its absent value rather than leaving it undefined", () => {
    // A consumer builds a domain object out of this, and `undefined` and `null`
    // are not the same thing to a column that is `NOT NULL DEFAULT`. The schema
    // normalises so the consumer never has to.
    const parsed = registerPetInputSchema.parse(MINIMAL);
    expect(parsed).toMatchObject({
      sex: "unknown",
      breed: null,
      color: null,
      estimatedWeightKg: null,
      ageYears: null,
      ageMonths: null,
      acquisitionMethod: null,
      duplicateOverride: false,
    });
  });

  it.each(["name", "species", "provinceCode", "localityName"] as const)(
    "refuses a body with no %s",
    (field) => {
      const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, [field]: "" });
      expect(parsed.success).toBe(false);
    },
  );

  it("reports ONE code, chosen by contract order and not by zod's issue order", () => {
    // The consumer shows one message. Which one must not depend on the order zod
    // happened to collect issues in — that is a UI that changes its mind between
    // library versions.
    const parsed = registerPetInputSchema.safeParse({
      name: "",
      species: "",
      provinceCode: "",
      localityName: "",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBe("NAME_REQUIRED");
    expect(REGISTER_PET_INPUT_CODES[0]).toBe("NAME_REQUIRED");
  });

  it("reports SPECIES_REQUIRED for a species that is PRESENT but not in the vocabulary", () => {
    // The code reads "required" and covers "unusable" too, matching intake.ts's
    // INTAKE_REASON_REQUIRED. Deliberate: the consumer's answer to both is the
    // same screen — put the picker back in front of the user.
    const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, species: "dinosaurio" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBe("SPECIES_REQUIRED");
  });

  it("returns null for an error carrying no code this contract defines", () => {
    // The consumer's cue to fall back to a generic message rather than render a
    // raw zod string at an owner. `duplicateOverride` has no code because no
    // human ever types it — a client that gets it wrong is out of step with the
    // contract, not asking which field to highlight.
    const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, duplicateOverride: "true" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-01 — the weight
// ---------------------------------------------------------------------------
//
// `estimatedWeightKg` was `optionalText`: any string, unparsed, handed to a
// `numeric(5, 2)` column by the repository. The column was the validator and its
// refusals arrived as 500s.
describe("registerPetInputSchema — the estimated weight", () => {
  it("accepts the es-AR decimal comma and normalises it to a dot", () => {
    // THE DEFECT. `inputMode="decimal"` puts a comma under an Argentine thumb;
    // "12,5" reached `numeric(5, 2)` verbatim as `invalid input syntax for type
    // numeric`, which the route answered as `pet_registration_failed` 500 →
    // "Volvé a intentar en unos minutos" → a retry that re-sent the same body
    // and failed identically, with nothing naming the weight field.
    expect(registerPetInputSchema.parse({ ...MINIMAL, estimatedWeightKg: "12,5" })).toMatchObject({
      estimatedWeightKg: "12.5",
    });
  });

  it("refuses a weight the column cannot hold instead of letting it overflow", () => {
    // `numeric field value out of range` — the same 500 by the other door.
    for (const weight of ["1000", "1234,5", "99999"]) {
      const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: weight });
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(firstRegisterPetInputCode(parsed.error)).toBe("WEIGHT_INVALID");
    }
  });

  it("refuses a value that ROUNDS past the column's ceiling", () => {
    // `numeric(5, 2)` rounds to two decimals BEFORE it checks the precision, so
    // 999.999 becomes 1000.00 and overflows. Checking the typed value rather
    // than the rounded one would let exactly this through.
    expect(
      registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: "999.999" }).success,
    ).toBe(false);
    expect(
      registerPetInputSchema.safeParse({
        ...MINIMAL,
        estimatedWeightKg: String(MAX_ESTIMATED_WEIGHT_KG),
      }).success,
    ).toBe(true);
  });

  it("refuses a value that ROUNDS TO ZERO in the column (L2-9)", () => {
    // The other end of the same rounding. `'0.001'::numeric(5,2)` is `0.00` —
    // measured against the live Postgres — so a guard that reads the TYPED
    // value sees 0.001 > 0, accepts, and stores zero kilos as a fact about an
    // animal. Every one of these is a positive number that the column flattens.
    for (const weight of ["0.001", "0.004", "0,001", "0.0049", ".004"]) {
      const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: weight });
      expect(parsed.success, `${weight} rounds to 0.00`).toBe(false);
      if (parsed.success) continue;
      expect(firstRegisterPetInputCode(parsed.error)).toBe("WEIGHT_INVALID");
    }
    // NON-VACUITY: the smallest value the column CAN hold still passes, so this
    // is a floor at the column's resolution and not a new minimum weight.
    expect(
      registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: "0.01" }).success,
    ).toBe(true);
    expect(
      registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: "0.005" }).success,
    ).toBe(true);
  });

  it("refuses text that is not a weight, rather than posting it into a numeric column", () => {
    for (const weight of ["gordito", "12 kg", "12.5.6", "-5", "0", "1e3"]) {
      expect(
        registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: weight }).success,
      ).toBe(false);
    }
  });

  it("does not invent a weight nobody typed", () => {
    // Only the comma is rewritten. Collapsing internal spaces would turn "1 2"
    // into twelve kilos, which is worse than a refusal — the owner cannot see
    // the difference to check it.
    expect(registerPetInputSchema.safeParse({ ...MINIMAL, estimatedWeightKg: "1 2" }).success).toBe(
      false,
    );
  });

  // NON-VACUITY: the gate must not be refusing ordinary weights.
  it("leaves every plausible weight untouched", () => {
    for (const weight of ["0.4", "3", "12.5", "45", "150", "999.99"]) {
      expect(registerPetInputSchema.parse({ ...MINIMAL, estimatedWeightKg: weight })).toMatchObject(
        { estimatedWeightKg: weight },
      );
    }
  });

  it("accepts a NUMBER, which a JSON client has no reason to quote", () => {
    expect(registerPetInputSchema.parse({ ...MINIMAL, estimatedWeightKg: 12.5 })).toMatchObject({
      estimatedWeightKg: "12.5",
    });
  });

  it("keeps blank and absent meaning not stated", () => {
    expect(
      registerPetInputSchema.parse({ ...MINIMAL, estimatedWeightKg: "  " }).estimatedWeightKg,
    ).toBeNull();
    expect(registerPetInputSchema.parse(MINIMAL).estimatedWeightKg).toBeNull();
  });

  it("sits above the RECORDED-weight gate, because the two bound different things", () => {
    // `record-event.ts`'s MAX_WEIGHT_KG (120) is a data-quality opinion about a
    // measurement. This one is the column, and `species` includes `other` — a
    // cerdo vietnamita of 150 kg is a real registration.
    expect(MAX_ESTIMATED_WEIGHT_KG).toBe(999.99);
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-09 / -11 — the two rules the name door was missing
// ---------------------------------------------------------------------------
describe("registerPetInputSchema — the name", () => {
  it("refuses a name made only of invisible characters", () => {
    // A zero-width space is `Cf`, not `White_Space`: it survives trim(), clears
    // `min(1)`, and renders as NOTHING on the credential and the public /p page.
    // The rule existed on `completeIdentityInputSchema` and nowhere else.
    for (const name of ["​", "​​", "‮", "​ ‍"]) {
      const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, name });
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(firstRegisterPetInputCode(parsed.error)).toBe("NAME_INVALID");
    }
  });

  it("still refuses U+FEFF, which trim() eats before the shape rule sees it", () => {
    // Measured, and the reason the case above does not list it: ECMAScript's
    // WhiteSpace set includes <ZWNBSP> (U+FEFF), so `.trim()` removes it and the
    // refusal is `NAME_REQUIRED`. Same outcome by a different door — recorded so
    // nobody "fixes" the shape rule to cover a character it never receives.
    const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, name: "﻿" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBe("NAME_REQUIRED");
  });

  it("refuses a name with a bidi override buried in it", () => {
    expect(registerPetInputSchema.safeParse({ ...MINIMAL, name: "Pam‮pa" }).success).toBe(false);
  });

  it("refuses a name with no letter in it", () => {
    expect(registerPetInputSchema.safeParse({ ...MINIMAL, name: "12345" }).success).toBe(false);
    expect(registerPetInputSchema.safeParse({ ...MINIMAL, name: "---" }).success).toBe(false);
  });

  // NON-VACUITY: the rules ban what cannot be part of a name, not a list
  // somebody thought of.
  it.each(["Pampa", "Ñandú", "María José", "O'Connor", "Pampa III", "小白", "Rex-2"])(
    "accepts %s",
    (name) => {
      expect(registerPetInputSchema.safeParse({ ...MINIMAL, name }).success).toBe(true);
    },
  );

  it("caps a NEW name at the same number the edit door uses", () => {
    // A2-alta-asentar-11: alta accepted 90 characters and then Editar refused to
    // re-save the same string with "máximo 80 caracteres" — two doors onto one
    // column disagreeing about what fits in it.
    const long = "a".repeat(PET_NAME_MAX + 1);
    const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, name: long });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBe("NAME_TOO_LONG");
    expect(
      registerPetInputSchema.safeParse({ ...MINIMAL, name: "a".repeat(PET_NAME_MAX) }).success,
    ).toBe(true);
  });

  it("caps the colour at the edit door's number too", () => {
    const parsed = registerPetInputSchema.safeParse({
      ...MINIMAL,
      color: "a".repeat(PET_COLOR_MAX + 1),
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBe("COLOR_TOO_LONG");
  });

  it("reports the name's codes before the rest of the form's", () => {
    // The order is the contract: one message, and the one nearest the top of the
    // form. A name that is both too long AND unwritable is still a name problem.
    expect(REGISTER_PET_INPUT_CODES.indexOf("NAME_INVALID")).toBeLessThan(
      REGISTER_PET_INPUT_CODES.indexOf("SPECIES_REQUIRED"),
    );
    expect(REGISTER_PET_INPUT_CODES.indexOf("WEIGHT_INVALID")).toBeGreaterThan(
      REGISTER_PET_INPUT_CODES.indexOf("LOCALITY_REQUIRED"),
    );
  });
});

describe("registerPetInputSchema — the enums that fall back instead of failing", () => {
  it("defaults an absent sex to unknown", () => {
    expect(registerPetInputSchema.parse(MINIMAL).sex).toBe("unknown");
  });

  it("defaults an UNRECOGNISED sex to unknown rather than refusing the registration", () => {
    // Sex is not a claim a wrong guess could corrupt, and refusing an alta over
    // it would trade a whole credential for a field.
    expect(registerPetInputSchema.parse({ ...MINIMAL, sex: "macho" }).sex).toBe("unknown");
  });

  it("trims a padded enum — two clients sending the same intent must agree", () => {
    expect(registerPetInputSchema.parse({ ...MINIMAL, sex: " male " }).sex).toBe("male");
    expect(
      registerPetInputSchema.parse({ ...MINIMAL, acquisitionMethod: " adopted " })
        .acquisitionMethod,
    ).toBe("adopted");
  });

  it("accepts a body that OMITS acquisitionMethod entirely", () => {
    // THE REGRESSION. `.nullish().catch(null)` let an absent value reach the
    // inner enum, so omitting an optional field produced `invalid_request` on
    // every ordinary registration.
    const parsed = registerPetInputSchema.safeParse(MINIMAL);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.acquisitionMethod).toBeNull();
  });

  it("maps an unrecognised acquisitionMethod to null", () => {
    expect(
      registerPetInputSchema.parse({ ...MINIMAL, acquisitionMethod: "heredada" }).acquisitionMethod,
    ).toBeNull();
  });

  it("refuses a species outside the accepted vocabulary", () => {
    // Unlike intake's free-text species: `breedsForSpecies` keys off these
    // strings, so an unknown species silently yields an empty catalog — the same
    // class of defect the free-text breed closed.
    expect(registerPetInputSchema.safeParse({ ...MINIMAL, species: "dinosaurio" }).success).toBe(
      false,
    );
  });
});

describe("registerPetInputSchema — the estimated age", () => {
  it("accepts a NUMBER, which the FormData path could not", () => {
    // A JSON client has no reason to quote an integer.
    const parsed = registerPetInputSchema.parse({ ...MINIMAL, ageYears: 3, ageMonths: 6 });
    expect(parsed.ageYears).toBe(3);
    expect(parsed.ageMonths).toBe(6);
  });

  it("accepts a STRING, matching the web wizard byte for byte", () => {
    const parsed = registerPetInputSchema.parse({ ...MINIMAL, ageYears: "3" });
    expect(parsed.ageYears).toBe(3);
  });

  it("clamps a negative to zero and an unparseable to zero, never refusing", () => {
    // An age field is an ESTIMATE typed at a kennel door. Rejecting "aprox 2"
    // outright would block a registration over a guess.
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: "-4" }).ageYears).toBe(0);
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: "aprox 2" }).ageYears).toBe(0);
  });

  it("treats a blank string as absent, not as zero", () => {
    // Zero years is a claim ("this animal was born this year"); blank is not.
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: "  " }).ageYears).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The ceiling (WU-B review FB-2)
  // -------------------------------------------------------------------------
  //
  // The consumer DERIVES a date of birth from these two with unguarded `Date`
  // arithmetic. Both of the following were demonstrated against the endpoint
  // before the bound existed, not theorised:
  //
  //   ageYears: 3000    → the malformed date string "-000974-08" on its way into
  //                       a Postgres `date` column, i.e. a 500;
  //   ageYears: 300000  → a RangeError thrown out of toISOString(), OUTSIDE any
  //                       try/catch, so the response was not even the error
  //                       envelope this surface promises.
  //
  // The bound clamps rather than refuses, matching everything else this field
  // does: an age is an ESTIMATE, and refusing one blocks a registration over a
  // guess.
  it("clamps a year count past the ceiling instead of deriving a malformed date", () => {
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: 3000 }).ageYears).toBe(
      MAX_PET_AGE_YEARS,
    );
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: 300_000 }).ageYears).toBe(
      MAX_PET_AGE_YEARS,
    );
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: "999999999" }).ageYears).toBe(
      MAX_PET_AGE_YEARS,
    );
  });

  it("clamps months at the same ceiling, expressed in months", () => {
    // A client may state the whole age in months; the two fields were never
    // required to partition it.
    expect(registerPetInputSchema.parse({ ...MINIMAL, ageMonths: 999_999 }).ageMonths).toBe(
      MAX_PET_AGE_MONTHS,
    );
    expect(MAX_PET_AGE_MONTHS).toBe(MAX_PET_AGE_YEARS * 12);
  });

  // Measured while writing this block, and worth recording because the answer
  // is not the one the transform suggests: `z.number()` REFUSES a non-finite
  // value before any transform runs, so Infinity and NaN never reach the clamp
  // at all — the whole body is rejected and the route answers `invalid_request`.
  // Which is right: neither is an age, and neither can come out of `JSON.parse`
  // in the first place. The `Number.isFinite` guard in the transform stays as a
  // belt for a caller that builds the object in-process rather than from a wire.
  it("rejects the whole body for a non-finite number rather than clamping it", () => {
    expect(
      registerPetInputSchema.safeParse({ ...MINIMAL, ageYears: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(registerPetInputSchema.safeParse({ ...MINIMAL, ageYears: Number.NaN }).success).toBe(
      false,
    );
  });

  // NON-VACUITY: the ceiling must not be clamping ordinary ages. A dog is 12.
  it("leaves every plausible age untouched", () => {
    for (const years of [0, 1, 12, 29, 100]) {
      expect(registerPetInputSchema.parse({ ...MINIMAL, ageYears: years }).ageYears).toBe(years);
    }
  });

  // WHY THE CEILING IS 250 AND NOT 40. `species` includes `other`, and in
  // Argentina that is routinely a tortuga terrestre — 50-100 years is ordinary
  // for one, and they are handed down within a family. A ceiling tight enough
  // to look sensible for dogs would silently mangle a legitimate entry.
  it("clears the longest-lived companion animal by a wide margin", () => {
    expect(MAX_PET_AGE_YEARS).toBeGreaterThan(150);
  });

  // The derived date must stay a well-formed four-digit ISO year — the actual
  // job of the bound. Worst case is both fields at their ceiling: 500 years.
  it("keeps the worst-case derived date representable", () => {
    const totalMonths = MAX_PET_AGE_YEARS * 12 + MAX_PET_AGE_MONTHS;
    const dob = new Date();
    dob.setMonth(dob.getMonth() - totalMonths);
    expect(dob.toISOString().slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("registerPetInputSchema — duplicateOverride", () => {
  it("defaults to false, so the SAFE value is what an unaware client sends", () => {
    expect(registerPetInputSchema.parse(MINIMAL).duplicateOverride).toBe(false);
  });

  it('refuses the STRING "true" — overriding a data-quality gate is a deliberate act', () => {
    // No string coercion on purpose. A client that stringifies its booleans
    // should find out here, not by silently creating a second animal.
    expect(
      registerPetInputSchema.safeParse({ ...MINIMAL, duplicateOverride: "true" }).success,
    ).toBe(false);
  });
});

describe("registerPetInputSchema — its own output is a valid input", () => {
  // The native wizard parses its draft with this schema and sends `parsed.data`
  // as the body; the route parses that body with the same schema. The promise
  // only holds if everything the schema EMITS is something it ACCEPTS. It was
  // broken for every blank optional (`null` out, `null` refused in) and the
  // first real registration from the Play build answered 400 (2026-09-05).
  const FULL = {
    ...MINIMAL,
    sex: "female",
    breed: "Caniche",
    color: "Blanco",
    estimatedWeightKg: "5",
    ageYears: "3",
    ageMonths: "2",
    // A MEMBER of ACQUISITION_METHODS, deliberately: anything else is mapped
    // to null by the preprocess, and this case would then round-trip the same
    // null the minimum already covers.
    acquisitionMethod: "adopted",
    duplicateOverride: true,
  };

  it.each([
    ["the minimum — every optional blank, so every optional is emitted as null", MINIMAL],
    ["a body with every optional filled", FULL],
  ])("re-parses %s to a deep-equal value after a JSON round-trip", (_label, body) => {
    const out = registerPetInputSchema.parse(body);
    const again = registerPetInputSchema.safeParse(JSON.parse(JSON.stringify(out)));
    expect(again.success).toBe(true);
    expect(again.success && again.data).toEqual(out);
  });

  it("keeps a filled optional filled across the round-trip — the FULL case is not the minimum in disguise", () => {
    const out = registerPetInputSchema.parse(FULL);
    expect(out).toMatchObject({
      breed: "Caniche",
      estimatedWeightKg: "5",
      ageYears: 3,
      ageMonths: 2,
      acquisitionMethod: "adopted",
    });
  });

  it.each(["breed", "color", "estimatedWeightKg", "ageYears", "ageMonths"] as const)(
    "accepts an explicit null for %s and reads it as not stated",
    (field) => {
      const parsed = registerPetInputSchema.safeParse({ ...MINIMAL, [field]: null });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data[field]).toBeNull();
    },
  );
});

describe("registerPetInputSchema — what it deliberately does NOT accept", () => {
  it.each(["microchipId", "clientIdempotencyKey", "custodyKind", "photo"])(
    "ignores %s rather than honouring it",
    (field) => {
      // Each is absent for a stated reason (see the schema's header): the chip is
      // a protocol with no native counterpart yet, the idempotency key is an HTTP
      // header on this transport, custody is its own flow, and the photo needs
      // multipart. An extra key must be DROPPED, never silently carried into a
      // domain object as if the endpoint supported it.
      const parsed = registerPetInputSchema.parse({ ...MINIMAL, [field]: "something" });
      expect(parsed).not.toHaveProperty(field);
    },
  );
});
