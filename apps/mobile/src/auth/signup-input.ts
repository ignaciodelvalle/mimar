// The crear-cuenta form's draft → what the server accepts, judged by the
// SERVER'S schema.
//
// WHY `signupInputSchema` AND NOT A HAND-ROLLED CHECK
// ---------------------------------------------------------------------------
// The same reason `pets/register-input.ts` gives, one door earlier: the
// alternative is two definitions of "valid" drifting apart, which is the exact
// failure `packages/contract` exists to prevent. `POST /api/v1/auth/signup`
// parses the body with `signupInputSchema`; this module parses the draft with
// the SAME schema, the same zod, and therefore reaches the same verdict —
// including the parts nobody would reimplement the same way by accident:
//
//   · the email is TRIMMED and the password is NOT. A password's leading space
//     is part of the secret; an email's trailing space is a typo. Getting that
//     backwards produces a credential the person can type and the server
//     rejects, with no message that explains it.
//   · the email is NOT format-checked, deliberately, because the WEB path does
//     not check it either — `signupAction` accepts any non-empty string and
//     lets GoTrue answer. A native form that refused `ana@@example` at the door
//     would refuse an input the browser form accepts.
//   · `tosAccepted` is a REQUIRED boolean with no default. A legal acceptance a
//     client can omit into existence is not an acceptance.
//
// THE ORDER OF THE REFUSALS IS THE CONTRACT'S, NOT ZOD'S. `SIGNUP_INPUT_CODES`
// declares report order and says why: a form shows ONE message, and which one
// it shows must not depend on the order zod happened to collect issues in.
// `PASSWORD_TOO_SHORT` precedes `PASSWORD_MISMATCH` because somebody who typed
// the same short password twice should be told the length — the two boxes agree.
//
// NO DATE FIELD EXISTS ON THIS FORM, so `ar-calendar-day.ts` has nothing to
// guard here. Said out loud rather than left as an absence: every other write
// this app makes carries a day and goes through that helper, and a reader
// checking for the anti-rollover treatment should find the answer rather than
// the silence. Signup collects an email, a password twice and one checkbox.

import {
  MIN_PASSWORD_LENGTH,
  SIGNUP_INPUT_CODES,
  type SignupInput,
  type SignupInputCode,
  firstInputCode,
  signupInputSchema,
} from "@dim/contract/input";

/** What the form holds: strings and one boolean, because that is what it has. */
export type SignupDraft = {
  email: string;
  password: string;
  confirmPassword: string;
  tosAccepted: boolean;
};

export const EMPTY_SIGNUP_DRAFT: SignupDraft = {
  email: "",
  password: "",
  confirmPassword: "",
  tosAccepted: false,
};

export type SignupDraftVerdict =
  | { ok: true; input: SignupInput }
  | { ok: false; code: SignupInputCode; message: string };

/**
 * es-AR copy for each refusal the schema can produce. Exhaustive.
 *
 * No `default` and no trailing return: a code added to `SIGNUP_INPUT_CODES`
 * without copy here is a COMPILE error, not a silently blank field hint. Same
 * discipline as `apiErrorMessage` and `draftErrorMessage`, and for the same
 * reason — this repo has been bitten by a widened vocabulary arriving through a
 * branch merge that touched no common file.
 *
 * The two password sentences are the use-case's own words verbatim
 * (`src/modules/auth/application/signup.ts`), so a person who somehow reaches
 * the server's copy of the same rule reads the same sentence twice rather than
 * two different accounts of one refusal.
 */
export function signupErrorMessage(code: SignupInputCode): string {
  switch (code) {
    case "EMAIL_REQUIRED":
      return "Escribí tu correo electrónico.";
    case "PASSWORD_REQUIRED":
      return "Escribí una contraseña.";
    case "PASSWORD_TOO_SHORT":
      return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    case "PASSWORD_MISMATCH":
      return "Las contraseñas no coinciden.";
    case "TOS_NOT_ACCEPTED":
      return "Tenés que aceptar los Términos y la Política de privacidad.";
  }
}

/** The draft, judged. */
export function toSignupInput(draft: SignupDraft): SignupDraftVerdict {
  const parsed = signupInputSchema.safeParse({
    email: draft.email,
    password: draft.password,
    confirmPassword: draft.confirmPassword,
    tosAccepted: draft.tosAccepted,
  });

  if (parsed.success) return { ok: true, input: parsed.data };

  const code = firstInputCode(SIGNUP_INPUT_CODES, parsed.error);
  if (code === null) {
    // The schema refused for something outside the declared code list. That is
    // a CONTRACT violation, not a user error, and it must not be shown as a
    // field hint — it would blame the person for the app's bug.
    return {
      ok: false,
      code: "EMAIL_REQUIRED",
      message: "La app no pudo armar el registro. Actualizá la app.",
    };
  }
  return { ok: false, code, message: signupErrorMessage(code) };
}

/**
 * Whether the submit button may be enabled. A CONVENIENCE, NOT AUTHORITY —
 * the verdict that decides whether a request is sent is always
 * `toSignupInput`.
 *
 * It checks presence and the checkbox and nothing else, on purpose. Disabling
 * the button for a password that is too short would hide the SENTENCE that says
 * why, and a person staring at a dead button with no explanation is the failure
 * mode this deliberately avoids: let them press it, then tell them.
 */
export function canSubmitSignup(draft: SignupDraft): boolean {
  return (
    draft.email.trim().length > 0 &&
    draft.password.length > 0 &&
    draft.confirmPassword.length > 0 &&
    draft.tosAccepted
  );
}
