// GET /api/v1/me — the FIRST endpoint in this repo to resolve a caller from an
// `Authorization: Bearer` header.
//
// WHAT IT PROVES
// ---------------------------------------------------------------------------
// `lib/supabase/bearer.ts` has existed since 2026-08-19 with zero callers, and
// `requireLiveUser`'s injected-client option (`lib/infra/live-user.ts`) was
// written for exactly this and never exercised. Until now the claim "a bearer
// request and a cookie request are gated by the SAME guard" was a design note.
// This handler is where it becomes a fact, and its tests are the contract.
//
// THE CHAIN, AND WHY EACH LINK IS THE ONE IT IS
// ---------------------------------------------------------------------------
//   createClientFromBearer(header)   — turns the header into a client. NEVER
//     decodes the token, never reads a claim. The ANON key, so the client it
//     builds cannot bypass RLS.
//   requireLiveUser({ supabase })    — the SAME guard the cookie path uses.
//     Answers WHO from `auth.getUser()` (Supabase validates the JWT) and
//     WHETHER THEY MAY STILL ACT from the DATABASE: maintenance kill-switch,
//     erasure (profiles.deleted_at, Ley 25.326 art. 16), institutional
//     deactivation. Authorization stays 100% DB-resolved — zero `auth.jwt()`
//     across 276 RLS policies — so swapping the credential TRANSPORT changes
//     nothing about how authority is resolved. That is the entire point.
//
// STRICTLY THE HEADER. NO COOKIE FALLBACK.
// ---------------------------------------------------------------------------
// `createClientFromBearer` is the only identity source here, and there is no
// `else` that reaches for `createClient()`. A fallback would make this endpoint
// answer 200 to a browser tab that happens to hold a session cookie while the
// bearer header it was given was garbage — a token check that silently isn't
// one. `__tests__/api-v1-me-route.test.ts` pins it by making the cookie
// factory throw if anything touches it.
//
// AND NO REDIRECTS. There is no browser to redirect (ADR 2026-07-18, Decision
// 3), so every refusal is a status plus a code from the shared vocabulary:
//   · no header at all      → 401 `auth_required`  (a client BUG — it forgot
//                             the header; answering `auth_expired` here is how
//                             a refresh loop gets written for a request that
//                             never carried a token)
//   · header unusable, or a token that resolves to nobody
//                           → 401 `auth_expired`   (refresh once, then retry)
//   · erased account        → 403 `account_erased`  — NOT 401: the token is
//                             fine and refreshing it will keep working, so a
//                             401 would produce a refresh loop that succeeds
//                             forever against an account that no longer exists.
//   · deactivated account   → 403 `account_deactivated`
//   · maintenance window    → 503 `temporarily_unavailable`
//
// WHY DEACTIVATED IS REFUSED HERE AND TOLERATED IN libreta-export
// ---------------------------------------------------------------------------
// The repo's written policy after the 2026-07-04 redirect incident is "reads
// stay open so the user can see why; writes stop", and
// `app/api/mis-mascotas/[publicToken]/libreta-export/route.ts` implements it by
// letting a DEACTIVATED caller through. This endpoint diverges deliberately.
// That route serves CONTENT the user needs (an animal's sanitary record); this
// one bootstraps a SHELL, and a native client handed `account_deactivated`
// renders the explanation screen from the code itself — strictly clearer than a
// shell it cannot use anything in. The code IS the "so the user can see why",
// which a plain-text 401 could not carry.
//
// If a later work unit wants the tolerant shape instead, the change is a field
// on `MeV1User` (and a second profile read, since the guard's failure arm
// carries no profile) — not a second endpoint.

import { ME_PAYLOAD_VERSION, ME_STALE_AFTER_MS, type MeV1 } from "@dim/contract/api";

import { toMeV1User } from "@/lib/domain/identity-completeness";
import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { createClientFromBearer } from "@/lib/supabase/bearer";

export const dynamic = "force-dynamic";

/** One `auth.getUser()` round-trip to GoTrue plus one memoized profile read. */
const ME_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// TWO BUCKETS SINCE 2026-08-26 (WU-EAS-2), WHERE THERE USED TO BE ONE
// ---------------------------------------------------------------------------
// This endpoint is the authenticated-read family; the numbers and the carrier-NAT
// arithmetic behind them live in lib/infra/api-v1-limits.ts and are not repeated
// here. What belongs here is why THIS route needed both, which is a different
// question from what the ceilings should be.
//
// The per-IP bucket used to be the only one, and its comment said the ceiling
// "exists to bound a hammer, not to shape usage". That was true of the intent
// and false of the effect: at 60/min behind a carrier gateway shared by hundreds
// of subscribers, it shaped usage for everybody and bounded a hammer for nobody
// — the endpoint every native client calls FIRST, on every cold launch, was the
// tightest thing in the client's whole startup path.
//
// So the IP ceiling moves up and a per-USER bucket arrives to do the job the IP
// one was pretending to do. `/me/pets` has had exactly this pair since it landed
// and its docblock named the follow-up by name: "re-keying the surface buckets
// is tracked separately (B13) and must move `/me` and this endpoint together."
// This is the together half.
//
// ORDER, and it is not arbitrary. IP first, before the GoTrue round-trip, so an
// unauthenticated hammer is refused cheaply. USER second, after the guard —
// it cannot run earlier, because there is no user id until the guard answers,
// and running it there means an unauthenticated hammer never writes into the
// per-user keyspace at all.

// AUTHORIZED, not opted out: this handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard — and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner that
// matches the token (measured: this file entered the opted-out list on its
// first run, and `__tests__/check-authz-guards.test.ts` caught it).
export async function GET(request: Request) {
  // Free: a regex over one header. Doing it before the limiter means a client
  // that forgot the header costs the platform no counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do (check-api-guard-headers).
  try {
    await enforceRateLimit(
      "api_v1_me",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, and the direction is deliberate. The limiter is itself a DB
    // write; if it cannot answer, refusing here would log every user out of
    // their app shell over an abuse control on a read that discloses only the
    // caller's own profile. The guard below is the authorization boundary and
    // it fails CLOSED — that is the one that must.
    console.error("[api-v1-me] rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      ME_BUDGET_MS,
      "api-v1-me",
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
      // 401, not 403: unlike the two account-state refusals this one IS fixed by
      // authenticating again, so it belongs with the credential failures. The
      // distinct code is what stops the client refreshing instead — see
      // `session_shift_expired` in @dim/contract/api.
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

  // Per-user budget, spent only once the caller is KNOWN — the bucket that
  // actually bounds a person, and the one carrier NAT cannot dilute because
  // identities are not shared. Same placement and same numbers as `/me/pets`.
  try {
    await enforceRateLimit("api_v1_me_user", live.user.id, API_V1_AUTHENTICATED_READ_USER_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, the same direction as the IP bucket above and for the same
    // reason: the limiter is a DB write, and it must not be the thing that
    // empties a user's app shell. The guard that already ran is the
    // authorization boundary and IT fails closed.
    console.error("[api-v1-me] user rate limiter unavailable, failing open:", err);
  }

  const envelope = apiV1Envelope({
    payloadVersion: ME_PAYLOAD_VERSION,
    staleAfterMs: ME_STALE_AFTER_MS,
  });

  // The profile is already resolved by the guard, so the shell costs ONE
  // round-trip and not two.
  //
  // `toMeV1User`, NOT `live.profile ? … : …`. This handler used to test ROW
  // EXISTENCE, and the row always exists: `handle_new_user` (db/triggers.sql)
  // inserts a `profiles` row in the same transaction as the `auth.users` row,
  // with a display name derived from the email local part. So a native account
  // that had completed step 1 and nothing else answered `profilePending: false`
  // here, the gate let it through, and a person who had never given a name
  // could register pets under it (native QA batch 1, D1). The shared projection
  // asks the question the gate actually needs answered — is this identity
  // COMPLETE — using the same predicate the web's own gates use
  // (`app/(app)/layout.tsx`, `app/(auth)/registro/page.tsx`).
  const payload: MeV1 = {
    ...envelope,
    user: toMeV1User({
      id: live.user.id,
      email: live.user.email,
      profile: live.profile,
    }),
  };

  // Nothing beyond the four shell fields. No email (the guard exposes one for a
  // web nav-avatar fallback that never leaves the server render; putting it on
  // a wire a device caches to disk is a different decision), no DNI in any
  // form, no phone, no jurisdiction, no pets. See MeV1 for the full list of
  // what is deliberately absent and why — that list is the whole defence for
  // the payload a stolen access token buys.
  return apiV1Json(payload, { status: 200 });
}
