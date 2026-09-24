// A2-alta-asentar-09 — the name rule, and the four doors that have to share it.
//
// `completeIdentityInputSchema` grew the predicate after the 2026-09-05 security
// review and kept it to itself. The registry has four doors onto a
// human-readable name and three of them accepted exactly what step 2 refused: a
// pet name of zero-width spaces (blank on the credential and on the public /p
// page), a rename to the same, and a `displayName` that leaves the titular
// nameless everywhere while every gate reports the identity complete.
//
// So the assertions here are per DOOR, not per regex. A test of the helper alone
// would have passed on the day the hole existed.
//
// SECOND ROUND (lote L2, finding L2-1). The rule above shipped banning `\p{C}`,
// and `\p{C}` is not the subject — it is the set of spellings somebody had
// thought of. The four Unicode HANGUL FILLERS are `\p{L}`, are not `\p{C}`, are
// not `White_Space`, and render as nothing, so a display name of two of them
// walked through all five doors with the rule in place. The corpus below now
// carries them, and the check that they are `\p{L}` and not `\p{C}` is what
// stops a future "simplification" back to the category that could not see them.

import { describe, expect, it } from "vitest";

import { completeIdentityInputSchema } from "../complete-identity.ts";
import { firstMyProfileEditInputCode, myProfileEditInputSchema } from "../my-profile-edit.ts";
import {
  firstPetProfileCommandInputCode,
  petProfileCommandInputSchema,
} from "../pet-profile-edit.ts";
import { firstRegisterPetInputCode, registerPetInputSchema } from "../register-pet.ts";
import { isWritableName } from "../writable-name.ts";

/** Strings that TRIM to something non-empty and render as nothing (or reversed). */
const UNWRITABLE = [
  ["a zero-width space", "​"],
  ["two zero-width spaces", "​​"],
  ["a right-to-left override", "‮"],
  ["a zero-width joiner between spaces", " ‍ ​"],
  ["a name with an embedded override", "Pam‮pa"],
  ["a newline", "Pam\npa"],
  ["digits only", "12345"],
  ["punctuation only", "---"],
] as const;

/**
 * The four Unicode Hangul fillers, by CODE POINT.
 *
 * Built with `String.fromCodePoint` rather than pasted: there is no glyph to
 * read, so a literal in this file would be a string nobody reviewing the diff
 * could tell apart from an empty one — which is the whole defect.
 */
const HANGUL_FILLER_CODE_POINTS = [
  [0x3164, "HANGUL FILLER"],
  [0x115f, "HANGUL CHOSEONG FILLER"],
  [0x1160, "HANGUL JUNGSEONG FILLER"],
  [0xffa0, "HALFWIDTH HANGUL FILLER"],
] as const;

const filler = (cp: number, times = 1): string =>
  String.fromCodePoint(...Array.from({ length: times }, () => cp));

/** The same subject, one general category over. See the header. */
const DEFAULT_IGNORABLE: Array<readonly [string, string]> = [
  ...HANGUL_FILLER_CODE_POINTS.map(
    ([cp, name]) => [`a ${name}`, filler(cp)] as readonly [string, string],
  ),
  // The measured one: trims to length 2, so it clears every MIN_LENGTH the
  // doors impose, and renders as nothing on the credential.
  ["two HANGUL FILLERs", filler(0x3164, 2)],
  ["a real name padded with HANGUL FILLERs", `${filler(0x3164)}Pampa${filler(0x3164)}`],
];

/** Real names, of people and of animals. The rules must not touch any of them. */
const WRITABLE = [
  "Pampa",
  "Ñandú-López",
  "María José",
  "O'Connor",
  "D'Angelo",
  "Pampa III",
  "Rex 2",
  "小白",
  "Αθηνά",
] as const;

describe("isWritableName", () => {
  it.each([...UNWRITABLE, ...DEFAULT_IGNORABLE])("refuses %s", (_label, value) => {
    expect(isWritableName(value)).toBe(false);
  });

  // NON-VACUITY FOR THE SECOND ROUND, and the reason the fix is a property
  // rather than four more characters: these strings are exactly what a rule
  // written as "ban `\p{C}`, require `\p{L}`" is blind to. If this ever goes
  // red, Unicode moved and the corpus above stopped testing what it claims to.
  it("the fillers are the shape the FIRST version of the rule could not see", () => {
    for (const [cp, name] of HANGUL_FILLER_CODE_POINTS) {
      const value = filler(cp);
      expect(/\p{L}/u.test(value), `${name} is a letter`).toBe(true);
      expect(/\p{C}/u.test(value), `${name} is NOT in the Other category`).toBe(false);
      expect(value.trim().length, `${name} survives trim()`).toBe(1);
    }
  });

  it.each(WRITABLE)("accepts %s", (value) => {
    expect(isWritableName(value)).toBe(true);
  });

  it("does not trim — length is each door's business, shape is this one's", () => {
    // The doors trim before they refine; the helper is deliberately not in that
    // business, so a caller that forgets to trim gets a shape verdict about the
    // string it actually holds.
    expect(isWritableName("  Pampa  ")).toBe(true);
  });
});

describe("the four doors onto a name", () => {
  const PET = {
    name: "Pampa",
    species: "dog",
    provinceCode: "AR-C",
    localityName: "Villa Crespo",
  };

  it("alta step 1 refuses an unwritable pet name", () => {
    const parsed = registerPetInputSchema.safeParse({ ...PET, name: "​​" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstRegisterPetInputCode(parsed.error)).toBe("NAME_INVALID");
  });

  it("Editar mascota refuses a RENAME to an unwritable name", () => {
    const parsed = petProfileCommandInputSchema.safeParse({
      command: "edit_identity",
      name: "​​",
      breed: null,
      color: null,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstPetProfileCommandInputCode(parsed.error)).toBe("NAME_INVALID");
  });

  it("Mis datos refuses an unwritable display name", () => {
    // Two zero-width spaces are TWO characters: they clear
    // `DISPLAY_NAME_MIN_LENGTH` and saved before this rule existed.
    const parsed = myProfileEditInputSchema.safeParse({ displayName: "​​" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(firstMyProfileEditInputCode(parsed.error)).toBe("DISPLAY_NAME_INVALID");
  });

  it("signup step 2 still refuses one, per half", () => {
    // The door that already had the rule. Here so a refactor of the shared
    // helper cannot quietly drop the case it was written for.
    expect(
      completeIdentityInputSchema.safeParse({ firstName: "​", lastName: "Pérez" }).success,
    ).toBe(false);
    expect(completeIdentityInputSchema.safeParse({ firstName: "Ana", lastName: "‮" }).success).toBe(
      false,
    );
  });

  // L2-1: the SAME string against every door, because the finding was that one
  // spelling passed all five of them at once. `filler(0x3164, 2)` trims to
  // length 2, so no MIN_LENGTH stops it — only the shape rule can.
  it("every door refuses a name of Hangul fillers", () => {
    const blank = filler(0x3164, 2);

    const pet = registerPetInputSchema.safeParse({ ...PET, name: blank });
    expect(pet.success).toBe(false);
    if (!pet.success) expect(firstRegisterPetInputCode(pet.error)).toBe("NAME_INVALID");

    const rename = petProfileCommandInputSchema.safeParse({
      command: "edit_identity",
      name: blank,
      breed: null,
      color: null,
    });
    expect(rename.success).toBe(false);
    if (!rename.success) expect(firstPetProfileCommandInputCode(rename.error)).toBe("NAME_INVALID");

    const displayName = myProfileEditInputSchema.safeParse({ displayName: blank });
    expect(displayName.success).toBe(false);
    if (!displayName.success) {
      expect(firstMyProfileEditInputCode(displayName.error)).toBe("DISPLAY_NAME_INVALID");
    }

    expect(
      completeIdentityInputSchema.safeParse({ firstName: blank, lastName: "Pérez" }).success,
    ).toBe(false);
    expect(
      completeIdentityInputSchema.safeParse({ firstName: "Ana", lastName: blank }).success,
    ).toBe(false);
  });

  // NON-VACUITY: all four doors still take a real name.
  it("every door still accepts a real name", () => {
    expect(registerPetInputSchema.safeParse({ ...PET, name: "Ñandú" }).success).toBe(true);
    expect(
      petProfileCommandInputSchema.safeParse({
        command: "edit_identity",
        name: "Ñandú",
        breed: null,
        color: null,
      }).success,
    ).toBe(true);
    expect(myProfileEditInputSchema.safeParse({ displayName: "María José" }).success).toBe(true);
    expect(
      completeIdentityInputSchema.safeParse({ firstName: "María José", lastName: "O'Connor" })
        .success,
    ).toBe(true);
  });
});
