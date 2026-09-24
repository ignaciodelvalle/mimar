// `/api/v1/me/adoption-applications` — MIS POSTULACIONES.
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PET
// ---------------------------------------------------------------------------
// For `/me/transfers`'s reason and `/me/notifications`'s: what it returns is
// about animals the caller does NOT hold. A postulación is a thing a PERSON did,
// to somebody else's animal, and there is no token that would name the read.
//
// D17 IS ENFORCED BY WHAT IS ABSENT
// ---------------------------------------------------------------------------
// The applicant sees THEIR OWN rows and nothing about the competition — no
// count of other applications for the same pet, no names, no queue position.
// The web page states the rule; `@dim/contract/api`'s `adoption.ts` keeps it as
// a shape with no field to put any of that in, and the payload builder's test
// asserts the key set.
//
// ART. 16 TRAVELS WITH THE QUERY, NOT WITH THIS FILE. `readMyAdoptionApplications`
// carries `p.deleted_at IS NULL`, and it has to: the applicant's own submission
// row and the shelter's custody row both SURVIVE a rehome-R4 titular's erasure,
// so without it an erased pet's name would still render to a third party. That
// is the same guard the org-side queue carries and it is the class of leak this
// repo has now closed on four other surfaces.
//
// NO WITHDRAW COMMAND HERE, AND IT IS A GAP RATHER THAN A DECISION. The web has
// `WithdrawApplicationButton` over `withdrawAdoptionApplicationAction`; the
// phone can read its applications and cannot retract one. It is reported on the
// board. What it needs is a POST on this path and a second family entry, and
// what stopped it was scope rather than difficulty.

import {
  MY_ADOPTION_APPLICATIONS_PAYLOAD_VERSION,
  MY_ADOPTION_APPLICATIONS_STALE_AFTER_MS,
  type MyAdoptionApplicationsV1,
} from "@dim/contract/api";

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
import { buildMyAdoptionApplication } from "@/src/modules/adoption/application/adoption-payloads";
import {
  MY_APPLICATIONS_LIMIT,
  readMyAdoptionApplications,
} from "@/src/modules/adoption/infrastructure/my-applications-read";

export const dynamic = "force-dynamic";

const AUTH_BUDGET_MS = 5_000;

/**
 * Four CTEs, three LATERALs and a seven-branch CASE over the spine, capped at
 * 100 rows. Wider than the auth budget because it is the work the request came
 * for; bounded because `force-dynamic` means every call runs it.
 */
const APPLICATIONS_BUDGET_MS = 8_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard — and said WITHOUT writing the opt-out marker.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // ITS OWN BUCKET, not the browse surface's. `api_v1_adoptions_read_ip` bounds
  // reading a public catalogue; this reads the caller's own record of what they
  // asked for. Sharing a counter between them would let a scraper of the
  // catalogue spend the budget of somebody checking whether a shelter answered.
  if (
    !(await spendBudget(
      "api_v1_me_adoption_applications_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body, not through a shared helper: `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, and that is the right
  // rule rather than a limitation — a reader auditing who may reach this URL
  // should find the answer here.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-adoption-applications-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_adoption_applications_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let rows: Awaited<ReturnType<typeof readMyAdoptionApplications>>;
  try {
    rows = await withDbBudgetOrThrow(
      readMyAdoptionApplications(live.user.id),
      APPLICATIONS_BUDGET_MS,
      "api-v1-me-adoption-applications",
    );
  } catch (err) {
    // NOT AN EMPTY LIST. "Todavía no te postulaste" over a pooler outage would
    // tell somebody waiting on a shelter's answer that they never asked — the
    // same lie `/me/notifications` refuses to tell about an empty inbox.
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }

  const payload: MyAdoptionApplicationsV1 = {
    ...apiV1Envelope({
      payloadVersion: MY_ADOPTION_APPLICATIONS_PAYLOAD_VERSION,
      staleAfterMs: MY_ADOPTION_APPLICATIONS_STALE_AFTER_MS,
    }),
    applications: rows.map(buildMyAdoptionApplication),
    // The cap is the web page's own and it is REPORTED rather than hidden: a
    // client that renders 100 rows as "todas tus postulaciones" is stating
    // something the server did not check. Rows whose animal has no current
    // custodian are dropped after the cap, so `truncated` is derived from what
    // the QUERY returned rather than from the array's length here — which is
    // why the reader exports the constant instead of this file restating it.
    truncated: rows.length >= MY_APPLICATIONS_LIMIT,
  };
  return apiV1Json(payload, { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo: the limiter is itself a DB write, and refusing here would hide a
 * person's own applications from them over an abuse control on rows that are
 * only ever theirs. The authorization boundary stays intact and fails CLOSED.
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
    reportError(`api-v1-me-adoption-applications/${endpoint}`, err);
    return true;
  }
}

/** The liveness refusals, mapped as every sibling on this surface maps them. */
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
