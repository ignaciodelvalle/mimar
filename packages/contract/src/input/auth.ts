// Client-input contract for the two pre-authentication surfaces: signup and
// login (native-readiness WU-A).
//
// WHAT THIS IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// Same boundary `intake.ts` drew, one door earlier. Until now the accepted
// shape of a login existed only as four `String(formData.get(...))` statements
// inside a use-case, so a native client had nothing to read and no way to fail
// fast before spending a request. This file is that shape: what fields exist,
// which are required, and what a blank one means. It stops exactly where the
// domain starts — it never decides whether an account exists.
//
// WHY THE EMAIL IS NOT FORMAT-VALIDATED HERE, AND THAT IS DELIBERATE
// ---------------------------------------------------------------------------
// zod can check an email's shape, and doing so would have been one word. It is
// left out because the WEB path does not do it: `loginAction` accepts any
// non-empty string and lets GoTrue answer. If this schema rejected
// `ana@@example` at the door, the same input would produce a 400 over
// `/api/v1` and a "Correo o contraseña incorrectos." over the form — two
// transports refusing different sets of inputs, which is the exact class of
// drift the shared use-case exists to prevent. Format is a client-side nicety
// (a native `<TextInput keyboardType="email-address">` already nudges it); it
// is not a boundary either transport gets to enforce alone.
//
// WHY MACHINE CODES INSTEAD OF MESSAGES — same reason as intake.ts: the
// contract carries data and rules, the consumer owns its words. Web maps these
// to the exact es-AR strings the auth forms have always shown; a native client
// maps them to whatever its screens say.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/**
 * The minimum password length. Enforced identically in the use-case, because a
 * client-side schema is a courtesy and never a boundary — a native build with
 * a stale copy of this package must not be able to mint a 3-character
 * password.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** A required trimmed string, failing with the given code when blank. */
const requiredText = (code: string) => z.string({ error: code }).trim().min(1, { error: code });

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Failure codes, in the order a consumer should report them. The order is part
 * of the contract: a form shows ONE message, and which one it shows must not
 * depend on the order zod happens to collect issues in.
 */
export const LOGIN_INPUT_CODES = ["EMAIL_REQUIRED", "PASSWORD_REQUIRED"] as const;
export type LoginInputCode = (typeof LOGIN_INPUT_CODES)[number];

export const loginInputSchema = z.object({
  email: requiredText("EMAIL_REQUIRED"),
  // NOT trimmed. A password's leading or trailing space is part of the secret;
  // trimming it here would silently reject a password the user can type and
  // GoTrue would accept. The email IS trimmed, because an email with a
  // trailing space is a typo rather than a different address — and because
  // `emailRateLimitKey` normalizes the same way, so the per-email budget and
  // the credential check agree about which account is being hammered.
  password: z.string({ error: "PASSWORD_REQUIRED" }).min(1, { error: "PASSWORD_REQUIRED" }),
  /**
   * Where the WEB should land after a successful login, when it is a safe
   * same-origin path. Meaningless to a native client, which owns its own
   * navigation — it is in the schema because the schema describes the request,
   * and the web form does send it. The server re-checks it against
   * `safeReturnTo` regardless of what a client claims.
   */
  returnTo: z
    // `.nullish()` and not `.optional()` (A5-ciudadanas-11): the transform emits
    // `null` for an absent value, so the schema has to accept one back. See the
    // note on `intake.ts`'s `optionalText` — same class, same fix, and the
    // package-level round-trip test now fences both.
    .string()
    .nullish()
    .transform((v) => (v ? v : null)),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

/**
 * Failure codes, in report order. `PASSWORD_TOO_SHORT` precedes
 * `PASSWORD_MISMATCH` because a user who typed the same short password twice
 * should be told the length, not that the two boxes disagree (they do not).
 */
export const SIGNUP_INPUT_CODES = [
  "EMAIL_REQUIRED",
  "PASSWORD_REQUIRED",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_MISMATCH",
  "TOS_NOT_ACCEPTED",
  "TRANSFER_NOT_ACCEPTED",
  "ADULT_NOT_DECLARED",
] as const;
export type SignupInputCode = (typeof SIGNUP_INPUT_CODES)[number];

/**
 * The two boxes added on 2026-10-07 (legal review 2026-10-02, P10 and P9; PO
 * decision D2 = b, conservative interim). Each is its OWN required boolean,
 * never folded into `tosAccepted`: the international transfer must be consented
 * "en forma expresa y destacada" when it is given beside other declarations
 * (Dec. 1558/2001, art. 5 inc. 1), and a box that also accepts the Terms is not
 * that. Required on the wire too, so a client built before these boxes existed
 * is refused (`invalid_request`, whose copy asks to update the app) instead of
 * creating an account with no transfer consent and no age declaration.
 */
const requiredConsent = (code: string) =>
  z.boolean({ error: code }).refine((v) => v, { error: code });

export const signupInputSchema = z
  .object({
    email: requiredText("EMAIL_REQUIRED"),
    password: z
      .string({ error: "PASSWORD_REQUIRED" })
      .min(1, { error: "PASSWORD_REQUIRED" })
      .min(MIN_PASSWORD_LENGTH, { error: "PASSWORD_TOO_SHORT" }),
    confirmPassword: z.string({ error: "PASSWORD_REQUIRED" }),
    /**
     * Acceptance of the Términos and the Política de privacidad. Required TRUE,
     * never defaulted: a legal acceptance a client can omit into existence is
     * not an acceptance. The web form sends the checkbox's `"on"`; the action
     * edge converts it before it reaches this schema, so the contract only ever
     * describes the boolean.
     */
    tosAccepted: z.boolean(),
    /** The separate international-transfer box (P10). See `requiredConsent`. */
    transferAccepted: requiredConsent("TRANSFER_NOT_ACCEPTED"),
    /** The "Tengo 18 años o más" box (P9, interim). See `requiredConsent`. */
    adultDeclared: requiredConsent("ADULT_NOT_DECLARED"),
    /**
     * The legal version whose consent sentence the client DISPLAYED
     * (`@dim/contract/reference` → `LEGAL_VERSION` at the client's build).
     * Optional on purpose: bundles built before 2026-09-24 do not send it, and
     * the server must still accept them — it records `PREVIOUS_LEGAL_VERSION`
     * for them via `resolveAcceptedLegalVersion`, never its own current one.
     * Not validated against the known list HERE, so a newer client talking to
     * an older server is recorded conservatively instead of refused.
     */
    legalVersion: z.string().max(32).optional(),
  })
  .refine((v) => v.password === v.confirmPassword, { error: "PASSWORD_MISMATCH" })
  .refine((v) => v.tosAccepted, { error: "TOS_NOT_ACCEPTED" });

export type SignupInput = z.infer<typeof signupInputSchema>;

// ---------------------------------------------------------------------------
// Legal re-acceptance (2026-10-07)
// ---------------------------------------------------------------------------

/**
 * Failure codes for the re-acceptance screen, in report order: the same three
 * boxes as signup, in the same order, with the same codes.
 */
export const LEGAL_ACCEPTANCE_INPUT_CODES = [
  "TOS_NOT_ACCEPTED",
  "TRANSFER_NOT_ACCEPTED",
  "ADULT_NOT_DECLARED",
] as const;
export type LegalAcceptanceInputCode = (typeof LEGAL_ACCEPTANCE_INPUT_CODES)[number];

/**
 * What an EXISTING account sends to accept the current legal version — the
 * screen a personal account is sent to when its recorded `tos_version` is not
 * the current one (Disp. 377/2026 inc. b: a substantive change needs a new
 * acceptance, not a notice).
 *
 * `legalVersion` is REQUIRED here, unlike signup. The server records only its
 * own current version and refuses any other: an old bundle showing an old
 * sentence would otherwise either record a text the person never saw, or
 * record its own old version and leave the person on the gate forever.
 */
export const legalAcceptanceInputSchema = z.object({
  tosAccepted: requiredConsent("TOS_NOT_ACCEPTED"),
  transferAccepted: requiredConsent("TRANSFER_NOT_ACCEPTED"),
  adultDeclared: requiredConsent("ADULT_NOT_DECLARED"),
  legalVersion: z.string().max(32),
});

export type LegalAcceptanceInput = z.infer<typeof legalAcceptanceInputSchema>;

// ---------------------------------------------------------------------------
// Password recovery — the REQUEST half
// ---------------------------------------------------------------------------

/**
 * One code, and there will never be a second one that is about the account.
 *
 * `EMAIL_REQUIRED` is about the FIELD — the box is empty. There is deliberately
 * no `ACCOUNT_NOT_FOUND` and no `EMAIL_INVALID`: the first would be the
 * enumeration oracle the whole flow refuses to be, and the second would reject
 * at the door an address the web path accepts and lets GoTrue answer for (see
 * the note on login's email above — two transports refusing different sets of
 * inputs is the drift the shared use-case exists to prevent).
 */
export const PASSWORD_RESET_REQUEST_INPUT_CODES = ["EMAIL_REQUIRED"] as const;
export type PasswordResetRequestInputCode = (typeof PASSWORD_RESET_REQUEST_INPUT_CODES)[number];

/**
 * What a client sends to ask for a recovery credential.
 *
 * ONE FIELD, AND NO `redirectTo`. Where the recovery link points is the SERVER's
 * decision and must stay that way: a client-chosen redirect on a flow that mails
 * a credential is an open-redirect that arrives by e-mail. The native client does
 * not want one either — it redeems the six-digit code, not the link. See
 * `recoveryRedirectTo` in the use-case.
 */
export const passwordResetRequestInputSchema = z.object({
  email: requiredText("EMAIL_REQUIRED"),
});

export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestInputSchema>;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The single code a consumer should report for a failed parse, chosen by the
 * declared order rather than by whichever issue zod listed first. Null when the
 * error carries no code this contract defines — the consumer's cue to show a
 * generic message instead of a raw zod string.
 *
 * Generic over the code list so login and signup share one implementation;
 * `firstIntakeInputCode` is the same function, written before there was a
 * second caller to generalize it for.
 */
export function firstInputCode<T extends string>(codes: readonly T[], error: z.ZodError): T | null {
  const seen = new Set(error.issues.map((issue) => issue.message));
  return codes.find((code) => seen.has(code)) ?? null;
}
