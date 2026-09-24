// Use-case: signup — step 1 of the two-step signup flow (strangler migration
// 26/61; decoupled from the web request in WU-A).
//
// WHAT MOVED, AND WHAT DID NOT
// ---------------------------------------------------------------------------
// `FormData`, `headers()` and the cookie-backed Supabase client left for the
// action edge (`src/modules/auth/actions.ts`) and the `/api/v1` adapter; this
// file takes plain data and one injected port. The validation order, the
// rate-limit bucket and its ceiling, the enumeration masquerade and every
// es-AR string are unchanged — the diff is the boundary, not the behaviour.
//
// Step 1 collects email + password + TOS only. display_name is intentionally
// omitted here — the handle_new_user trigger (db/triggers.sql) falls back to
// split_part(email, '@', 1) when no display_name metadata is supplied, so
// profiles.display_name is never NULL. The real first+last name is collected in
// step 2 (completeIdentityAction), which overwrites the provisional value.
//
// WHY EVERY REFUSAL CARRIES THE EMAIL BACK (a web concern, honoured here)
// ---------------------------------------------------------------------------
// React 19 auto-resets an uncontrolled `<form action={fn}>` once the action
// resolves; a validation error here returns (no redirect), and that reset would
// otherwise wipe the DOM-owned email the user just typed. SignupForm seeds the
// input's `defaultValue` from the echo, mirroring the login fix (bug #46). The
// echo is now the ACTION's to add, from the input it already holds — a use-case
// has no business round-tripping a form field. The enumeration-defense success
// masquerade below intentionally does NOT echo email, and that property is
// preserved by construction: it returns the success arm, which has no field for
// one, and the action reads the echo only off a refusal.
//
// @no-auth-required: signup is by definition pre-authentication.

import type { AuthSessionV1 } from "@dim/contract/api";
import { MIN_PASSWORD_LENGTH } from "@dim/contract/input";

import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";

import { type SignupAuthPort, toAuthSessionV1 } from "./gotrue-port";
import { SIGNUP_IP_LIMIT } from "./signup-limits";

/**
 * Plain-data input. `callerIp` is resolved by the caller from the request
 * (`callerIp(headers)`) and is NOT client-supplied.
 */
export type SignupInput = {
  email: string;
  password: string;
  confirmPassword: string;
  tosAccepted: boolean;
  callerIp: string;
};

export type SignupDeps = {
  /** Built only after validation and the rate-limit budget pass. See LoginDeps. */
  auth: () => Promise<SignupAuthPort>;
};

export type SignupErrorCode =
  | "missing_fields"
  | "password_too_short"
  | "password_mismatch"
  | "tos_not_accepted"
  | "rate_limited"
  | "weak_password"
  | "signup_failed";

export type SignupValue = {
  /**
   * NULL is a normal outcome and has TWO causes a caller cannot tell apart —
   * that indistinguishability is the point. See the masquerade below and
   * `SignupV1` in the contract package.
   */
  session: AuthSessionV1 | null;
};

export type SignupResult =
  | { ok: true; value: SignupValue }
  | { ok: false; error: { code: SignupErrorCode; message: string } };

function refuse(code: SignupErrorCode, message: string): SignupResult {
  return { ok: false, error: { code, message } };
}

export async function signup(input: SignupInput, deps: SignupDeps): Promise<SignupResult> {
  const email = input.email.trim();
  const password = input.password;

  if (!email || !password) {
    return refuse("missing_fields", "Faltan datos. Completá todos los campos.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return refuse(
      "password_too_short",
      `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    );
  }
  if (password !== input.confirmPassword) {
    return refuse("password_mismatch", "Las contraseñas no coinciden.");
  }
  if (!input.tosAccepted) {
    return refuse(
      "tos_not_accepted",
      "Tenés que aceptar los Términos y la Política de privacidad.",
    );
  }

  // Rate limit per trusted edge IP before creating a GoTrue user. Keyed off the
  // caller-resolved edge IP (x-real-ip / last XFF hop, not the spoofable first
  // segment). A non-RateLimitError propagates → fail closed.
  //
  // THE CEILING IS NO LONGER A LITERAL HERE, and the paragraph that used to
  // justify one is gone with it. It read "Tighter than login: signup is never a
  // high-frequency legitimate action, so a low ceiling caps both account-spam and
  // the enumeration oracle (audit 28-#3) cost" — a good instinct sized for a
  // browser, which refused the sixteenth citizen behind a carrier gateway once the
  // app shipped.
  //
  // IT NAMED TWO THINGS AND THE SECOND ONE IS PAID FOR SOMEWHERE. That sentence
  // was the only place in the repo linking this ceiling to the enumeration oracle
  // below, so deleting it would have retired the analysis along with the number.
  // The oracle is still open on the session-presence channel (see the masquerade
  // further down, and `enable_confirmations=false`), this bucket is the only thing
  // metering it, and raising the two SHORT windows (3/min · 15/hr → 60/min ·
  // 180/hr) lets one address test a list of citizens' addresses 240× faster —
  // 180 of them in three minutes where it took twelve hours — for the same
  // unchanged daily total of 360. That is
  // priced as cost 6 in `signup-limits.ts`, with the table, the squatting side
  // effect, and why the fix is a PO decision and not a smaller number here.
  //
  // This is the ONLY bucket this act has: signup CREATES the identity, so unlike
  // login and password-recovery there is no per-email anchor standing behind the
  // per-IP one (a per-email counter reads 1 for a citizen and 1 for a farm
  // alike). That is why the derivation is its own file rather than a copy of a
  // sibling's, and why it is shaped as a burst allowance with a DAY ceiling
  // instead of a single window. See `signup-limits.ts` — including what the
  // change costs and the three instruments it deliberately does not reach for.
  try {
    await enforceRateLimit("auth_signup_ip", input.callerIp, SIGNUP_IP_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return refuse("rate_limited", "Demasiados intentos. Esperá un momento y volvé a probar.");
    }
    throw err;
  }

  const auth = await deps.auth();
  // POSTURE (PO decision 2026-07-10): email confirmation is intentionally OFF —
  // single-step signup, no verification for now. With confirmations OFF, signUp
  // returns a session immediately, so step 2 (completeIdentityAction) runs with
  // an authenticated user and its getUser() gate passes cleanly.
  //
  // If confirmations are EVER turned ON in the Supabase dashboard, signUp returns
  // NO session; step 2's getUser() gate then finds no user. That branch used to
  // silently redirect back to step 1 → a silent loop that also discarded the
  // name the user typed. Mitigations, in order of preference, before flipping the
  // dashboard switch:
  //   1. Collect the real name in step 1 and pass it here via
  //      `options: { data: { display_name } }` so handle_new_user (db/triggers.sql,
  //      migration 0135) persists it even when no session is returned — the trigger
  //      reads raw_user_meta_data->>'display_name' and only falls back to the email
  //      local-part when it is absent.
  //   2. completeIdentityAction now fails HONESTLY on a missing session (shows a
  //      "confirmá tu correo / volvé a iniciar sesión" message) instead of looping.
  // In the current two-step ordering the name is not known until step 2, so no
  // display_name metadata is supplied here; the trigger derives a provisional
  // display_name from the email local-part and completeIdentityAction overwrites
  // it with the real "First Last" in the happy path.
  const { data, error } = await auth.signUp({ email, password });

  if (error) {
    // Account enumeration defense (audit 28-#3, pilot MED).
    // Supabase returns a distinct "User already registered" error when the email
    // exists. Surfacing that (or any "ya existe" copy) lets an attacker probe
    // which emails have accounts. Return the SAME success shape as a genuine new
    // signup so the two are indistinguishable to the client. The duplicate is
    // still prevented server-side — Supabase created no new user, so a duplicate
    // account cannot be minted; a duplicate simply lands with no session and is
    // bounced back to /signup at step 2 (completeIdentityAction's getUser check).
    //
    // Residual, unchanged by WU-A and now stated on both transports: with email
    // confirmations OFF a genuine signup receives a credential and a duplicate
    // does not. The web leaks that through the presence of a session cookie;
    // `/api/v1` leaks it through `session: null`. Identical information,
    // identical cost to probe — adding a fake session to the API response would
    // hand a native client a token that authenticates nobody, which is worse
    // than the leak. Closing it needs confirmations ON in the Supabase
    // dashboard (PO-gated, tracked separately).
    const lower = error.message.toLowerCase();
    if (lower.includes("already") || lower.includes("registered")) {
      return { ok: true, value: { session: null } };
    }
    // THE PASSWORD REFUSAL IS TOLD, NOT SWALLOWED, AND THAT DOES NOT REOPEN THE
    // LEAK THE PARAGRAPH ABOVE CLOSES.
    //
    // Measured on the live project 2026-09-11: with leaked-password protection
    // on, GoTrue answers `POST /signup` with 422 and "Password is known to be
    // weak and easy to guess, please choose a different one." That collapsed
    // into `signup_failed`, whose copy is "volvé a intentar en unos minutos" —
    // advice that CANNOT WORK. The same password is refused forever, so the
    // person retries until they give up, on the first screen of the product.
    // Seven attempts in eight minutes are in the logs; the person was the
    // product owner, and a pilot tester would simply have left.
    //
    // WHY IT IS SAFE TO SAY, AND THIS TIME IT WAS MEASURED.
    // The enumeration defence above exists because "already registered" reveals
    // that an email HAS an account. This refusal reveals nothing about the
    // email ON OUR SIDE: it is a verdict on the characters just typed, decided
    // by the provider's answer and never by the address, which
    // `signup-enumeration.test.ts` pins.
    //
    // THE UPSTREAM RESIDUAL, CLOSED 2026-09-11. The worry was ordering: if
    // GoTrue ran its user-exists check BEFORE password strength, a registered
    // address would answer 200-with-no-session while an unregistered one
    // answered 422 — two behaviours each correct alone, composing into a
    // one-probe oracle. An earlier version of this comment called that settled
    // without anybody checking, which is why it was then written down as an
    // open question, and then actually probed against the live project:
    //
    //   POST /auth/v1/signup, password "password123"
    //     owner@dim.test (registered)    -> 422 weak_password, no user, no session
    //     probe-<uuid>@dim.test (fresh)  -> 422 weak_password, no user, no session
    //
    // Byte-identical, and no account was created by either. GoTrue evaluates
    // the password FIRST, so there is no oracle on this path. If that ordering
    // ever changes upstream the two answers diverge, which is what the probe
    // would show again — it is cheap and reserved-TLD addresses make it
    // harmless to repeat.
    //
    // MATCHED ON THE MESSAGE, like the branch above it, and the fragility is
    // stated rather than hidden: the Supabase SDK does not carry a stable code
    // on this path today. If the wording changes upstream this silently falls
    // back to `signup_failed` — the old behaviour, not a new failure. The test
    // pins the real sentence from the logs so a change is noticed.
    //
    // MATCHED ON THE CODE, AND THE TWO EARLIER VERSIONS OF THIS LINE ARE THE
    // ARGUMENT FOR IT. The first matched `includes("password")`, which also
    // catches "Password cannot be longer than 72 characters" — nothing upstream
    // caps the length, so a password-manager passphrase was told it was easy to
    // guess. The second matched the verdict words instead, which was better and
    // still a substring.
    //
    // `error.code` is neither: `weak_password` is a member of
    // `@supabase/auth-js`'s own typed `ErrorCode` union, and the live project
    // was probed on 2026-09-11 to confirm it reaches the wire
    // (`"error_code":"weak_password"`, HTTP 422). The message fallback stays for
    // an older SDK or a proxy that drops the field — belt and braces, with the
    // braces now doing the work.
    const isWeakPassword =
      error.code === "weak_password" ||
      lower.includes("known to be weak") ||
      lower.includes("easy to guess");
    if (isWeakPassword) {
      return refuse(
        "weak_password",
        "Esa contraseña es muy fácil de adivinar. Elegí otra, con palabras o números que no uses en otro lado.",
      );
    }
    // Every other failure returns a single generic message — never the raw
    // Supabase text, which could itself hint at account state.
    return refuse(
      "signup_failed",
      "No pudimos completar el registro. Revisá tus datos e intentá de nuevo.",
    );
  }

  // Do NOT redirect. The inline signup flow uses this success signal to
  // transition the same page to the identity-collection step (step 2).
  return { ok: true, value: { session: toAuthSessionV1(data.session) } };
}
