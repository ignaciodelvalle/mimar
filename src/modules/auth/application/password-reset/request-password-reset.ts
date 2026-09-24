// Use-case: requestPasswordReset — spend two budgets, then ask GoTrue to mail a
// recovery credential. Decoupled from the web request in WU-R-1, for the reason
// `login` and `signup` were decoupled in WU-A: there is now a second transport.
//
// WHAT MOVED, AND WHAT DID NOT
// ---------------------------------------------------------------------------
// `FormData`, `headers()` and the cookie-backed Supabase client left for the
// action edge (`src/modules/auth/actions.ts`) and the `/api/v1` adapter; this
// file takes plain data and one injected port. The refusal copy, the ORDER of
// the two budgets, the `redirectTo` and — most importantly — the deliberate
// blindness to GoTrue's answer are unchanged. The diff is the boundary.
//
// The ceilings themselves DID move, and they moved for both transports at once
// because there is one of them: see `./limits.ts` for why 3/min · 15/hr was a
// number sized against a browser and what a carrier gateway does to it.
//
// ===========================================================================
// WHAT A REFUSAL MAY NEVER REVEAL, AND WHY THERE IS NO REFUSAL FOR IT
// ===========================================================================
// This use-case has exactly two failure codes and NEITHER of them is about the
// account. There is no `account_not_found`, there is no branch that could
// produce one, and the GoTrue call's result is not even bound to a name:
//
//     await deps.auth.resetPasswordForEmail(email, { redirectTo });
//
// An address with an account and an address without one take the identical path
// through this function, spend the identical budgets, and return the identical
// success. That is the property audit 28-#3 bought on the signup form, held here
// by construction rather than by a matching pair of strings — and it is the one
// the `/api/v1` adapter must not undo by giving the two a different status.
//
// IT IS NOT A COMPLETE DEFENCE AND SAYING SO IS THE POINT. Two side channels
// remain and neither is closable from this file:
//   · TIMING. GoTrue does more work for an address it knows (it mints a token and
//     hands a message to a mail provider) than for one it does not. The
//     difference is a network call inside somebody else's process and it is not
//     measured here; a determined prober with a stopwatch is not refuted by this
//     paragraph.
//   · MAIL DELIVERY. The person holding the mailbox learns the answer, which is
//     the entire purpose of the feature.
// What IS closed is the cheap, scriptable one: the response.
//
// ===========================================================================
// WHAT THIS WRITES: NOTHING, AND THAT IS A DELIBERATE ANSWER
// ===========================================================================
// No event, no cache, no row of ours. Invariant #2 (append-only) and invariant #3
// (caches declare themselves) are both about the SPINE — facts about an animal's
// medical and custody life — and a password is not a fact about an animal. It is
// not even a fact about a person in the sense the spine means: it is a
// credential, it lives in `auth.users`, and GoTrue owns its lifecycle.
//
// The only rows this flow touches are `rate_limit_buckets`, which are counters and
// declare themselves as such, and whatever GoTrue writes in its own schema. A
// `password_reset_requested` event was considered and rejected: it would put a
// row on the spine for every address somebody types into the box, including
// addresses with no account — which would make the spine itself the enumeration
// oracle the response refuses to be.
//
// @no-auth-required: password reset request is BY DEFINITION pre-authentication;
// the user cannot log in and is asking for a recovery credential.

import { RateLimitError, emailRateLimitKey, enforceRateLimit } from "@/lib/infra/rate-limit";

import type { PasswordResetAuthPort } from "../gotrue-port";
import { PASSWORD_RESET_EMAIL_LIMIT, PASSWORD_RESET_IP_LIMIT } from "./limits";

/**
 * Plain-data input. `callerIp` is resolved by the caller from the request
 * (`callerIp(headers)`) and is NOT client-supplied — see `LoginInput`.
 */
export type RequestPasswordResetInput = {
  email: string;
  callerIp: string;
};

export type RequestPasswordResetDeps = {
  /**
   * Built only after validation and the rate-limit budgets pass, exactly as
   * `LoginDeps`/`SignupDeps` are — so "nothing touches GoTrue until the budgets
   * pass" stays a property of this file rather than of its caller's statement
   * order.
   */
  auth: () => Promise<PasswordResetAuthPort>;
};

export type RequestPasswordResetErrorCode = "missing_fields" | "rate_limited";

/**
 * SUCCESS CARRIES NOTHING, and the empty arm is the contract rather than an
 * oversight. Anything at all in a success value — a boolean, a count, a
 * timestamp — would be a place for a future edit to leak whether a mail was
 * actually sent, which is the same bit as whether the account exists.
 */
export type RequestPasswordResetResult =
  | { ok: true }
  | { ok: false; error: { code: RequestPasswordResetErrorCode; message: string } };

function refuse(code: RequestPasswordResetErrorCode, message: string): RequestPasswordResetResult {
  return { ok: false, error: { code, message } };
}

/**
 * Where a recovery link lands. The WEB's callback, on both transports and on
 * purpose.
 *
 * ONE MAIL, TWO REDEMPTIONS. The mail GoTrue sends carries the same recovery
 * token in two forms — a link (`{{ .ConfirmationURL }}`, which is this url) and a
 * six-digit code (`{{ .Token }}`). A browser follows the link. A phone with no
 * verified App Links CANNOT follow it back into the app — Android hands an
 * unverified `https` url to Chrome — so the native client redeems the CODE
 * against GoTrue instead, and never sees this string at all.
 *
 * That is why the native transport does not get a `redirectTo` of its own, and
 * why it must not: a `mimar://` redirect would mail a recovery credential to an
 * UNVERIFIED custom scheme that any installed app may claim (see APP_SCHEME in
 * `@dim/contract/links`), which is strictly worse than the browser it was meant
 * to avoid.
 */
function recoveryRedirectTo(): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return `${siteUrl}/auth/callback?next=/recuperar/actualizar`;
}

export async function requestPasswordReset(
  input: RequestPasswordResetInput,
  deps: RequestPasswordResetDeps,
): Promise<RequestPasswordResetResult> {
  const email = input.email.trim();

  if (!email) {
    return refuse("missing_fields", "Ingresá tu correo electrónico.");
  }

  // Both budgets before dispatching anything. Per-IP caps how many recovery
  // mails one source can trigger; per-email caps mail-bombing one person's inbox
  // from many sources. The per-email key is hashed so no cleartext address is
  // persisted in `rate_limit_buckets`. Derivation: ./limits.ts.
  //
  // A non-RateLimitError propagates → fail closed. A limiter that cannot answer
  // must not be read as "allowed".
  try {
    await enforceRateLimit("auth_password_reset_ip", input.callerIp, PASSWORD_RESET_IP_LIMIT);
    await enforceRateLimit(
      "auth_password_reset_email",
      emailRateLimitKey(email),
      PASSWORD_RESET_EMAIL_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return refuse("rate_limited", "Demasiados intentos. Esperá un momento y volvé a probar.");
    }
    throw err;
  }

  const auth = await deps.auth();
  // THE ANSWER IS NOT BOUND TO A NAME. See the header: an address with an account
  // and one without must take the identical path out of this function, and the
  // cheapest way to guarantee that is to have nothing to branch on.
  await auth.resetPasswordForEmail(email, { redirectTo: recoveryRedirectTo() });

  return { ok: true };
}
