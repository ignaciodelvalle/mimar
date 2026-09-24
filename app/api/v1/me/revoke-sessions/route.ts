// POST /api/v1/me/revoke-sessions — B11, "cerrar sesión en todos los
// dispositivos" for the native client.
//
// WHAT IT IS FOR
// ---------------------------------------------------------------------------
// The counterpart that makes B9's long citizen session defensible. A 30-day
// session is only acceptable if the person holding it can end it from somewhere
// else — a phone left on a bus is the whole scenario. Without this the wallet's
// convenience is bought entirely with the user's exposure.
//
// THE RESPONSE CONTRACT, AND WHY IT IS HONEST
// ---------------------------------------------------------------------------
//   200 { revoked: true }   — every session is gone, INCLUDING the one that made
//                             this request. The bearer token in the caller's
//                             hand is dead by the time it reads this body.
//   401 on everything after — and immediately, not at token expiry. Measured
//                             against GoTrue v2.188.1: after `scope=global` the
//                             access token is refused at once (403 upstream) and
//                             the refresh token answers 400
//                             `refresh_token_not_found`.
//
// So a client must treat the 200 as "you are now signed out" and go to its login
// screen. It must NOT try to refresh: the refresh token died with the session,
// and a client that retries will loop. `AuthSessionV1`'s usual "refresh once on
// 401" rule is exactly wrong here, which is why the 200 body says `revoked`
// rather than being empty — the client has one unambiguous signal to act on.
//
// A BARE PAYLOAD, per the write convention (§2 / api-invariants.md). `POST
// /api/v1/pets` answers `PetRegisteredV1` with no wrapper and no envelope
// fields; a write is not a snapshot, so `payloadVersion`/`issuedAt`/`staleAfter`
// would be three fields describing a thing that has no staleness. The auth codes
// remain siblings through `apiV1Error`.
//
// NO Idempotency-Key, and this is a decision rather than an omission. The header
// is required on `POST /api/v1/pets` because a retried registration would create
// a SECOND ANIMAL. Revocation is naturally idempotent: the second call revokes an
// already-revoked set and changes nothing. In practice the retry cannot even
// reach the use-case — the token it would carry is dead, so it lands on 401.
// Demanding a key here would add a failure mode (`idempotency_key_required`) to
// a security control, in exchange for protection against a duplicate that has no
// cost.
//
// RATE LIMITED MODESTLY, IN TWO PLACES THAT ARE NOT THE SAME PLACE.
//
// The IP bucket is HERE, before authentication, so an unauthenticated hammer
// costs nothing downstream. It belongs to this transport: anyone can POST to an
// endpoint, and bounding that is a property of the endpoint.
//
// The USER bucket moved into the shared use-case on 2026-08-25
// (`REVOKE_SESSIONS_USER_BUCKET`, 5/min · 20/hr · 40/day) and this file used to
// own it. The paragraph that lived here argued at length why the bound is needed
// — and the WEB action, calling the same use-case, had no limiter at all. So the
// ceiling was a property of the TRANSPORT, and a caller holding a stolen cookie
// used the button instead of the endpoint. `login` had already solved this by
// putting its two budgets inside the shared use-case; this now matches. The
// reasoning for the numbers lives with the numbers, in revoke-sessions.ts.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { API_V1_ACCOUNT_SECURITY_IP_LIMIT } from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { revokeAllPushTargetsForUser } from "@/lib/infra/push-target-store";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { revokeAllSessions } from "@/src/modules/auth/application/revoke-sessions";

export const dynamic = "force-dynamic";

/** One `auth.getUser()` round-trip to GoTrue plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// THE PER-IP CEILING: ITS OWN FAMILY, AND A RAISE AGAINST WHAT THIS FILE SAID
// ---------------------------------------------------------------------------
// It is `API_V1_ACCOUNT_SECURITY_IP_LIMIT` (lib/infra/api-v1-limits.ts) — a
// family of exactly one route, applied BEFORE authentication so a caller with no
// usable token costs nothing but a counter write.
//
// The paragraph that stood here refused a CGNAT raise, and it is quoted rather
// than deleted because half of it is still right: "this endpoint is not something
// a thousand neighbours behind one carrier gateway do at once — it is a rare,
// deliberate act, and 30/min leaves room for a whole office to use it in the same
// minute."
//
// WHAT WAS WRONG WITH IT is the office. A whole office is a shared CORPORATE
// address; this endpoint's caller is a phone. Sizing a limiter against an office
// when the caller is a phone is precisely the error B13 found in the credential
// endpoint, where `atender_lookup`'s numbers — written to bound an organization's
// staff on office IPs — refused the 51st neighbour to scan a lost-pet poster.
//
// AND THE AVERAGE DAY IS NOT THE CASE THAT MATTERS. The case that matters is a
// breach advisory: this project, or a jurisdiction, telling people to sign out
// everywhere at once. Behind one carrier gateway, 120/hr refused the 121st person
// doing exactly what they had just been told to do — on the one endpoint whose
// failure mode is "you cannot sign out of the phone you lost".
//
// So it moves to 60/min + 240/hr, by the WRITE family's rule and not the read
// family's: 12× the per-user ceiling inside the use-case (5/min + 20/hr), so the
// USER bucket stays the binding constraint. It is still an order of magnitude
// below the authenticated-read family, because the act really is rare — which is
// the half of the original argument that survives, and the reason this route has
// a family of its own instead of joining one.

/** The bare write payload. `revoked` is the client's signal to drop its token. */
type RevokeSessionsV1 = { revoked: true };

// AUTHORIZED, not opted out: this handler calls requireLiveUser in its own body
// and that call IS the authorization. Said without writing the opt-out marker,
// because a comment that spells the marker in order to deny it still reads as
// one to a scanner that matches the token (see /api/v1/me for the measurement).
export async function POST(request: Request) {
  // Free: a regex over one header, before any counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do (check-api-guard-headers).
  try {
    await enforceRateLimit(
      "api_v1_me_revoke_sessions_ip",
      callerIp(request.headers),
      API_V1_ACCOUNT_SECURITY_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, matching every other limiter on this surface. The limiter is
    // itself a DB write; if it cannot answer, refusing here would deny a user
    // the ability to sign out of a device they believe is compromised, over an
    // abuse control. The guard below is the authorization boundary and IT fails
    // closed — that is the one that must.
    console.error("[api-v1-me-revoke-sessions] IP rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-revoke-sessions",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    throw err;
  }

  if (!live.ok) {
    switch (live.reason) {
      case "NO_SESSION":
        return apiV1Error("auth_expired", 401);
      case "ACCOUNT_ERASED":
        return apiV1Error("account_erased", 403);
      case "DEACTIVATED":
        return apiV1Error("account_deactivated", 403);
      case "SHIFT_EXPIRED":
        return apiV1Error("session_shift_expired", 401);
      case "MAINTENANCE":
        return apiV1Error("temporarily_unavailable", 503, {
          "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
        });
      default: {
        const unhandled: never = live.reason;
        throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // THE PUSH TARGETS GO FIRST, AND THE ORDER IS THE WHOLE POINT OF THIS BLOCK.
  //
  // "Cerrar sesión en todos los dispositivos" is what somebody does about a
  // phone they no longer hold. Killing the SESSIONS stops that phone from
  // reading anything; it does nothing whatsoever about `push_targets`, which is
  // a separate delivery address the send path reads server-side with no session
  // involved. Before this call the stolen phone kept receiving every urgent
  // notification on its lock screen — genericised since the lock-screen
  // allowlist landed, but still a doorbell ringing in somebody else's pocket,
  // announcing that this person has an animal in trouble.
  //
  // BEFORE and not after, because the two must not be allowed to half-happen in
  // the direction that matters. If this write fails we answer 503 with every
  // session still ALIVE: the person retries, and nothing about their situation
  // has silently changed. The reverse order would leave them signed out
  // everywhere, told it worked, and still delivering to the device they were
  // trying to cut off — which is precisely the state this endpoint exists to
  // get them out of.
  //
  // NOT WRAPPED IN A DB BUDGET, for the reason `/me/push-targets` records: the
  // budget races a promise against a timer and rejects without aborting the
  // statement, so a timeout would answer "this did not happen" over a write that
  // then commits.
  try {
    await revokeAllPushTargetsForUser(live.user.id);
  } catch (err) {
    reportError("api-v1-me-revoke-sessions/push-targets", err, { userId: live.user.id });
    return apiV1Error("temporarily_unavailable", 503, {
      "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }

  // `client.token` and not a token re-read from anywhere else: it is the exact
  // credential requireLiveUser just had GoTrue validate, so the revocation
  // authorizes with a token we know is live and belongs to `live.user`. The
  // per-user budget is spent INSIDE this call, shared with the web button.
  const result = await revokeAllSessions({
    accessToken: client.token,
    userId: live.user.id,
    surface: "api_v1",
  });

  if (!result.ok) {
    // A throttle is not an outage, and answering 503 to one would tell a client
    // the platform is broken while it works exactly as designed.
    if (result.reason === "rate_limited") return apiV1Error("rate_limited", 429);
    // FAILS CLOSED, unlike the limiters. A revocation that did not happen must
    // never answer 200: the user's next move — stop worrying about the phone
    // they lost — depends on believing this response.
    return apiV1Error("temporarily_unavailable", 503, {
      "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }

  const payload: RevokeSessionsV1 = { revoked: true };
  return apiV1Json(payload, { status: 200 });
}
