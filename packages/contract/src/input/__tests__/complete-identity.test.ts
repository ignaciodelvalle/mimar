// `completeIdentityInputSchema` — what a name may and may not be.
//
// WHY THIS FILE EXISTS AT THE CONTRACT LEVEL
// ---------------------------------------------------------------------------
// Three doors parse with this schema — the web's step 2, `POST
// /api/v1/me/identity`, and the native screen running it locally before it
// spends a request — and the whole point of putting the rules here is that none
// of them can hold a different opinion. So the rules are pinned HERE, once,
// rather than three times against three call sites.
//
// The security review of 2026-09-05 is what added the second half of this file:
// length was the only shape rule, and `U+200B` (ZERO WIDTH SPACE) is one
// character long, survives `String.prototype.trim()`, and joins into a
// `display_name` that makes `isIdentityPending` false while rendering as
// NOTHING — a titular with a blank name on their own credential, on the public
// page, and in `/gob/historial`, with every gate reporting the identity as
// complete.
//
// THE ACCEPTED LIST IS AS LOAD-BEARING AS THE REFUSED ONE. This is a national
// identity registry: a rule that refuses `O'Connor` or `Ñandú-López` refuses a
// real person, and that is a worse failure than the one being defended against.

import { describe, expect, it } from "vitest";

import {
  IDENTITY_NAME_MAX_LENGTH,
  completeIdentityInputSchema,
  firstCompleteIdentityInputCode,
  firstCompleteIdentityIssue,
  identityDisplayName,
} from "../index.ts";

// BUILT FROM CODE POINTS, NEVER TYPED — an invisible character pasted into this
// file would be invisible in the diff that reviews it, which is the defect under
// test reproduced in the test's own source.
const ZERO_WIDTH = String.fromCharCode(0x200b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const LTR_MARK = String.fromCharCode(0x200e);
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0x00);
const NEWLINE = String.fromCharCode(0x0a);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);

function parse(firstName: string, lastName = "Pérez") {
  return completeIdentityInputSchema.safeParse({ firstName, lastName });
}

function codeFor(firstName: string, lastName = "Pérez"): string | null {
  const result = parse(firstName, lastName);
  return result.success ? null : firstCompleteIdentityInputCode(result.error);
}

describe("names a real person can have — all of these MUST parse", () => {
  it.each([
    ["a plain given name", "Ana"],
    ["two given names", "María José"],
    ["an apostrophe", "O'Connor"],
    ["a hyphen and two tildes", "Ñandú-López"],
    ["an accent and a diaeresis", "Güemes"],
    ["a particle", "de la Fuente"],
    ["a full stop in an abbreviation", "J. Ignacio"],
    ["a name with a digit in it", "Ana 2"],
    ["a single letter", "A"],
    ["a name at exactly the bound", "A".repeat(IDENTITY_NAME_MAX_LENGTH)],
    ["a non-Latin script", "Ана"],
  ])("accepts %s", (_label, firstName) => {
    const result = parse(firstName);
    expect(result.success).toBe(true);
  });

  it("strips a leading or trailing byte-order mark rather than refusing it", () => {
    // U+FEFF is in ECMAScript's own `WhiteSpace`, so `trim()` removes it at
    // either end. A name pasted out of a UTF-8 file with a BOM in front of it is
    // a NAME with a stray byte, not a hostile input — cleaning it up is the right
    // answer, and the shape rule below still refuses one pasted into the middle.
    const result = completeIdentityInputSchema.safeParse({
      firstName: `${BOM}Ana`,
      lastName: `Pérez${BOM}`,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ firstName: "Ana", lastName: "Pérez" });
  });

  it("trims the halves it stores rather than refusing the spaces", () => {
    const result = completeIdentityInputSchema.safeParse({
      firstName: "  Ana  ",
      lastName: "\tPérez\n",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // The whitespace is TRIMMED, not refused — and it is trimmed before the
      // shape rules run, which is why a tab and a newline around a valid name do
      // not trip the control-character ban below.
      expect(result.data).toEqual({ firstName: "Ana", lastName: "Pérez" });
    }
  });
});

describe("what a name may not be", () => {
  it.each([
    ["a zero-width space alone", ZERO_WIDTH],
    ["a zero-width space inside a name", `An${ZERO_WIDTH}a`],
    ["a right-to-left override", `An${RTL_OVERRIDE}a`],
    ["a left-to-right mark", `Ana${LTR_MARK}`],
    // INTERIOR, not leading: ECMAScript's `WhiteSpace` includes `<ZWNBSP>`
    // (U+FEFF), so `String.prototype.trim()` strips a BOM at either END — that
    // one is cleaned up rather than refused, and the case below pins it. Only a
    // BOM somebody pasted INTO a name survives to reach this rule.
    ["a byte-order mark inside a name", `An${BOM}a`],
    ["an embedded newline", `Ana${NEWLINE}Pérez`],
    ["a carriage return", `Ana${CARRIAGE_RETURN}Pérez`],
    ["a NUL", `Ana${NUL}`],
    ["digits only", "12345"],
    ["punctuation only", "---"],
    ["a lone hyphen", "-"],
  ])("refuses %s with NAME_INVALID", (_label, firstName) => {
    expect(codeFor(firstName)).toBe("NAME_INVALID");
  });

  it("refuses an empty half before it complains about its shape", () => {
    // Order matters for a form that shows ONE message: "escribí tu nombre" is
    // the useful sentence for an empty box, not "necesita al menos una letra".
    expect(codeFor("")).toBe("FIRST_NAME_REQUIRED");
    expect(codeFor("   ")).toBe("FIRST_NAME_REQUIRED");
  });

  it("refuses a half past the shared display-name bound", () => {
    expect(codeFor("A".repeat(IDENTITY_NAME_MAX_LENGTH + 1))).toBe("NAME_TOO_LONG");
  });

  it("refuses the surname on its own terms", () => {
    expect(codeFor("Ana", "")).toBe("LAST_NAME_REQUIRED");
    expect(codeFor("Ana", ZERO_WIDTH)).toBe("NAME_INVALID");
  });
});

describe("firstCompleteIdentityIssue — which box gets the red border", () => {
  it("names the surname when the surname is what failed", () => {
    const result = parse("Ana", ZERO_WIDTH);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(firstCompleteIdentityIssue(result.error)).toEqual({
        code: "NAME_INVALID",
        field: "lastName",
      });
    }
  });

  it("names the given name when both failed — the first box, not the second", () => {
    const result = parse("", "");
    expect(result.success).toBe(false);
    if (!result.success) {
      // A form reporting its SECOND error while the first is still on screen
      // reads as random. Zod visits the object's keys in declaration order, and
      // `firstName` is declared first for exactly this reason.
      expect(firstCompleteIdentityIssue(result.error)?.field).toBe("firstName");
    }
  });

  it("falls back to the first box for a body that is not an object at all", () => {
    const result = completeIdentityInputSchema.safeParse("Ana Pérez");
    expect(result.success).toBe(false);
    if (!result.success) {
      // No declared code and no usable path: a malformed body is a client bug,
      // and the resolver must still answer rather than throw at a call site.
      expect(firstCompleteIdentityIssue(result.error)).toBeNull();
    }
  });
});

describe("the bound is DERIVED, and the join is the one both doors use", () => {
  it("keeps two full halves plus their space inside the display-name bound", () => {
    const longest = identityDisplayName(
      "A".repeat(IDENTITY_NAME_MAX_LENGTH),
      "B".repeat(IDENTITY_NAME_MAX_LENGTH),
    );
    // 80 is `DISPLAY_NAME_MAX_LENGTH`, the bound the OTHER writer onto this
    // column enforces (`myProfileEditInputSchema`). A name this schema accepts
    // must never be one that door would refuse.
    expect(longest.length).toBeLessThanOrEqual(80);
  });

  it("joins with exactly one space and trims the halves", () => {
    expect(identityDisplayName("  Ana ", " Pérez  ")).toBe("Ana Pérez");
  });
});
