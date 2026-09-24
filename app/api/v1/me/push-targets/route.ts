// `/api/v1/me/push-targets` — where a phone says "deliver here" and "stop".
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A DEVICE PATH
// ---------------------------------------------------------------------------
// For the reason `/me/notifications` does: the thing being registered belongs to
// a PERSON, and the device is a detail of how they are reached. A URL naming the
// device would also put an install identifier in a path that appears in access
// logs and in any proxy in between, which is a place personal data has no reason
// to be when the body can carry it under TLS.
//
// POST ONLY, TWO COMMANDS, AND NO DELETE METHOD
// ---------------------------------------------------------------------------
// `register` and `revoke`, discriminated in the body. There is no DELETE verb
// here and that is not laziness: `push_targets` carries no DELETE policy at all
// (migration 0222) because revocation is SOFT — the row keeps an auditable trail
// until the nightly purge or an art. 16 erasure removes it. A DELETE verb would
// name an operation the database refuses, and a client reading the method list
// would believe it holds a promise nobody made.
//
// NO `Idempotency-Key`, AND THE ENDPOINT ASKS FOR NONE. Both commands are
// idempotent on the STATE: `register` upserts on `device_id`, `revoke` sets a
// timestamp that may already be set. This matches `/me/notifications`, whose
// commands carry none for the same reason, and not `/pets/{token}/events`, which
// requires one because it appends to an immutable log. See `@dim/contract/input`'s
// `push-registration.ts`.
//
// THE RATE-LIMIT FAMILY IS THE AUTHENTICATED-WRITE ONE, BORROWED DELIBERATELY.
// This is a write, and that family is named for exactly that. Its ceilings
// (10/min, 40/hr, 100/day per user) were derived from what it costs to hand
// over an animal, which is far more than one upsert on the caller's own row —
// so the family is CONSERVATIVE here, never loose, and borrowing in that
// direction is the safe one. A family of its own would be two more numbers to
// keep in agreement with nothing forcing them to, for an act whose real rate is
// a handful a day: sign-in, a token rotation, a sign-out.
//
// The bucket NAMES stay literals in this file, as `check-api-v1-envelope`
// requires and for the reason the notifications route records: a shared counter
// would make "which surface is being hammered" unanswerable from the limiter's
// own storage.

import { pushRegistrationInputSchema } from "@dim/contract/input";

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { registerPushTarget, revokePushTarget } from "@/lib/infra/push-target-store";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * The ack, declared locally like `/me/revoke-sessions`'s rather than in the
 * contract package.
 *
 * `registered` and `revoked` are the two facts a client can act on, and neither
 * echoes the token back. A response that repeated the credential the request
 * carried would put it in one more place — a log, a devtools panel, a crash
 * report — for no reader.
 *
 * `revoked: false` is a legitimate answer, not an error: revoking a device that
 * was already revoked, or never registered, changed nothing and the client has
 * nothing to do about it. Answering 404 there would make a sign-out look failed.
 */
type PushTargetAckV1 = { registered: true } | { revoked: boolean };

/** The 503 this endpoint answers for a degraded write. */
function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard — and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner matching
// the token.
export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_push_targets_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-api-v1-envelope`
  // reads the handler body ONLY and does not follow calls, so a guard factored
  // into a module-level function reads as ABSENT — and that is the right rule
  // rather than a limitation: a reader auditing who may reach this URL should
  // find the answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-push-targets-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_push_targets_user",
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
  // locally. This is the backstop for a client out of step with the contract,
  // which is why it carries no field detail — the envelope is one key.
  const parsed = pushRegistrationInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  // THE WRITES ARE DELIBERATELY OUTSIDE ANY DB BUDGET, for the reason
  // `notifications/commands.ts` records: `withDbBudgetOrThrow` races a promise
  // against a timer and rejects, which does not abort a Postgres statement.
  // Wrapping a write would answer 503 for a mutation that then COMMITS, and a
  // client told its registration failed would retry into a row that already
  // holds the token.
  try {
    if (parsed.data.command === "register") {
      await registerPushTarget({
        userId: live.user.id,
        deviceId: parsed.data.deviceId,
        expoPushToken: parsed.data.expoPushToken,
        platform: parsed.data.platform,
        appVersion: parsed.data.appVersion ?? null,
      });
      const payload: PushTargetAckV1 = { registered: true };
      return apiV1Json(payload, { status: 200 });
    }

    const revoked = await revokePushTarget(live.user.id, parsed.data.deviceId);
    const payload: PushTargetAckV1 = { revoked: revoked > 0 };
    return apiV1Json(payload, { status: 200 });
  } catch (err) {
    reportError("api-v1-me-push-targets/write", err, { userId: live.user.id });
    return unavailable();
  }
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter in
 * this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing here would stop a person's phone from registering over
 * an abuse control on a row that is only ever their own. The authorization
 * boundary stays intact and fails CLOSED — that is the one that must.
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
    reportError(`api-v1-me-push-targets/${endpoint}`, err);
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
