// `/api/v1/me/transfers` — TRANSFERENCIAS, for the person on either side of one.
//
// GET reads the hub: what is coming to me, what I sent, and what already
// resolved. POST runs one of the four commands: ofrecer la titularidad,
// aceptarla, rechazarla, retirar la propuesta.
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PET
// ---------------------------------------------------------------------------
// Every other authenticated read on this surface names one animal in its path.
// This one cannot, and the reason is the feature itself: half of what it lists
// is about animals the caller does not own. A proposal is precisely an offer
// from somebody else's pet, and the person who accepts it holds no `ownerships`
// row for it at the moment they do.
//
// The consequence for THIS FILE is that there is no `resolvePetHolderAccess`
// call in it, and its absence is the design rather than an omission. See
// `./commands.ts`, which states the three different authorization rules the four
// commands actually run and why collapsing them into a pet guard would refuse
// the one caller each command exists for.
//
// `callerEmail` IS RESOLVED HERE, FROM THE VERIFIED SESSION
// ---------------------------------------------------------------------------
// It is a load-bearing input, not a convenience: `validateRecipientMatch` falls
// back to an e-mail comparison when a proposal was addressed to somebody with no
// account yet, so the string that reaches it decides who may take an animal. It
// therefore comes from `requireLiveUser`'s verified user and NEVER from the
// request body or a header. A body that could name it would be a way to claim
// any open invitation whose address you could guess.
//
// It can legitimately be empty — an account without an e-mail on the token — and
// the read degrades correctly rather than guessing: `listTransfersForUser` falls
// back to the id predicate alone, which cannot match an open e-mail invitation
// and therefore hides nothing that caller is entitled to see through it.
//
// AND VERIFIED IS NOT PROVED. `callerEmailConfirmed` travels beside it for the
// reason audit A09-1 found the hard way: GoTrue vouches for the TOKEN, not for
// the address inside it, so "I signed up with bob@example.com" reached the
// e-mail arm of the addressee rule as if it were "I read bob@example.com's
// mail". Both the read and the write now carry the confirmation bit, and an
// unconfirmed address degrades the read exactly as an empty one does — the
// proposal, and its `transferToken`, never leave the database.
//
// `Idempotency-Key` IS NOT READ, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// None of the four use-cases takes a `clientIdempotencyKey`. What they have —
// a partial unique index for `initiate`, `expectedStatus: "pending"` for the
// other three — REFUSES a replay rather than absorbing one, which is not the
// same guarantee and must not be sold as it. `@dim/contract/input`'s
// `transfer.ts` states the consequence a client has to handle.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { transferCommandInputSchema } from "@dim/contract/input";

import { readTransfers, runTransferCommand, unavailable } from "./commands";
import { buildMyTransfersV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// FOUR BUDGETS, TWO FAMILIES, AND WHY THE NUMBERS ARE NOT IN THIS FILE
// ---------------------------------------------------------------------------
// GET is the authenticated-READ family; POST is the authenticated-WRITE family.
// Both sets of ceilings, and the carrier-NAT arithmetic that produced them, live
// in lib/infra/api-v1-limits.ts. They moved out of this file on 2026-08-26
// (WU-EAS-2) because four literals with four paragraphs, each saying "the same
// numbers every sibling takes", is a promise about SIBLINGS that only a reader
// with all the siblings open can check.
//
// The BUCKET NAMES stay here, as literals, and that separation is deliberate: a
// shared ceiling is a decision about load, and a shared counter would make
// "which surface is being hammered" unanswerable from the limiter's own storage.
// Same numbers, four buckets.
//
// WHAT THE WRITE CEILING IS SIZED AGAINST, kept because it is about this feature
// rather than about carrier NAT: 10/min per user is tighter than compartir's
// 15/60/200 on purpose. Minting share links is something an owner legitimately
// does in bursts while deciding what to expose; offering an animal to somebody is
// not. Ten a minute is generous headroom for a person answering a backlog of
// proposals plus every retry a flaky connection produces, and the daily figure is
// the abuse backstop: an account initiating a hundred transfers in a day is doing
// something no owner does, and each one sends mail to an address it names. What
// this write PRODUCES is not a row — it is a change of who owns an animal in the
// national registry.

// AUTHORIZED, not opted out: both handlers call requireLiveUser, and for the
// write the per-command authorization then runs inside the use-cases — which is
// where it has to be, because three of the four commands are sent by somebody
// who holds no ownership row over the animal in question. Said here for a reader
// scanning for the guard, and said WITHOUT writing the opt-out marker, because a
// comment that spells the marker in order to deny it still reads as one to a
// scanner matching the token.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_transfers_read_ip",
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
      "api-v1-me-transfers-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_transfers_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let transfers: Awaited<ReturnType<typeof readTransfers>>;
  try {
    transfers = await readTransfers({
      userId: live.user.id,
      callerEmail: live.user.email ?? "",
      callerEmailConfirmed: live.user.emailConfirmed,
    });
  } catch (err) {
    // NOT an empty hub. A read that failed and a person with no transfers are
    // different facts, and a client that rendered "no tenés transferencias
    // pendientes" over a pooler outage would hide a seven-day window that then
    // closes by itself.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildMyTransfersV1({ transfers, now: new Date() }), { status: 200 });
}

export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_transfers_write_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
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
      "api-v1-me-transfers-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_transfers_write_user",
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
  const parsed = transferCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runTransferCommand({
    userId: live.user.id,
    // From the VERIFIED session. The body cannot name it; see the header.
    callerEmail: live.user.email ?? "",
    // Verified is not the same claim as PROVED — see the header's second note.
    callerEmailConfirmed: live.user.emailConfirmed,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop somebody REJECTING or CANCELLING a proposal
 * they no longer want — and on this surface those are the two operations that
 * must never be blocked by an abuse control, because the alternative is a
 * seven-day window running out while the answer is refused. The authorization
 * boundary stays intact and fails CLOSED.
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
    reportError(`api-v1-me-transfers/${endpoint}`, err);
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
