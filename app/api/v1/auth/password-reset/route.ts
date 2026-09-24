// POST /api/v1/auth/password-reset — "mail me a way back in", for a client with
// no cookie jar (WU-R-1).
//
// WHAT THIS HANDLER IS
// ---------------------------------------------------------------------------
// The same adapter its two `auth/` siblings are, and deliberately nothing else:
// parse with the schema the client already validated against, call the SAME
// `requestPasswordReset` use-case the web form calls, map the coded result to a
// status. No limiter of its own, no refusal copy of its own, and — the one that
// matters here — no opinion of its own about what a refusal may say.
//
// WHY THE LIMITS CANNOT BE SIDESTEPPED BY SWITCHING TRANSPORT
// ---------------------------------------------------------------------------
// `auth_password_reset_ip` (12/min · 60/hr) and `auth_password_reset_email`
// (5/hr, keyed on the SHA-256 of the normalized address) are spent INSIDE the
// use-case, before GoTrue is touched. They are therefore the same buckets and
// the same keys as `/recuperar`'s: an attacker who exhausts an address's recovery
// budget on the web form does not get a fresh one here, and a script that starts
// here does not get a fresh one on the form. The derivation — including why both
// numbers moved when a carrier-NAT'd phone became the second caller — is
// `src/modules/auth/application/password-reset/limits.ts`.
//
// THERE IS NO `api_v1_*` BUCKET HERE, AND THAT IS THE POINT rather than an
// omission. `lib/infra/api-v1-limits.ts` families the ceilings a route owns for
// itself; this route owns none, exactly as `auth/login` and `auth/signup` own
// none. A per-transport ceiling on a shared act is a ceiling a caller escapes by
// using the other door.
//
// WHAT THIS RESPONSE MUST NEVER REVEAL — AND WHY 202 IS THE ONLY SUCCESS
// ---------------------------------------------------------------------------
// Whether the address has an account. The use-case does not know (it never binds
// GoTrue's answer to a name), so there is nothing here to leak even by accident,
// and the payload is a single-inhabitant type so that the two bodies are the same
// BYTES rather than two strings that happen to match. `PasswordResetRequestedV1`
// carries the argument at length.
//
// The 429 says nothing about the address either, and it is identical whichever of
// the two budgets ran out — the per-email one is the one that could otherwise
// answer "this account is being hammered", which is a statement about an account
// existing. NO `retry-after` on it, for the reason api-invariants.md §10 records:
// only one branch could carry an honest value, and a header on one and not the
// other makes the two distinguishable.
//
// HOW THE LOOP CLOSES ON A PHONE, WHICH IS THE WHOLE REASON THIS ROUTE EXISTS
// ---------------------------------------------------------------------------
// It does NOT close through this endpoint, and a reader looking for the other
// half should not go hunting for a `POST /api/v1/auth/password-reset/confirm`.
// There isn't one, on purpose, and the reasoning is the same shape as the missing
// refresh route's (`AuthSessionV1` in packages/contract/src/api/auth.ts).
//
// The mail GoTrue sends carries the recovery token twice — as a LINK and as a
// six-digit CODE. Android hands an unverified `https` link to Chrome, because
// verified App Links need a Play-signed fingerprint this project does not have
// yet (apps/mobile/app.config.ts explains why at length), so a phone cannot
// follow the link back into the app. Mailing a `mimar://` link instead would be
// worse, not better: the custom scheme is unverified and ANY installed app may
// claim it, which would hand account recovery to whoever claimed it first.
//
// So the native client redeems the CODE, against GoTrue directly, with
// `verifyOtp({ type: "recovery" })` followed by `updateUser({ password })`. That
// is the auth plane and not the data plane — it exchanges one credential for
// another inside GoTrue and reads no application table — which is the same line
// PO decision #2 draws for token refresh. What it costs, stated rather than
// hidden: the code-verification attempt is bounded by GoTrue's own
// `token_verifications` ceiling and not by ours. See
// `apps/mobile/src/auth/session-store.ts`.
//
// NO CORS HEADERS, for the login sibling's reason: a native `fetch` does not
// preflight and sends no `Origin` this surface would have to answer for, and
// adding `Access-Control-Allow-*` speculatively would let any web page trigger
// recovery mail to an address of its choosing from a browser.

import type { PasswordResetRequestedV1 } from "@dim/contract/api";
import { passwordResetRequestInputSchema } from "@dim/contract/input";

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { callerIp } from "@/lib/infra/rate-limit";
import { createAnonClient } from "@/lib/supabase/anon";
import { requestPasswordReset } from "@/src/modules/auth/application/password-reset/request-password-reset";

// Reads the request's own headers for the caller IP, so it can never be
// statically rendered. Declared explicitly, matching the sibling handlers.
export const dynamic = "force-dynamic";

/**
 * Ceiling for the whole exchange: two limiter writes and one GoTrue round-trip
 * that includes handing a message to a mail provider. The same 8s the two
 * siblings allow, and for the same reason — the slow part is somebody else's
 * process, and a request that times out is a request the user repeats, which
 * spends another slice of the budget that exists to stop exactly that.
 */
const PASSWORD_RESET_BUDGET_MS = 8_000;

/** Advisory backoff when the exchange blew its budget. Not a limiter window. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// @no-auth-required: asking for a recovery credential is BY DEFINITION
// pre-authentication — the caller cannot sign in, which is why they are here. It
// is bounded rather than authorized, by the two budgets the web form spends:
// `auth_password_reset_ip` and `auth_password_reset_email`, both enforced inside
// the use-case BEFORE GoTrue is touched
// (src/modules/auth/application/password-reset/request-password-reset.ts).
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // A malformed body never reaches the limiter, deliberately: it costs the
    // platform no counter and reveals nothing.
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this exact schema before sending and got a
  // per-field code locally. This is the BACKSTOP, so the single-key envelope
  // (§2) is the right shape: a client that reaches here is out of step with the
  // contract package, not asking which field to highlight.
  const parsed = passwordResetRequestInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  let result: Awaited<ReturnType<typeof requestPasswordReset>>;
  try {
    result = await withDbBudgetOrThrow(
      requestPasswordReset(
        {
          email: parsed.data.email,
          callerIp: callerIp(request.headers),
        },
        { auth: async () => createAnonClient().auth },
      ),
      PASSWORD_RESET_BUDGET_MS,
      "api-v1-auth-password-reset",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    throw err;
  }

  if (!result.ok) {
    switch (result.error.code) {
      // Over one of the two budgets. Which one is deliberately not said — see
      // the header.
      case "rate_limited":
        return apiV1Error("rate_limited", 429);
      // The schema should have caught this one line earlier; the use-case
      // re-checks because a use-case may not assume its caller validated.
      case "missing_fields":
        return apiV1Error("invalid_request", 400);
      default: {
        const unhandled: never = result.error.code;
        throw new Error(`Unhandled password-reset failure: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // 202: accepted, and everything downstream of that is information this
  // endpoint declines to have. One inhabitant, so the body cannot vary with the
  // address. See `PasswordResetRequestedV1`.
  const payload: PasswordResetRequestedV1 = { requested: true };
  return apiV1Json(payload, { status: 202 });
}
