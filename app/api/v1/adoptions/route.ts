// `/api/v1/adoptions` — EL CATÁLOGO, one page of it.
//
// IT REQUIRES A BEARER AND THE WEB'S `/adoptar` DOES NOT
// ---------------------------------------------------------------------------
// That is a deliberate narrowing and it is the one decision on this route worth
// arguing, because parity is this initiative's whole premise and this is less
// than the web offers. Three things, in order of weight:
//
//   1. THE APP HAS NO ANONYMOUS SHELL. Every screen in `apps/mobile/app`
//      resolves through `useGate`, which has five answers and no sixth for
//      "browsing without an account". A public catalogue endpoint would answer
//      a screen this app cannot draw.
//   2. THE FUNNEL ENDS AT A SESSION ANYWAY. `/adoptar/{token}/postular`
//      redirects an anonymous visitor to `/iniciar-sesion` before it renders a
//      field, so the browse-then-apply path on the web crosses the same line
//      one screen later.
//   3. AN ANONYMOUS `/api/v1` READ IS A DIFFERENT DERIVATION, not a smaller
//      one. `credential/limits.ts` sizes the anonymous surface against 1,000
//      SUBSCRIBERS per carrier address; `api-v1-limits.ts` sizes this one
//      against ~100 app-holding CLIENTS. Making this route public would move it
//      into the first family and out of the second, which is a rate-limit
//      decision, not a routing one.
//
// WHAT IT COSTS, STATED RATHER THAN HIDDEN: a person who has not signed up
// cannot browse animals in the app. The web page is still there and still
// public, and this is reported on the board as a parity gap rather than left as
// an implementation detail somebody discovers.
//
// THE QUERY IS THE WEB'S QUERY, UNCHANGED. `queryAdoptionListing` is what
// `/adoptar` calls — the same nine listability conditions, the same art. 16
// `deleted_at` filter, the same keyset. Nothing here re-derives a predicate the
// catalogue already owns, which is the whole reason this handler is short.

import {
  ADOPTION_CATALOGUE_PAGE_SIZE,
  ADOPTION_CATALOGUE_PAYLOAD_VERSION,
  ADOPTION_CATALOGUE_STALE_AFTER_MS,
  type AdoptionCatalogueV1,
} from "@dim/contract/api";

import { parseSearchParams } from "@/lib/infra/adoption-listing";
import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import {
  buildAdoptionCatalogueItem,
  decodeAdoptionCursor,
  encodeAdoptionCursor,
} from "@/src/modules/adoption/application/adoption-payloads";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * The catalogue read itself: a nine-condition join plus a page-sized
 * sponsorship lookup. Wider than the auth budget because it is the work the
 * request came for, and bounded because `force-dynamic` means every call runs
 * it.
 */
const LISTING_BUDGET_MS = 8_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard — and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // ONE READ BUCKET FOR THE WHOLE BROWSE SURFACE — this route and
  // `adoptions/{petToken}` spend the same `api_v1_adoptions_read_ip`, which is
  // NOT what `/me/pets` and `/pets/{token}` do. Those two answer different
  // authorization questions about different sets (your animals; one animal you
  // hold). These two answer one question about one public catalogue, and a
  // person scrolling a list and tapping a card is one act. A second counter
  // would halve the budget of that act for no gain.
  //
  // The family is `authenticated-read` and the ceiling is that family's, which
  // is the point: a client that opens this screen after a cold launch has
  // already spent `/me` and `/me/pets`, and this must not be the endpoint that
  // refuses the fifty-first neighbour behind a carrier gateway.
  if (
    !(await spendBudget(
      "api_v1_adoptions_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper the two routes share.
  // `check-api-v1-envelope` reads the handler body ONLY and does not follow
  // calls, so a guard factored into a module-level function reads as ABSENT —
  // and that is the right rule rather than a limitation: a reader auditing who
  // may reach this URL should find the answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-adoptions-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_adoptions_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // THE WEB'S OWN CODEC OVER THE QUERY STRING. `parseSearchParams` is what
  // `/adoptar` calls, so a filter the browser understands is a filter the phone
  // understands, spelled the same way — and an unknown value falls out of the
  // filters instead of answering 400, which is the same tolerance
  // `/me/notifications`'s `?cat=` has and for the same reason: a filter is a
  // VIEW, not an assertion, and a client one release behind should see animals
  // rather than an error.
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;
  const { filters } = parseSearchParams(params);
  const cursor = decodeAdoptionCursor(url.searchParams.get("cursor"));

  let page: Awaited<ReturnType<typeof queryAdoptionListing>>;
  try {
    page = await withDbBudgetOrThrow(
      queryAdoptionListing(filters, cursor, ADOPTION_CATALOGUE_PAGE_SIZE),
      LISTING_BUDGET_MS,
      "api-v1-adoptions-listing",
    );
  } catch (err) {
    // NOT AN EMPTY CATALOGUE. A read that failed and a country with no animals
    // published are different facts, and "todavía no hay animales en adopción"
    // over a pooler outage is the same lie `/me/notifications` refuses to tell
    // about an empty inbox.
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }

  const payload: AdoptionCatalogueV1 = {
    ...apiV1Envelope({
      payloadVersion: ADOPTION_CATALOGUE_PAYLOAD_VERSION,
      staleAfterMs: ADOPTION_CATALOGUE_STALE_AFTER_MS,
    }),
    items: page.items.map(buildAdoptionCatalogueItem),
    nextCursor: encodeAdoptionCursor(page.nextCursor),
  };
  return apiV1Json(payload, { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo. This is a READ of a catalogue an organization published on
 * purpose; if `rate_limit_buckets` is unavailable, refusing here would hide
 * animals from somebody looking for one over an abuse control. The
 * authorization boundary above stays intact and fails CLOSED — that is the one
 * that must.
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
    reportError(`api-v1-adoptions/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * DEACTIVATED IS REFUSED, like every other `/api/v1` route and unlike the web's
 * `/adoptar`, which is public and therefore has nothing to deactivate. The
 * asymmetry is real and it is the narrowing this file's header argues for: a
 * deactivated account browsing a public catalogue loses nothing it could have
 * acted on, because it cannot apply either.
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
      return apiV1Error("temporarily_unavailable", 503);
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
