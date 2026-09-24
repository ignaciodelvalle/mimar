// `petClaimCommandInputSchema` — what a client may send to
// `POST /me/pet-claims`.
//
// THE CASE A REVIEWER SHOULD READ FIRST is `refuses `dispute``. It is the scope
// of this whole slice expressed as an assertion, and unlike the appointments
// schema's `book` it is a REFUSAL rather than a scope line: raising a custody
// dispute requires at least one evidence file, server-side and absolutely, and
// this transport carries JSON. A `dispute` member would be a command the server
// must refuse on every single call.
//
// THE SECOND is `never carries a pet token`. Both writers resolve the animal FROM
// the private identifier and consult no caller-supplied token anywhere; a token
// that never reaches the wire cannot be trusted by accident later.

import { describe, expect, it } from "vitest";

import {
  PET_CLAIM_COMMAND_INPUT_CODES,
  firstPetClaimCommandInputCode,
  petClaimCommandInputSchema,
} from "../pet-claim.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = petClaimCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstPetClaimCommandInputCode(parsed.error);
}

const CHIP = "982000123456789";
const TATTOO = "ABC-1234";

describe("petClaimCommandInputSchema — the command discriminator", () => {
  it("accepts the two commands a phone can honestly run", () => {
    expect(codeFor({ command: "lookup", identifierKind: "microchip", identifierValue: CHIP })).toBe(
      null,
    );
    expect(
      codeFor({ command: "claim_free", identifierKind: "microchip", identifierValue: CHIP }),
    ).toBe(null);
  });

  it("refuses `dispute`, and that one is a RULE rather than scope", () => {
    // `submitClaimDisputeForUser` refuses when no file with `size > 0` survives
    // the filter (PO decision 2026-07-30), because a dispute notifies the
    // registered owner, appends an uneditable row to the animal's spine, flips
    // `pets.in_custody_dispute` and opens a case for an authority. A JSON body
    // cannot carry a file, so this member would be a command that is always
    // refused — and a client would draw the control anyway.
    expect(
      codeFor({
        command: "dispute",
        identifierKind: "microchip",
        identifierValue: CHIP,
        reason: "x".repeat(40),
      }),
    ).toBe("COMMAND_REQUIRED");
  });

  it("names a missing command rather than falling through to null", () => {
    expect(codeFor({})).toBe("COMMAND_REQUIRED");
    expect(codeFor({ identifierKind: "microchip", identifierValue: CHIP })).toBe(
      "COMMAND_REQUIRED",
    );
    expect(codeFor(null)).toBe("COMMAND_REQUIRED");
  });
});

describe("petClaimCommandInputSchema — the identifier is the authorization", () => {
  it("never carries a pet token — an extra one is dropped, not honoured", () => {
    // The wire shape has no token field at all. This asserts the DATA the server
    // receives after parsing, not merely that the schema tolerates the key: a
    // token that survived parsing is a token a handler could reach for.
    const parsed = petClaimCommandInputSchema.safeParse({
      command: "claim_free",
      identifierKind: "microchip",
      identifierValue: CHIP,
      petToken: "DIM-AAAA-BBBB",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("petToken" in parsed.data).toBe(false);
  });

  it("refuses an absent, empty or whitespace-only value", () => {
    expect(codeFor({ command: "lookup", identifierKind: "tattoo" })).toBe("IDENTIFIER_REQUIRED");
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: "" })).toBe(
      "IDENTIFIER_REQUIRED",
    );
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: "   " })).toBe(
      "IDENTIFIER_REQUIRED",
    );
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: 42 })).toBe(
      "IDENTIFIER_REQUIRED",
    );
  });

  it("refuses a kind outside the web's own two", () => {
    expect(codeFor({ command: "lookup", identifierKind: "dni", identifierValue: "20123456" })).toBe(
      "IDENTIFIER_KIND_REQUIRED",
    );
    expect(codeFor({ command: "lookup", identifierValue: CHIP })).toBe("IDENTIFIER_KIND_REQUIRED");
  });

  it("trims, so a chip pasted with a trailing newline still matches fifteen digits", () => {
    const parsed = petClaimCommandInputSchema.safeParse({
      command: "lookup",
      identifierKind: "microchip",
      identifierValue: `  ${CHIP}\n`,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.identifierValue).toBe(CHIP);
  });
});

describe("petClaimCommandInputSchema — the fifteen digits", () => {
  it("refuses a microchip that is not exactly fifteen digits, on BOTH commands", () => {
    // The rule is cross-field (kind + value) and both writers enforce it, so a
    // client that skipped it would spend a rate-limit token on a value that
    // cannot resolve to any animal.
    for (const command of ["lookup", "claim_free"]) {
      expect(
        codeFor({ command, identifierKind: "microchip", identifierValue: "12345678901234" }),
      ).toBe("MICROCHIP_MUST_BE_15_DIGITS");
      expect(
        codeFor({ command, identifierKind: "microchip", identifierValue: "1234567890123456" }),
      ).toBe("MICROCHIP_MUST_BE_15_DIGITS");
      expect(
        codeFor({ command, identifierKind: "microchip", identifierValue: "98200012345678A" }),
      ).toBe("MICROCHIP_MUST_BE_15_DIGITS");
    }
  });

  it("does NOT apply the digit rule to a tattoo code", () => {
    // `pet_identifications.code` is unbounded text for a tattoo and neither
    // writer caps or shapes it. A rule invented here would refuse a code the
    // registry already holds.
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: TATTOO })).toBe(
      null,
    );
    expect(
      codeFor({
        command: "claim_free",
        identifierKind: "tattoo",
        identifierValue: "x".repeat(120),
      }),
    ).toBe(null);
  });
});

describe("firstPetClaimCommandInputCode", () => {
  it("only ever returns a code the vocabulary declares", () => {
    // The app's copy switch is exhaustive over this array with no `default`, so a
    // code outside it renders as a blank line under a "no se pudo" heading.
    for (const body of [
      {},
      { command: "lookup" },
      { command: "dispute" },
      { command: "lookup", identifierKind: "microchip", identifierValue: "1" },
      { command: "claim_free", identifierKind: "nope", identifierValue: CHIP },
    ]) {
      const code = codeFor(body);
      expect(code === null || PET_CLAIM_COMMAND_INPUT_CODES.includes(code as never)).toBe(true);
    }
  });
});
