// `/api/v1/pets/{publicToken}/reminders` — the vaccine reminder pair.
//
// POST ONLY, AND THE MISSING GET IS A DECISION, the same one `pet-move.ts`
// records for its own door: a client already has the list, on
// `GET /api/v1/pets/{publicToken}` (`OwnerPetRemindersSection`). A second read
// here would be a route, a per-IP bucket and a payload version bought to
// re-send a list the client is already holding.
//
// TWO COMMANDS BEHIND ONE URL, the shape `/shares` and `/move` already use:
// `create_vaccine_reminder` schedules one, `cancel_vaccine_reminder` cancels
// one, and `./commands.ts` is where "may this command run, and what exactly
// does it do" is answered.
//
// THE WRITE FAMILY IS GENERIC `authenticated-write`, not `pet-disclosure-write`
// or `pet-record-write`: scheduling or cancelling a personal reminder publishes
// nothing new to anybody else, and a reminder is not a row on the append-only
// spine. What this is, exactly, is one person in a form acting on their own
// record — `move`'s own anchor for the identical reason.

import { apiV1Error } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { vaccineReminderCommandInputSchema } from "@dim/contract/input";

import { runVaccineReminderCommand, unavailable } from "./commands";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser and then
// resolves pet access, and those two calls ARE the authorization. Said here
// for a reader scanning for the guard — and said WITHOUT writing the opt-out
// marker, because a comment that spells the marker in order to deny it still
// reads as one to a scanner matching the token.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_reminders_write_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, so a guard factored
  // into a module-level function reads as ABSENT.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-reminders-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_reminders_write_user",
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

  // The client validated against this schema first and got per-field codes
  // locally. This is the backstop for a client out of step with the contract.
  const parsed = vaccineReminderCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runVaccineReminderCommand({
    publicToken,
    userId: live.user.id,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface, while the AUTHORIZATION boundary stays intact and fails
 * CLOSED.
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
    reportError(`api-v1-reminders/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
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
