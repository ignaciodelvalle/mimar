// GET /api/v1/me/pets — the first AUTHENTICATED READ on `/api/v1`.
//
// `/me` proved a bearer token resolves to a person. This proves it resolves to
// that person's DATA, and it is deliberately the smallest possible instance of
// that: a list of the caller's own pets, projected down to what a row on a list
// screen draws.
//
// ONE DOOR, TWO RENDERERS
// ---------------------------------------------------------------------------
// The query is NOT here. `listOwnerPets`
// (src/modules/pets/application/read/list-owner-pets.ts) is the same function
// `app/(app)/mis-mascotas/page.tsx` calls, and it moved out of that page in this
// change for exactly this reason. "Which pets are yours" is one decision — an
// OPEN `ownerships` row of any role, so a foster's tránsito pet is in the list
// and a completed transfer takes a pet out of the previous holder's — and a
// route handler with its own copy of that predicate is how the native list
// eventually shows a pet the web list does not. Same reasoning as
// `lookupPublicCredential`, same shape.
//
// THE SAME GUARD AS `/me`, AND THE SAME REFUSALS
// ---------------------------------------------------------------------------
// `createClientFromBearer` → `requireLiveUser({ supabase })`, no cookie
// fallback, no redirects. Every refusal is a status plus a code
// (401 `auth_required` / `auth_expired`, 403 `account_erased` /
// `account_deactivated`, 503 `temporarily_unavailable`), mapped identically to
// its sibling — a native client writes ONE handler for the auth failure space
// and it works against every endpoint on this surface.
//
// The DEACTIVATED refusal follows `/me` rather than libreta-export's tolerant
// posture, for the same reason: this endpoint bootstraps a SHELL, and a client
// handed `account_deactivated` renders the explanation screen from the code
// itself. That is strictly clearer than an empty list, which is what a tolerant
// read would look like and is indistinguishable from "you have no pets".
//
// WHAT THE PAYLOAD DOES NOT CARRY
// ---------------------------------------------------------------------------
// No internal ids, no microchip numbers, no compliance state, no owner PII. The
// full list and the reason for each omission live on `MyPetsV1Item` in the
// contract package — where a client reads them — rather than here. The one worth
// repeating: NO half-derived compliance chip. The web index computes one from a
// separate bounded fan-out that is allowed to fail softly, and a JSON field that
// is present when that fan-out worked and absent when it did not is the exact
// "a blank section reads as no findings" defect RN-8 #6 closed.

import { MY_PETS_PAYLOAD_VERSION, MY_PETS_STALE_AFTER_MS, type MyPetsV1 } from "@dim/contract/api";

import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { petPhotoUrl } from "@/lib/infra/storage";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { listOwnerPets } from "@/src/modules/pets/application/read/list-owner-pets";

export const dynamic = "force-dynamic";

/** One `auth.getUser()` round-trip plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * The list itself: two indexed queries (rows + matching count) over an owner's
 * `ownerships`, capped at 200 rows. Longer than the auth budget because a rescue
 * network's 200-row page is a real workload, short enough that a degraded pooler
 * produces a 503 rather than a spinner.
 */
const LIST_BUDGET_MS = 6_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// THE AUTHENTICATED-READ FAMILY — and the follow-up this file named, taken
// ---------------------------------------------------------------------------
// The numbers and the carrier-NAT arithmetic live in lib/infra/api-v1-limits.ts.
// This paragraph is the part that was specific to this file, kept because it is
// the record of a prediction that came true.
//
// The per-IP ceiling here was 60/min + 600/hr and its docblock stated the cost
// of keying on IP plainly — "mobile carriers put hundreds of subscribers behind
// one CGNAT address, so this bucket is shared in a way a per-user bucket would
// not be" — and then named the fix as a tracked follow-up: "re-keying the
// surface buckets is tracked separately (B13) and must move `/me` and this
// endpoint together."
//
// WU-EAS-2 moved them together, and the "together" is the reason the constants
// left this file. A ceiling that must move with a sibling cannot live in a
// literal next to one of the two siblings; keeping it here is what made
// "together" depend on somebody remembering.
//
// What did NOT change: the pairing. The IP bucket runs first, before the GoTrue
// round-trip, because that is what bounds a hammer cheaply. The USER bucket runs
// after the guard, because there is no user id before it — and because an
// unauthenticated hammer must never write into the per-user keyspace.

// AUTHORIZED, not opted out: this handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard — and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner that
// matches the token (`__tests__/check-authz-guards.test.ts` caught /me's).
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
      "api_v1_me_pets_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, and the direction is deliberate — the same call `/me` makes.
    // The limiter is itself a DB write; if it cannot answer, refusing here would
    // empty every user's pet list over an abuse control on a read that discloses
    // only the caller's own animals. The guard below is the authorization
    // boundary and it fails CLOSED — that is the one that must.
    console.error("[api-v1-me-pets] IP rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-pets-auth",
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
      // See `/api/v1/me` — 401 with its own code so the client re-authenticates
      // instead of refreshing a session that will keep refreshing successfully.
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

  // Per-user budget, spent only once the caller is KNOWN. It cannot run earlier
  // — there is no user id before the guard answers — and running it here means
  // an unauthenticated hammer never writes into the per-user keyspace at all.
  try {
    await enforceRateLimit(
      "api_v1_me_pets_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    console.error("[api-v1-me-pets] user rate limiter unavailable, failing open:", err);
  }

  let list: Awaited<ReturnType<typeof listOwnerPets>>;
  try {
    list = await withDbBudgetOrThrow(
      listOwnerPets({ ownerUserId: live.user.id }),
      LIST_BUDGET_MS,
      "api-v1-me-pets-list",
    );
  } catch (err) {
    // NOT an empty list. A read that failed and a person with no pets are
    // different facts, and a client that renders "todavía no registraste
    // ninguna mascota" over a pooler outage tells an owner their animals are
    // gone. 503, same as every other degraded read on this surface.
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    throw err;
  }

  const payload: MyPetsV1 = {
    ...apiV1Envelope({
      payloadVersion: MY_PETS_PAYLOAD_VERSION,
      staleAfterMs: MY_PETS_STALE_AFTER_MS,
    }),
    pets: list.rows.map(({ pet, photo }) => ({
      publicToken: pet.publicToken,
      name: pet.name,
      species: pet.species,
      status: pet.status,
      // Resolved to a URL here rather than handed out as a storage path: the
      // client wants something it can put in an <Image>, and it should not have
      // to know the bucket layout to build one.
      photoUrl: petPhotoUrl(photo?.storagePath),
    })),
    total: list.total,
    // Derived, not assumed: a client must not have to know the server's cap to
    // tell a complete list from a capped one.
    truncated: list.rows.length < list.total,
  };

  return apiV1Json(payload, { status: 200 });
}
