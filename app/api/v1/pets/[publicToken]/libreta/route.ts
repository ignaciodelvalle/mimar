// `GET /api/v1/pets/{publicToken}/libreta` — the pet's LIBRETA, over bearer auth.
//
// THE THIRD FACE, AND THE ONE THE PRODUCT IS NAMED AFTER. The web profile is a
// card with two faces — DocumentChrome literally bands them "Credencial ·
// frente" and "Libreta · dorso" — inside an owner's chrome. This surface serves
// the back: the consolidated ledger of asientos, what is coming due, and the
// vaccination summary. `/pets/{token}` is the chrome, `/pets/{token}/credential`
// is the front, and none of the three is a superset of the others.
//
// WHO MAY READ IT — the resolved rule
// ---------------------------------------------------------------------------
// The SAME function the owner face and the web page use, for the same reason:
// `resolvePetHolderAccess`, which `requirePetAccess` (the cookie door) also
// calls. Two copies of that query is how a native client quietly ends up with a
// wider or narrower reach than the web. In words:
//
//   · OWNER PATH — an ACTIVE `ownerships` row on this pet in ANY holder role:
//     owner, co_owner, foster or caretaker. Not titular-only.
//   · ORG PATH — an ACTIVE member of an organization that itself holds an
//     active ownership row on the pet, in any role.
//   · Anything else is 404, deliberately: a permission denial and a nonexistent
//     pet answer identically.
//
// AND THE ORG PATH SEES LESS, which is the part a reader should not have to
// discover from the payload. The web's libreta face runs every past event
// through `pastEventMatchesAudience`: an owner sees the whole timeline, an
// org/vet viewer sees only the libreta-sanitaria whitelist. That filter runs in
// `payload.ts` on THIS side, so an org viewer's device never receives the rows
// it may not read — the web filters in a client component, which is the right
// shape for a browser and the wrong one for a payload a phone stores.
//
// AMENDMENTS ARE FOLDED, NOT FLATTENED. The reader overlays every correction so
// each asiento carries its CORRECTED values, and `amendedAt` says a correction
// happened. The `event_amended` row stays in the timeline as its own entry,
// because a correction is an event and this ledger is append-only. Nothing here
// renders an original as if it were current, and nothing here hides one.
//
// NO SIGNED URL LEAVES THIS HANDLER. The reader is called with
// `signAttachments: false`, so a URL for a file this payload will not carry is
// never minted at all — minting one is equivalent to handing out the file, and
// a 250-row timeline would hand out 250. `hasAttachment` reports the presence;
// `GET /pets/{token}/events/{eventId}` hands over the file, with an expiry.
//
// GET ONLY. The one write this face has (correcting a record) lives on its own
// endpoint under `events/{eventId}/amend`, and this file must not grow it.

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
import { getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";
import { buildPetLibretaV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The two access queries — both indexed, both single-row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The libreta read itself: ten concurrent queries over the pet's spine, its
 * reminders, its turnos and its jurisdiction rules, plus a second stage for
 * attachment presence and signing-organization names.
 *
 * The same eight seconds the owner face allows, and for the same reason: this
 * is genuinely one of the widest reads outside the dashboards, and the page it
 * shares the use-case with wraps it in its own Suspense boundary. Short enough
 * that a degraded pooler produces a 503 a client can retry rather than a
 * spinner it cannot.
 */
const LIBRETA_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// THE AUTHENTICATED-READ FAMILY — numbers in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// This file's own argument for them was "the same numbers as `/pets/{token}` and
// `/me/pets`, and the same numbers ON PURPOSE: a client that opens a pet and then
// flips to its libreta calls both inside the same second, so one figure bounds the
// pair and whoever writes the client has one budget to reason about instead of
// three." Three copies of a figure is how it became two different figures when
// `/me/pets` moved and this did not; the figure is now stated once.
//
// The BUCKET NAME stays this surface's own, which is the half that must not be
// shared: a shared counter makes "which surface is being hammered" unanswerable
// from the limiter's own storage.

// AUTHORIZED, not opted out: this handler calls requireLiveUser and then
// resolvePetHolderAccess in its own body, and those two calls ARE the
// authorization. Said here for a reader scanning for the guard — and said
// WITHOUT writing the opt-out marker, because a comment that spells the marker
// in order to deny it still reads as one to a scanner matching the token.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  // Free: a regex over one header. Doing it before the limiter means a client
  // that forgot the header costs the platform no counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do.
  try {
    await enforceRateLimit(
      "api_v1_pet_libreta_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, deliberately — the same direction every sibling limiter
    // chose. The limiter is itself a DB write; refusing here would blank every
    // owner's libreta over an abuse control on a read that discloses only
    // animals the caller already holds. The access guard below fails CLOSED,
    // and that is the one that must.
    console.error("[api-v1-pet-libreta] IP rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-pet-libreta-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!live.ok) return liveUserRefusal(live.reason);

  // Per-user budget, spent only once the caller is KNOWN. It cannot run earlier
  // — there is no user id before the guard answers — so an unauthenticated
  // hammer never writes into the per-user keyspace at all.
  try {
    await enforceRateLimit(
      "api_v1_pet_libreta_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    console.error("[api-v1-pet-libreta] user rate limiter unavailable, failing open:", err);
  }

  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-pet-libreta-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const accessPath = access.kind === "owner" ? "owner" : "org";

  let read: Awaited<ReturnType<typeof getLibretaFaceData>>;
  try {
    read = await withDbBudgetOrThrow(
      getLibretaFaceData(
        {
          user: { id: live.user.id },
          pet: access.pet,
          accessPath,
          organization: access.kind === "org" ? access.organization : null,
        },
        // See the header: a URL this payload will not carry is never minted.
        { signAttachments: false },
      ),
      LIBRETA_BUDGET_MS,
      "api-v1-pet-libreta-load",
    );
  } catch (err) {
    // NOT an empty ledger. A read that failed and an animal with no asientos
    // are different facts; a client that renders "sin asientos" over a pooler
    // outage tells an owner their animal has no history.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // The use-case's own failure arm is an untyped es-AR string written for a web
  // form (api-invariants.md §3), so it cannot go on a wire. It is a read, so it
  // answers the read's degraded code rather than inventing one.
  if (!read.ok) {
    console.error("[api-v1-pet-libreta] read refused:", read.error);
    return unavailable();
  }

  const payload = buildPetLibretaV1({
    publicToken: access.pet.publicToken,
    petStatus: access.pet.status,
    accessPath,
    holderRole: access.kind === "owner" ? access.holderRole : null,
    data: read.data,
    now: new Date(),
  });

  return apiV1Json(payload, { status: 200 });
}

/** The 503 this endpoint answers for every degraded read, with its backoff. */
function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes the
 * owner face, `/me` and `/me/pets` use.
 *
 * A native client writes ONE handler for the auth failure space and it works
 * against the whole surface — which only stays true if the mapping is written
 * once per endpoint and never improvised per branch. It is a FUNCTION rather
 * than a switch inside `GET` because the handler is at the complexity ceiling
 * the linter enforces, and a refusal table is the part of it that reads better
 * named anyway.
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
      // Exhaustiveness: a new refusal reason without a branch here is a compile
      // error, not a silent fall-through to a 200.
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
