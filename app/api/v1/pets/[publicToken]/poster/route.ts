// `GET /api/v1/pets/{publicToken}/poster` — the printable lost-pet poster, as
// finished HTML the native app prints to PDF on the device (M13).
//
// WHY HTML AND NOT FIELDS. The poster prints the TITULAR's first name and phone,
// filtered through the disclosure preferences, and a QR to the public
// credential. That resolution is `loadLostPoster`, the SAME function the web's
// `/mis-mascotas/{token}/cartel` page calls — so there is one query that
// decides what a stranger on the street reads, not a web copy and a phone copy.
// The layout is `renderLostPosterHtml`, fenced against the web component by a
// text-parity test. See packages/contract/src/api/pet-poster.ts.
//
// WHO MAY READ IT — the web page's own rule. The cartel page is gated by
// `requirePetAccess`, which is `resolvePetHolderAccess` behind the cookie door;
// this calls the same function behind the bearer door. Any current holder (a
// caretaker included — the poster never prints THEIR contact, see the loader)
// or a member of a holding organization. Anything else is 404, and a pet this
// caller may not read answers exactly like one that does not exist.
//
// NOT LOST IS A 200, NOT AN ERROR. The web answers a non-lost pet with a page
// saying "marcala como perdida primero"; the wire says `available: false` and
// the app says the same sentence. It is a state of the animal, not a refusal
// of the caller.
//
// GET ONLY. Nothing here writes, and printing leaves no trace on the record.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { renderLostPosterHtml } from "@/src/modules/lost/application/lost-poster-html";
import { loadLostPoster } from "@/src/modules/lost/infrastructure/lost-poster-read";
import { PET_POSTER_PAYLOAD_VERSION, type PetPosterV1 } from "@dim/contract/api";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The two access queries — both indexed, both single-row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The poster read: the open episode, one ownership join, one attachment row and
 * a QR rendered in memory. Small and indexed; five seconds is the pet-scoped
 * reads' ordinary ceiling.
 */
const POSTER_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// AUTHORIZED, not opted out: this handler calls requireLiveUser and then
// resolvePetHolderAccess in its own body, and those two calls ARE the
// authorization.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  try {
    await enforceRateLimit(
      "api_v1_pet_poster_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, like every sibling read limiter; the access guard below is the
    // one that fails closed.
    console.error("[api-v1-pet-poster] IP rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-pet-poster-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!live.ok) return liveUserRefusal(live.reason);

  try {
    await enforceRateLimit(
      "api_v1_pet_poster_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    console.error("[api-v1-pet-poster] user rate limiter unavailable, failing open:", err);
  }

  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-pet-poster-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (access.kind === "none") return apiV1Error("not_found", 404);
  const { pet } = access;

  if (pet.status !== "lost") {
    const payload: PetPosterV1 = {
      payloadVersion: PET_POSTER_PAYLOAD_VERSION,
      publicToken: pet.publicToken,
      available: false,
      petName: pet.name,
    };
    return apiV1Json(payload, { status: 200 });
  }

  let data: Awaited<ReturnType<typeof loadLostPoster>>;
  try {
    data = await withDbBudgetOrThrow(
      loadLostPoster(pet, pet.publicToken),
      POSTER_BUDGET_MS,
      "api-v1-pet-poster-load",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  const payload: PetPosterV1 = {
    payloadVersion: PET_POSTER_PAYLOAD_VERSION,
    publicToken: pet.publicToken,
    available: true,
    petName: pet.name,
    hasPhoto: data.photoUrl !== null,
    html: renderLostPosterHtml(data),
  };
  return apiV1Json(payload, { status: 200 });
}

/** The 503 this endpoint answers for every degraded read, with its backoff. */
function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/** The liveness guard's refusals — the same statuses and codes as every sibling. */
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
