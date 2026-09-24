// POST /api/v1/auth/signup — step 1 of the two-step signup, for a client with
// no cookie jar.
//
// The same adapter shape as its login sibling: parse with the schema the client
// already validated against, call the SAME `signup` use-case the web form
// calls, map the coded result to a status. The per-IP budget (`auth_signup_ip`)
// is spent inside the use-case, so this transport shares the form's counter
// rather than getting its own.
//
// THAT BUDGET IS THE ONLY ONE THIS ACT HAS, which is why it is shaped unlike
// every other ceiling on this surface: signup CREATES the identity, so there is
// no per-email bucket standing behind the per-IP one the way there is on login.
// It is a wide burst allowance (60/min · 180/hr, sized for a plaza registration
// drive) under a per-DAY ceiling (360) that is what a farm actually runs into.
// Derivation, costs and the options rejected: `signup-limits.ts`.
//
// THE 201 THAT MAY CARRY NO SESSION, AND WHY THAT IS THE POINT
// ---------------------------------------------------------------------------
// A signup for an email that ALREADY EXISTS returns 201 with `session: null` —
// byte-identical to nothing, because there is nothing else to compare it to:
// the alternative is a distinguishable "ya existe", which is the account
// enumeration oracle audit 28-#3 closed on the web form. A client MUST read
// `session: null` as "go to the login screen", never as an error.
//
// The residual is real and unchanged by this endpoint: a GENUINE new signup
// (email confirmations OFF, PO decision 2026-07-10) receives a credential and a
// duplicate does not, so the presence of `session` still separates the two. The
// web leaks exactly the same bit through the presence of a session cookie —
// identical information, identical cost to probe. Fabricating a session for the
// duplicate would hand a native client a token that authenticates nobody, which
// is worse than the leak. Closing it needs confirmations ON in the Supabase
// dashboard (PO-gated, tracked separately), and that change closes BOTH
// transports at once precisely because they share this use-case.
//
// STEP 2 (identity: first name, last name, DNI) IS NOT HERE. `completeIdentity`
// is still coupled to the web request and is not in WU-A's scope; a native
// client completes step 1 here and, until that use-case is decoupled too, has
// no `/api/v1` door for step 2. Said out loud rather than discovered: an
// account created through this endpoint has a provisional display_name derived
// from the email local-part by the `handle_new_user` trigger, and `GET
// /api/v1/me` reports `profilePending: true` until a profile row exists.

import type { SignupV1 } from "@dim/contract/api";
import { signupInputSchema } from "@dim/contract/input";

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { callerIp } from "@/lib/infra/rate-limit";
import { createAnonClient } from "@/lib/supabase/anon";
import { signup } from "@/src/modules/auth/application/signup";

export const dynamic = "force-dynamic";

/** One limiter write plus a GoTrue account creation. See the login sibling. */
const SIGNUP_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// @no-auth-required: signup is BY DEFINITION pre-authentication — creating the
// account is what this endpoint is for. Bounded rather than authorized, by the
// `auth_signup_ip` budget the use-case spends before GoTrue is touched
// (src/modules/auth/application/signup.ts).
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally (PASSWORD_TOO_SHORT, PASSWORD_MISMATCH, TOS_NOT_ACCEPTED). This is
  // the backstop for a client out of step with the contract package — including
  // one that tries to omit `tosAccepted`, which the schema requires as a
  // literal boolean because a legal acceptance is never defaulted into being.
  const parsed = signupInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  let result: Awaited<ReturnType<typeof signup>>;
  try {
    result = await withDbBudgetOrThrow(
      signup(
        {
          email: parsed.data.email,
          password: parsed.data.password,
          confirmPassword: parsed.data.confirmPassword,
          tosAccepted: parsed.data.tosAccepted,
          callerIp: callerIp(request.headers),
        },
        { auth: async () => createAnonClient().auth },
      ),
      SIGNUP_BUDGET_MS,
      "api-v1-auth-signup",
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
      case "rate_limited":
        return apiV1Error("rate_limited", 429);
      case "signup_failed":
        return apiV1Error("signup_failed", 400);
      // 422 and not 400, mirroring what GoTrue itself answered: the body parsed
      // and the request was well formed — one VALUE in it was refused. It is
      // deliberately NOT folded into `invalid_request` below, because that code
      // means "the client is out of step with the contract" and carries copy
      // telling the person to update the app. Here the client did everything
      // right and the person must change one field.
      case "weak_password":
        return apiV1Error("weak_password", 422);
      // The four validation branches. All four are the schema's job one line
      // above; the use-case re-checks them because it may not assume its caller
      // validated, and they collapse to one wire code because a client that
      // reaches them is out of step with the contract, not asking which field
      // to highlight.
      case "missing_fields":
      case "password_too_short":
      case "password_mismatch":
      case "tos_not_accepted":
        return apiV1Error("invalid_request", 400);
      default: {
        const unhandled: never = result.error.code;
        throw new Error(`Unhandled signup failure: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // 201: the request created an account, or is indistinguishable from one that
  // did. `session` is nullable and BOTH cases are normal — see the header.
  const payload: SignupV1 = { session: result.value.session };
  return apiV1Json(payload, { status: 201 });
}
