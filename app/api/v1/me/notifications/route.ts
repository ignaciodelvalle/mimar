// `/api/v1/me/notifications` — LA BANDEJA, for the person it belongs to.
//
// GET reads one page of the inbox plus the counts a tab bar needs. POST runs one
// of the three things a person can do to it: marcar como leída (una o varias),
// marcar todas, archivar.
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PET
// ---------------------------------------------------------------------------
// For the reason `/me/transfers` does, and more plainly: a notification is
// addressed to a PERSON. Many are about an animal, several are about an animal
// the caller no longer holds (that is what `pet_transfer_accepted` is), and some
// are about no animal at all. There is no token that would name this read.
//
// THE ORDER IS NOT DECIDED HERE
// ---------------------------------------------------------------------------
// The array goes out in the SQL's chronological order and the client sorts it
// through `@dim/contract/notifications` — the same function
// `app/(app)/notificaciones/page.tsx` calls. Sorting server-side would have been
// easier and would have put the rule in a third place; instead there is one rule,
// two front doors, and `__tests__/notification-ordering-parity.test.ts` proving
// the doors agree.
//
// TWO FAMILIES, AND ONE OF THEM IS NEW
// ---------------------------------------------------------------------------
// GET is the authenticated-READ family, like every sibling. POST is NOT the
// authenticated-WRITE family: that family's ceiling is derived from what it costs
// to offer somebody an animal, and a person clearing a backlog of notifications
// would hit its 10/min on the eleventh tap of a screen whose whole purpose is to
// be tapped through. `inbox-state` is its own family for that reason, derived
// from what THIS write costs — one indexed UPDATE on the caller's own rows. The
// numbers and the argument live in `lib/infra/api-v1-limits.ts`; the bucket names
// stay here as literals, because a shared counter would make "which surface is
// being hammered" unanswerable from the limiter's own storage.
//
// NO `Idempotency-Key`, AND THE ENDPOINT ASKS FOR NONE. All three commands are
// idempotent on the STATE — a row already read is not read twice, an archived row
// is not archived twice — and each one says so in its answer through `changed`.
// That is a stronger guarantee than a key buys, not a weaker one, and it is why
// `@dim/contract/input`'s `notification.ts` takes no key: sending a header the
// server would ignore is a client believing it holds a promise nobody made.

import { NOTIFICATION_CATEGORIES_V1, type NotificationCategoryV1 } from "@dim/contract/api";
import { notificationCommandInputSchema } from "@dim/contract/input";

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_INBOX_STATE_IP_LIMIT,
  API_V1_INBOX_STATE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";

import { readInbox, runNotificationCommand, unavailable } from "./commands";
import { buildMyNotificationsV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * The `?cat=` filter, narrowed to the six the contract names.
 *
 * AN UNKNOWN VALUE FALLS BACK TO THE UNFILTERED INBOX rather than answering 400,
 * which is exactly what the web page does with the same parameter
 * (`activeCat` defaults to `all`). A filter is a VIEW, not an assertion, and a
 * client one release behind asking for a tab this build does not know should see
 * their notifications rather than an error.
 */
function categoryParam(url: string): NotificationCategoryV1 | null {
  const raw = new URL(url).searchParams.get("cat");
  if (raw === null) return null;
  return (NOTIFICATION_CATEGORIES_V1 as readonly string[]).includes(raw)
    ? (raw as NotificationCategoryV1)
    : null;
}

// AUTHORIZED, not opted out: both handlers call requireLiveUser in their own
// body and that call IS the authorization. Said here for a reader scanning for
// the guard — and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner matching
// the token.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_notifications_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper the two methods share.
  // `check-api-v1-envelope` reads the handler body ONLY and does not follow
  // calls, so a guard factored into a module-level function reads as ABSENT —
  // and that is the right rule rather than a limitation: a reader auditing who
  // may reach this URL should find the answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-notifications-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_notifications_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let inbox: Awaited<ReturnType<typeof readInbox>>;
  try {
    inbox = await readInbox({ userId: live.user.id, category: categoryParam(request.url) });
  } catch (err) {
    // NOT an empty inbox. A read that failed and a person with nothing waiting
    // are different facts, and a client that rendered "tu bandeja está vacía"
    // over a pooler outage would tell somebody nobody had reported seeing their
    // lost dog.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(
    buildMyNotificationsV1({
      rows: inbox.rows,
      countsByCategory: inbox.countsByCategory,
      unreadCount: inbox.unreadCount,
      total: inbox.total,
    }),
    { status: 200 },
  );
}

export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_notifications_write_ip",
      callerIp(request.headers),
      API_V1_INBOX_STATE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body for the same reason the read's copy is — see the note
  // there. Two calls, not one shared helper, because the fence that keeps this
  // URL honest cannot see through a function.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-notifications-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_notifications_write_user",
      live.user.id,
      API_V1_INBOX_STATE_USER_LIMIT,
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
  const parsed = notificationCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runNotificationCommand({ userId: live.user.id, input: parsed.data });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter in
 * this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing here would empty a person's inbox over an abuse control
 * on rows that are only ever their own. The authorization boundary stays intact
 * and fails CLOSED — that is the one that must.
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
    reportError(`api-v1-me-notifications/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * DEACTIVATED IS REFUSED HERE while the WEB lets a deactivated account keep
 * READING /notificaciones (see `app/actions/notifications.ts`'s header). The
 * difference is not a divergence: `requireLiveUser`'s write policy is what the
 * web applies to the three ACTIONS, and this endpoint's GET and POST share one
 * guard because a native client needs a single answer for "can I use this
 * account". Refusing the read costs a deactivated operator a list they cannot act
 * on; admitting it would need a second, softer guard whose only user is one
 * method of one route.
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
