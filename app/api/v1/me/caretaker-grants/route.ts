// `/api/v1/me/caretaker-grants` — CUIDADOR TEMPORAL, for the person on either
// side of an arrangement.
//
// GET reads the hub: the invitations addressed to me, and everything I granted
// that is still open. POST runs one of the five commands the web offers:
// designar un cuidador, aceptar, rechazar, retirar la invitación, finalizar el
// cuidado.
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PET
// ---------------------------------------------------------------------------
// The same reason `me/transfers` does, with one wrinkle of its own. Half of what
// this lists is about animals the caller does not own — an invitation is exactly
// an offer to look after somebody else's pet, and the person who accepts holds no
// `ownerships` row for it at the moment they do. Two of the five commands are
// theirs, and a pet-scoped URL would invite an implementer to guard them with
// `resolvePetHolderAccess`, which would refuse the one caller each exists for.
//
// The other three ARE pet-addressed and carry the pet token in the BODY, where
// `commands.ts` runs the web's own titular guard against it. There is no path
// segment that would be true for all five, and inventing one for three of them
// would split a five-command feature across two URLs.
//
// THE WEB HAS NO SUCH HUB, AND THAT IS NOT A DIVERGENCE. It has two doors: a
// banner on `/mis-mascotas/{token}` for the titular and `/cuidado/{grantToken}`
// for the invitee. Neither survives a phone — the pet payload's caretaker banner
// deliberately carries no grant token, so a native cockpit reading only the pet
// would show "Al cuidado de Ana" beside two controls it has no handle for. Every
// row this returns is one the caller can already see through one of those doors;
// what is new is the arrangement, not the facts. See `@dim/contract/api`'s
// `my-caretaker-grants.ts`.
//
// `callerEmail` IS RESOLVED HERE, FROM THE VERIFIED SESSION
// ---------------------------------------------------------------------------
// It is a load-bearing input, not a convenience: an invitation can be addressed
// to an e-mail with no account behind it, so the string that reaches the accept
// and reject writers decides who may take responsibility for an animal. It comes
// from `requireLiveUser`'s verified user and NEVER from the request body or a
// header. A body that could name it would be a way to claim any open invitation
// whose address you could guess.
//
// It can legitimately be empty — an account with no e-mail on the token — and both
// the read and the writes degrade correctly rather than guessing: the list falls
// back to the id predicate alone, which cannot match an open e-mail invitation
// and therefore hides nothing that caller is entitled to see through it.
//
// AND VERIFIED IS NOT PROVED. `callerEmailConfirmed` travels beside it (audit
// A09-1): GoTrue vouches for the TOKEN, not for the address inside it, so an
// account created with a known invited address reached the e-mail arm as if it
// had read that mailbox. An UNCONFIRMED address now degrades exactly as an empty
// one does — the invitation and its `grantToken` never leave the database, and
// the accept writer refuses with the sentence that names the remedy.
//
// `Idempotency-Key` IS NOT READ, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// None of the five use-cases takes a `clientIdempotencyKey`. What they have — two
// partial unique indexes for `designate`, `expectedStatus: "pending"` or a locked
// re-read for the other four — REFUSES a replay rather than absorbing one, which
// is not the same guarantee and must not be sold as it. `@dim/contract/input`'s
// `caretaker.ts` states the consequence a client has to handle.

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
import { caretakerCommandInputSchema } from "@dim/contract/input";

import { readCaretakerGrants, runCaretakerCommand, unavailable } from "./commands";
import { buildMyCaretakerGrantsV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// FOUR BUDGETS, TWO FAMILIES, AND WHY THE NUMBERS ARE NOT IN THIS FILE
// ---------------------------------------------------------------------------
// GET is the authenticated-READ family; POST is the authenticated-WRITE family.
// Both sets of ceilings, and the carrier-NAT arithmetic behind them, live in
// lib/infra/api-v1-limits.ts — they left this file on 2026-08-26 (WU-EAS-2) for
// the reason `me/transfers` states: four literals each claiming to match their
// siblings is a claim only a reader with every sibling open can check.
//
// The BUCKET NAMES stay here as literals. A shared ceiling is a decision about
// load; a shared counter would make "which surface is being hammered"
// unanswerable from the limiter's own storage.
//
// WHAT THE WRITE CEILING IS SIZED AGAINST, kept because it is about this feature
// and not about carrier NAT: designating somebody to look after an animal is not
// a burst activity, the way minting share links is while an owner decides what to
// expose. Ten a minute is generous headroom for a person answering a backlog of
// invitations plus every retry a flaky connection produces, and the daily figure
// is the abuse backstop: an account designating a hundred caretakers in a day is
// doing something no owner does, and each designation writes a third party's
// e-mail into a row. What this write produces is not a row — it is another
// person's write access to an animal.

// AUTHORIZED, not opted out: both handlers call requireLiveUser, and for the
// write the per-command authorization then runs in commands.ts (the titular deny
// for three of them) and inside the use-cases (the addressee match for the other
// two) — which is where it has to be, because two of the five are sent by
// somebody who holds no ownership row over the animal in question. Said here for
// a reader scanning for the guard, and said WITHOUT writing the opt-out marker,
// because a comment that spells the marker in order to deny it still reads as one
// to a scanner matching the token.
export async function GET(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_caretaker_grants_read_ip",
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
      "api-v1-me-caretaker-grants-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_caretaker_grants_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let grants: Awaited<ReturnType<typeof readCaretakerGrants>>;
  try {
    grants = await readCaretakerGrants({
      userId: live.user.id,
      callerEmail: live.user.email ?? "",
      callerEmailConfirmed: live.user.emailConfirmed,
    });
  } catch (err) {
    // NOT an empty hub. A read that failed and a person with no arrangements are
    // different facts, and a client that rendered "no tenés invitaciones" over a
    // pooler outage would hide somebody waiting for an answer about an animal.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildMyCaretakerGrantsV1({ grants, now: new Date() }), { status: 200 });
}

export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_caretaker_grants_write_ip",
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
      "api-v1-me-caretaker-grants-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_me_caretaker_grants_write_user",
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
  const parsed = caretakerCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  try {
    return await runCaretakerCommand({
      userId: live.user.id,
      // From the VERIFIED session. The body cannot name it; see the header.
      callerEmail: live.user.email ?? "",
      // Verified is not the same claim as PROVED — see the header's second note.
      callerEmailConfirmed: live.user.emailConfirmed,
      input: parsed.data,
    });
  } catch (err) {
    // The titular guard budgets its access read and throws on expiry. Caught HERE
    // rather than inside the guard's own caller so all three titular commands
    // answer 503 identically, and so a budget that later wraps a pre-read has one
    // place to land.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter in
 * this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop somebody REJECTING an invitation or
 * FINALIZING a live arrangement — and on this surface those are the two that must
 * never be blocked by an abuse control, because the alternative is another
 * person keeping write access to an animal while the answer is refused. The
 * authorization boundary stays intact and fails CLOSED.
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
    reportError(`api-v1-me-caretaker-grants/${endpoint}`, err);
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
