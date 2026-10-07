// The client-input contract for signup and login (native-readiness WU-A).
//
// These assertions are the contract's half of the boundary: what a client may
// send, what it may omit, and — the part that matters most here — what this
// schema deliberately does NOT reject, because the web path does not reject it
// either. Two transports that refuse different sets of inputs are two products.
//
// The app's half (rate limits, GoTrue, the landing decision, the enumeration
// masquerade) is tested where it lives, against the use-cases.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LEGAL_ACCEPTANCE_INPUT_CODES,
  LOGIN_INPUT_CODES,
  MIN_PASSWORD_LENGTH,
  SIGNUP_INPUT_CODES,
  firstInputCode,
  isLegacySignupClient,
  legalAcceptanceInputSchema,
  loginInputSchema,
  signupInputSchema,
} from "../auth.ts";

const VALID_SIGNUP = {
  email: "ana@example.com",
  password: "supersecreta",
  confirmPassword: "supersecreta",
  tosAccepted: true,
  transferAccepted: true,
  adultDeclared: true,
};

describe("loginInputSchema", () => {
  it("accepts the minimum a client can send", () => {
    const result = loginInputSchema.safeParse({ email: "ana@example.com", password: "x" });
    expect(result.success).toBe(true);
    // returnTo is optional and normalizes to null, so a caller never has to
    // distinguish "absent" from "empty string".
    if (result.success) expect(result.data.returnTo).toBeNull();
  });

  it("trims the email but NEVER the password", () => {
    const result = loginInputSchema.safeParse({
      email: "  ana@example.com  ",
      password: "  con espacios  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("ana@example.com");
      // A leading/trailing space is part of the secret. Trimming it here would
      // reject a password the user can type and GoTrue would accept.
      expect(result.data.password).toBe("  con espacios  ");
    }
  });

  it("rejects a blank email with EMAIL_REQUIRED", () => {
    const result = loginInputSchema.safeParse({ email: "   ", password: "x" });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(LOGIN_INPUT_CODES, result.error)).toBe("EMAIL_REQUIRED");
  });

  it("rejects a blank password with PASSWORD_REQUIRED", () => {
    const result = loginInputSchema.safeParse({ email: "ana@example.com", password: "" });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(LOGIN_INPUT_CODES, result.error)).toBe("PASSWORD_REQUIRED");
  });

  it("does NOT validate the email's FORMAT — the web path does not either", () => {
    // This is the divergence guard. If someone adds `z.email()` here, the same
    // string starts producing a 400 over /api/v1 and "Correo o contraseña
    // incorrectos." over the form. The two transports share a use-case
    // precisely so they cannot disagree about which inputs exist.
    const result = loginInputSchema.safeParse({ email: "no-es-un-mail", password: "x" });
    expect(result.success).toBe(true);
  });

  it("does NOT enforce a password length on LOGIN", () => {
    // The minimum applies to what a client may CREATE, not to what it may
    // present. An account minted before the rule existed must still be able to
    // log in, and rejecting a short password here would tell an attacker that
    // no account can have one.
    const result = loginInputSchema.safeParse({ email: "ana@example.com", password: "a" });
    expect(result.success).toBe(true);
  });
});

describe("signupInputSchema", () => {
  it("accepts a well-formed signup", () => {
    expect(signupInputSchema.safeParse(VALID_SIGNUP).success).toBe(true);
  });

  it("rejects a password under the minimum with PASSWORD_TOO_SHORT", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const result = signupInputSchema.safeParse({
      ...VALID_SIGNUP,
      password: short,
      confirmPassword: short,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(SIGNUP_INPUT_CODES, result.error)).toBe("PASSWORD_TOO_SHORT");
  });

  it("reports PASSWORD_TOO_SHORT BEFORE PASSWORD_MISMATCH when both could apply", () => {
    // Someone who typed a short password twice should be told the length, not
    // that the two boxes disagree — they do not. The declared code order, not
    // zod's issue order, decides which message a form shows.
    const result = signupInputSchema.safeParse({
      ...VALID_SIGNUP,
      password: "corta",
      confirmPassword: "otra",
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(SIGNUP_INPUT_CODES, result.error)).toBe("PASSWORD_TOO_SHORT");
  });

  it("rejects mismatched passwords with PASSWORD_MISMATCH", () => {
    const result = signupInputSchema.safeParse({
      ...VALID_SIGNUP,
      confirmPassword: "otracosaentera",
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(SIGNUP_INPUT_CODES, result.error)).toBe("PASSWORD_MISMATCH");
  });

  it("rejects an unaccepted TOS with TOS_NOT_ACCEPTED", () => {
    const result = signupInputSchema.safeParse({ ...VALID_SIGNUP, tosAccepted: false });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(SIGNUP_INPUT_CODES, result.error)).toBe("TOS_NOT_ACCEPTED");
  });

  it("rejects an OMITTED tosAccepted — a legal acceptance is never defaulted", () => {
    const { tosAccepted: _omitted, ...withoutTos } = VALID_SIGNUP;
    expect(signupInputSchema.safeParse(withoutTos).success).toBe(false);
  });

  // THE TWO BOXES ADDED ON 2026-10-07 (legal review 2026-10-02, P10 and P9;
  // PO decision D2 = b). Each is its own required TRUE, not implied by the
  // Terms box, and an OMITTED one is refused — which is how a bundle built
  // before these boxes existed is kept from creating an account without them.
  it.each([
    ["transferAccepted", "TRANSFER_NOT_ACCEPTED"],
    ["adultDeclared", "ADULT_NOT_DECLARED"],
  ] as const)("rejects %s=false with %s, even with the Terms accepted", (field, code) => {
    const result = signupInputSchema.safeParse({ ...VALID_SIGNUP, [field]: false });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstInputCode(SIGNUP_INPUT_CODES, result.error)).toBe(code);
  });

  it.each(["transferAccepted", "adultDeclared"] as const)(
    "rejects an OMITTED %s when the other box is sent — only the whole legacy shape passes",
    (field) => {
      const { [field]: _omitted, ...without } = VALID_SIGNUP;
      expect(signupInputSchema.safeParse(without).success).toBe(false);
    },
  );

  // THE v13 CLIENT (PO 2026-10-07: do not break its signups). It sends neither
  // box and the version it displayed, 2026-09-24. Accepted, and recorded under
  // that older version, so the re-acceptance circuit catches the account.
  it("ACCEPTS the v13 one-box payload, and names it legacy", () => {
    const { transferAccepted: _t, adultDeclared: _a, ...oneBox } = VALID_SIGNUP;
    const v13 = { ...oneBox, legalVersion: "2026-09-24" };
    expect(signupInputSchema.safeParse(v13).success).toBe(true);
    expect(isLegacySignupClient(v13)).toBe(true);
    // A bundle from before `legalVersion` existed is the same case.
    expect(signupInputSchema.safeParse(oneBox).success).toBe(true);
  });

  it("REFUSES a client that displayed the current version without the boxes (v14)", () => {
    const { transferAccepted: _t, adultDeclared: _a, ...oneBox } = VALID_SIGNUP;
    const v14 = { ...oneBox, legalVersion: "2026-10-07" };
    expect(isLegacySignupClient(v14)).toBe(false);
    const result = signupInputSchema.safeParse(v14);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(SIGNUP_INPUT_CODES, result.error)).toBe("TRANSFER_NOT_ACCEPTED");
  });

  it('rejects the string "on" — the form encoding is the ACTION edge\'s to translate', () => {
    // The web checkbox sends "on". If this schema coerced it, the contract
    // would be describing an HTML form encoding to a native client that has no
    // forms. The action edge converts before parsing.
    expect(signupInputSchema.safeParse({ ...VALID_SIGNUP, tosAccepted: "on" }).success).toBe(false);
  });
});

describe("legalAcceptanceInputSchema (re-acceptance by an existing account)", () => {
  const VALID = {
    tosAccepted: true,
    transferAccepted: true,
    adultDeclared: true,
    legalVersion: "2026-10-07",
  };

  it("accepts the three boxes and the displayed version", () => {
    expect(legalAcceptanceInputSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ["tosAccepted", "TOS_NOT_ACCEPTED"],
    ["transferAccepted", "TRANSFER_NOT_ACCEPTED"],
    ["adultDeclared", "ADULT_NOT_DECLARED"],
  ] as const)("refuses %s=false with %s", (field, code) => {
    const result = legalAcceptanceInputSchema.safeParse({ ...VALID, [field]: false });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(firstInputCode(LEGAL_ACCEPTANCE_INPUT_CODES, result.error)).toBe(code);
  });

  it("requires the version: a client must say which text it displayed", () => {
    const { legalVersion: _omitted, ...without } = VALID;
    expect(legalAcceptanceInputSchema.safeParse(without).success).toBe(false);
  });
});

describe("firstInputCode", () => {
  it("returns null when the error carries no code this contract defines", () => {
    // The consumer's cue to show a generic message instead of leaking a raw zod
    // string ("Too small: expected string to have >=3 characters") into UI copy.
    const foreign = z.string().min(3).safeParse("ab");
    expect(foreign.success).toBe(false);
    if (!foreign.success) {
      expect(firstInputCode(SIGNUP_INPUT_CODES, foreign.error)).toBeNull();
    }
  });

  it("picks by DECLARED order, not by the order zod collected the issues", () => {
    // Both codes are present in this error; the contract says the login form
    // reports the email first. A consumer must not have to reason about zod's
    // internal traversal to know which message its screen will show.
    const result = loginInputSchema.safeParse({ email: "", password: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("EMAIL_REQUIRED");
      expect(messages).toContain("PASSWORD_REQUIRED");
      expect(firstInputCode(LOGIN_INPUT_CODES, result.error)).toBe("EMAIL_REQUIRED");
    }
  });
});
