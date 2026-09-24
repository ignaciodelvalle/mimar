// `POST /api/v1/me/identity` — signup step 2, from the app.
//
// THE ONE ENDPOINT ON THIS SURFACE THAT A PENDING IDENTITY MAY CALL
// ---------------------------------------------------------------------------
// Every other authenticated door refuses a caller whose identity is still
// provisional, and each of them is right to: `POST /api/v1/pets` answers
// `identity_pending` ("go and finish registering"), and `/api/v1/me/profile`
// answers `not_found` on BOTH its halves, the write half deliberately — a
// provisional account posting a real-looking `displayName` there would have
// completed step 2 without ever running it.
//
// This route IS step 2. Copying either gate here would be an endpoint that
// refuses the only callers it exists for, and answering `identity_pending` in
// particular would send a client back to the screen it is already on. So the
// pattern followed here is `/api/v1/me`'s — guard for LIVENESS, say nothing
// about completeness — and not `/api/v1/me/profile`'s.
//
// WHAT STOPS IT BEING THE HOLE THOSE GATES CLOSE. The two doors above are
// guarded because a name arriving through them would complete the identity
// WITHOUT the step's own rules. This route runs those rules: two names, both
// required, both bounded, joined the way the web joins them
// (`identityDisplayName`), and refused outright if the result would still read as
// provisional. It is not a bypass of step 2; it is step 2, over a bearer token.
//
// WHY IT EXISTS AT ALL (PO decision, 2026-09-05)
// ---------------------------------------------------------------------------
// A fresh native signup used to be sent to the browser — `/registro?from=app` —
// to SIGN IN AGAIN (the app holds a bearer token, the web resolves a cookie) and
// type a name there. Pilot testers read the second login as "confirm your email":
// one hour of GoTrue log on 2026-09-05 carries 8 invalid-credential attempts and
// 2 duplicate signups on that step. The DNI stays on the web — it is hashed, it
// carries a uniqueness claim, and it is the half the Mi Argentina federation path
// (invariant #6) will replace — and the name moves here.
//
// THE RESPONSE CARRIES THE FRESH USER, not `{ saved: true }`. See
// `IdentityCompletedV1`: the caller's whole reason for calling is that it is
// `profilePending: true`, and a bare acknowledgement would leave it holding a
// session state it now knows to be stale, with a second round trip to `/me` and a
// window in between where its own gate still refuses.
//
// NO Idempotency-Key, for `/me/profile`'s reason: completing an identity is a
// VALUE, not an append. Sending the same two names twice sets them once, and the
// second call answers the same 200 with the same user.

import { isIdentityPending, toMeV1User } from "@/lib/domain/identity-completeness";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { completeIdentityForUser } from "@/src/modules/auth/application/complete-identity-for-user";
import type { IdentityCompletedV1 } from "@dim/contract/api";
import { completeIdentityInputSchema, identityDisplayName } from "@dim/contract/input";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

/** One UPDATE on an indexed single row, with its `RETURNING`. */
const IDENTITY_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said WITHOUT writing the opt-out marker,
// because a comment that spells the marker in order to deny it still reads as one
// to a scanner matching the token (measured on `/api/v1/me`).
export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do (check-api-guard-headers).
  //
  // IP FIRST, before the GoTrue round trip, so an unauthenticated hammer is
  // refused cheaply. `authenticated-write` and not `account-security`: this is
  // one person in a form on their own row, which is that family's anchor.
  if (
    !(await spendBudget(
      "api_v1_me_identity_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, so a guard factored
  // into a module-level function reads as ABSENT — and that is the right rule
  // rather than a limitation.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-identity-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  // THE PENDING GATE IS INVERTED HERE, NOT ABSENT — see the block after the body
  // parse. `/me/profile` refuses a caller whose identity is PENDING; this route
  // refuses one whose identity is already COMPLETE and who is trying to store a
  // different name. Same predicate, opposite arm, and between the two of them
  // `profiles.display_name` has exactly one door per state.

  // Per-user budget, spent only once the caller is KNOWN — the bucket carrier NAT
  // cannot dilute, because identities are not shared.
  if (
    !(await spendBudget(
      "api_v1_me_identity_user",
      live.user.id,
      API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against THIS schema first and got per-field codes
  // locally (`CompletarRegistro` runs `completeIdentityInputSchema` before it
  // spends a request). This is the backstop for a client out of step with the
  // contract, which is why it carries no field detail — §2 makes the error
  // envelope a single key, so "which box" is a thing the phone answers and the
  // wire does not.
  const parsed = completeIdentityInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  // ═══════════════════════════════════════════════════════════════════════════
  // THE RENAME GATE (security review, 2026-09-05)
  // ═══════════════════════════════════════════════════════════════════════════
  // This route ends the provisional state, ONCE. It is not the rename door —
  // that is `POST /api/v1/me/profile`, which takes a whole `displayName`, writes
  // its own audit row, and refuses a PENDING caller for the mirror-image reason.
  //
  // Without this block the endpoint was a SECOND writer onto
  // `profiles.display_name` addressable by any bearer token, and that column is
  // not only this person's label: `lib/infra/audit-history-query.ts` resolves the
  // operator names shown in `/gob/historial` from it at READ time, so renaming
  // through here retroactively relabels every past row that person appears in.
  // The audit row `completeIdentityForUser` now writes records such a rename;
  // this block is what stops it being available in the first place.
  //
  // IDENTICAL NAMES STILL ANSWER 200. That is the lost-response retry the
  // docblock promises and it must survive the gate: the first call landed, the
  // answer did not arrive, the client re-sends the same body. It is answered
  // from the guard's own profile with NO write and NO audit row — writing again
  // would claim a change that did not happen.
  //
  // AFTER THE BODY IS PARSED, unlike `/me/profile`'s pending check, and the
  // difference is deliberate rather than an inconsistency. That one refuses
  // before reading the body so a half-registered caller cannot learn whether its
  // JSON would have been accepted; this one is about a COMPLETE account, which
  // already has full access to this surface, so there is no asymmetry to
  // protect — and the refusal genuinely depends on what was submitted.
  const storedDisplayName = live.profile?.displayName ?? "";
  if (!isIdentityPending({ displayName: storedDisplayName, email: live.user.email })) {
    const submitted = identityDisplayName(parsed.data.firstName, parsed.data.lastName);
    if (submitted !== storedDisplayName) return apiV1Error("identity_already_complete", 409);

    // The retry arm. `live.profile` is non-null here: `isIdentityPending` answers
    // true for a missing profile, so reaching this line means the guard resolved
    // one — but it is narrowed explicitly rather than asserted, because a
    // non-null assertion is how that reasoning stops being checked.
    if (live.profile) {
      const payload: IdentityCompletedV1 = {
        user: toMeV1User({
          id: live.user.id,
          email: live.user.email,
          profile: {
            displayName: live.profile.displayName,
            role: live.profile.role,
            accountType: live.profile.accountType,
          },
        }),
      };
      return apiV1Json(payload, { status: 200 });
    }
  }

  let result: Awaited<ReturnType<typeof completeIdentityForUser>>;
  try {
    result = await withDbBudgetOrThrow(
      // `live.user.id` and NOT anything from the body. The writer takes a
      // `userId` and writes that row; a caller-supplied one would let any client
      // rename any account by UUID.
      completeIdentityForUser({
        userId: live.user.id,
        email: live.user.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        // NO DNI. The native step does not collect one and this route does not
        // accept one: `completeIdentityInputSchema` has no such field, so there
        // is nothing here to forward even if a client sent it.
      }),
      IDENTITY_BUDGET_MS,
      "api-v1-me-identity-write",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!result.ok) {
    // Bound to a local so the `never` in the default arm narrows the CODE rather
    // than the whole result object — `result.error` on an exhausted union is
    // itself a type error, which is how this switch first refused to compile.
    const refusal = result.error;
    switch (refusal) {
      // The schema above already ruled this out, so reaching it means the two
      // parses disagree — a 400 about the request rather than a 500 about the
      // platform, because the body really is what the writer rejected.
      case "VALIDATION":
        return apiV1Error("invalid_request", 400);
      case "STILL_PROVISIONAL":
        return apiV1Error("identity_name_provisional", 422);
      case "WRITE_FAILED":
        return apiV1Error("identity_failed", 500);
      default: {
        const unhandled: never = refusal;
        throw new Error(`Unhandled identity refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // BELT AND BRACES ON THE ONE PROMISE THIS PAYLOAD MAKES. `IdentityCompletedV1`
  // says `profilePending` is false in every 200, and the writer already refuses
  // the value that would break that — but the promise is what a client uses to
  // stop showing the gate, so it is asserted against the payload actually being
  // sent rather than inferred from the branch that produced it. A `true` here
  // would mean the projection and the predicate disagree, which is a server bug
  // and not a client's to absorb.
  if (result.user.profilePending) {
    reportError(
      "api-v1-me-identity",
      new Error("completed identity still projects profilePending: true"),
    );
    return apiV1Error("identity_failed", 500);
  }

  const payload: IdentityCompletedV1 = { user: result.user };
  return apiV1Json(payload, { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter on
 * this surface. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing here would strand a half-registered account on the gate
 * screen with no way out — over an abuse control. The authorization boundary
 * above is the one that fails CLOSED, and it is the one that must.
 */
async function spendBudget(
  endpoint: string,
  identifier: string,
  limit: { maxPerMinute?: number; maxPerHour?: number; maxPerDay?: number },
): Promise<boolean> {
  try {
    await enforceRateLimit(endpoint, identifier, limit);
    return true;
  } catch (err) {
    if (err instanceof RateLimitError) return false;
    reportError(`api-v1-me-identity/${endpoint}`, err);
    return true;
  }
}

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `DEACTIVATED` is refused, like `/me/profile`'s write and unlike
 * `libreta-export`'s read. The repo's policy after the 2026-07-04 redirect
 * incident is "reads stay open so the user can see why; writes stop", and this is
 * unambiguously a write. It is also unreachable in practice: deactivation is an
 * institutional-account flag and an institutional account is created by an
 * administrator with a real name already on it, so no deactivated account is
 * sitting on signup step 2.
 */
function liveUserRefusal(reason: LiveUserFailureReason) {
  switch (reason) {
    case "NO_SESSION":
      return apiV1Error("auth_expired", 401);
    case "ACCOUNT_ERASED":
      return apiV1Error("account_erased", 403);
    case "DEACTIVATED":
      return apiV1Error("account_deactivated", 403);
    case "SHIFT_EXPIRED":
      return apiV1Error("session_shift_expired", 401);
    case "MAINTENANCE":
      return unavailable();
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
