// `signup-input` — the crear-cuenta draft judged by the CONTRACT'S schema.
//
// WHAT THESE HAVE TO PROVE, beyond "zod works"
// ---------------------------------------------------------------------------
//   1. THE REPORT ORDER IS THE CONTRACT'S, not zod's. A form shows ONE message
//      and which one it shows must not depend on collection order — the case
//      that matters is a short password typed twice: the person should be told
//      the LENGTH, because the two boxes agree.
//   2. THE EMAIL IS TRIMMED AND THE PASSWORD IS NOT. Getting that backwards
//      produces a credential somebody can type and the server rejects.
//   3. THE EMAIL IS NOT FORMAT-CHECKED, deliberately, because the WEB path does
//      not check it either. A native form stricter than the browser form is two
//      doors refusing different inputs — the drift the contract exists to stop.
//   4. `tosAccepted` IS REQUIRED TRUE and never defaulted. A legal acceptance a
//      client can omit into existence is not an acceptance.
//   5. THE COPY SWITCH IS TOTAL over the contract's declared code list — proved
//      by iterating the list itself, so a widened vocabulary fails here rather
//      than rendering a blank hint.

import { describe, expect, it } from "@jest/globals";

import { MIN_PASSWORD_LENGTH, SIGNUP_INPUT_CODES } from "@dim/contract/input";

import {
  EMPTY_SIGNUP_DRAFT,
  type SignupDraft,
  canSubmitSignup,
  signupErrorMessage,
  toSignupInput,
} from "./signup-input";

const GOOD: SignupDraft = {
  email: "ana@example.com",
  password: "unaClaveLarga",
  confirmPassword: "unaClaveLarga",
  tosAccepted: true,
};

function draft(overrides: Partial<SignupDraft>): SignupDraft {
  return { ...GOOD, ...overrides };
}

describe("the happy path", () => {
  it("accepts a complete draft and hands back what the endpoint takes", () => {
    const verdict = toSignupInput(GOOD);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.input).toEqual({
      email: "ana@example.com",
      password: "unaClaveLarga",
      confirmPassword: "unaClaveLarga",
      tosAccepted: true,
    });
  });

  it("trims the email and leaves the password byte for byte", () => {
    const verdict = toSignupInput(
      draft({
        email: "  Ana@Example.com  ",
        password: " clave con espacios ",
        confirmPassword: " clave con espacios ",
      }),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // TRIMMED — a trailing space in an address is a typo, not a different
    // address. NOT lowercased: the contract does not, and neither may this.
    expect(verdict.input.email).toBe("Ana@Example.com");
    // NOT TRIMMED — the spaces are part of the secret. GoTrue would accept this
    // password; a client that trimmed it would lock the person out of an
    // account they can type the password for.
    expect(verdict.input.password).toBe(" clave con espacios ");
  });

  it("does NOT validate the email's shape, exactly as the web form does not", () => {
    // `signupAction` accepts any non-empty string and lets GoTrue answer. If
    // this refused `ana@@example`, the same input would be a 400 over /api/v1
    // and a server-side refusal over the form.
    expect(toSignupInput(draft({ email: "ana@@example" })).ok).toBe(true);
    expect(toSignupInput(draft({ email: "no-arroba" })).ok).toBe(true);
  });
});

describe("the refusals, in the contract's declared order", () => {
  it("asks for the email first", () => {
    const verdict = toSignupInput(draft({ email: "   " }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("EMAIL_REQUIRED");
  });

  it("reports the LENGTH, not the mismatch, for a short password typed twice", () => {
    // The two boxes agree. Telling somebody "las contraseñas no coinciden" here
    // would be a sentence about a problem they do not have, and this is exactly
    // the case SIGNUP_INPUT_CODES orders itself around.
    const verdict = toSignupInput(draft({ password: "corta", confirmPassword: "corta" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("PASSWORD_TOO_SHORT");
    expect(verdict.message).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("reports the mismatch when both are long enough and differ", () => {
    const verdict = toSignupInput(draft({ confirmPassword: "otraClaveLarga" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("PASSWORD_MISMATCH");
  });

  it("refuses an unaccepted TOS, and the default draft has it unaccepted", () => {
    const verdict = toSignupInput(draft({ tosAccepted: false }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("TOS_NOT_ACCEPTED");
    // The empty draft must never start pre-accepted: a checkbox that arrives
    // ticked is a legal acceptance nobody performed.
    expect(EMPTY_SIGNUP_DRAFT.tosAccepted).toBe(false);
  });
});

describe("the copy", () => {
  it("has a non-empty sentence for every code the contract declares", () => {
    // Iterating the CONTRACT'S list rather than a local one is what makes this
    // fail when the vocabulary widens. A blank hint under a field is the same
    // class of dishonesty as a blank error notice.
    for (const code of SIGNUP_INPUT_CODES) {
      expect(signupErrorMessage(code).trim().length).toBeGreaterThan(0);
    }
    expect(new Set(SIGNUP_INPUT_CODES.map(signupErrorMessage)).size).toBe(
      SIGNUP_INPUT_CODES.length,
    );
  });
});

describe("canSubmitSignup — a convenience, not the authority", () => {
  it("requires presence and the checkbox, and nothing else", () => {
    expect(canSubmitSignup(EMPTY_SIGNUP_DRAFT)).toBe(false);
    expect(canSubmitSignup(draft({ tosAccepted: false }))).toBe(false);
    expect(canSubmitSignup(draft({ confirmPassword: "" }))).toBe(false);
    expect(canSubmitSignup(draft({ email: "   " }))).toBe(false);
    expect(canSubmitSignup(GOOD)).toBe(true);
  });

  it("stays TRUE for a draft the schema will refuse — on purpose", () => {
    // A dead button with no sentence beside it is a person who cannot tell
    // whether the app is broken or they are. The button is live; the refusal
    // arrives as words.
    const short = draft({ password: "corta", confirmPassword: "corta" });
    expect(canSubmitSignup(short)).toBe(true);
    expect(toSignupInput(short).ok).toBe(false);

    const mismatched = draft({ confirmPassword: "otraClaveLarga" });
    expect(canSubmitSignup(mismatched)).toBe(true);
    expect(toSignupInput(mismatched).ok).toBe(false);
  });
});
