// `GET /api/v1/me/cases` — the owner's CASOS: every open cycle, plus the most
// recent closed ones.
//
// It is the web's `/mis-mascotas` bandeja ("Casos abiertos" + "Historial"),
// read through the same two loaders (`fetchOpenWorkflows`,
// `fetchPreviousWorkflows`) keyed on the verified caller — see `./commands.ts`.
// No `resolvePetHolderAccess` call, by design: the list hangs off the PERSON,
// and half of it is about things that are not a pet the caller holds (a
// denuncia they filed, a tránsito proposal addressed to them). Every loader
// already scopes itself to `userId`, and that id comes from `requireLiveUser`,
// never from the request.
//
// NOT CURSOR-PAGINATED, and deliberately: `open` is the whole open set the web
// renders (each source is bounded inside its own query), and `history` is a
// bounded page of `MY_CASES_HISTORY_LIMIT` rows with a `hasMore` flag — the
// shape the notifications inbox also answers with.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";

import { readCases, unavailable } from "./commands";
import { buildMyCasesV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and every loader it then runs is scoped to that verified user's id.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_cases_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body, not a shared helper: `check-api-v1-envelope` reads the
  // handler body only, and a reader auditing who may reach this URL should find
  // the answer here.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-cases-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_cases_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let cases: Awaited<ReturnType<typeof readCases>>;
  try {
    cases = await readCases(live.user.id);
  } catch (err) {
    // NOT an empty list. "No tenés casos abiertos" over a pooler outage would
    // hide an open bite observation from the person it binds.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildMyCasesV1({ ...cases, now: new Date() }), { status: 200 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 * FAILS OPEN on limiter infrastructure failure, like every sibling: the
 * authorization boundary is what must fail closed, and it does.
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
    reportError(`api-v1-me-cases/${endpoint}`, err);
    return true;
  }
}

/** The liveness guard's refusals, with the SAME statuses and codes as every sibling. */
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
