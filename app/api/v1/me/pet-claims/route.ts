// `/api/v1/me/pet-claims` — RECLAMAR UNA MASCOTA, from the phone.
//
// POST runs the two commands of the web's claim wizard that a phone can honestly
// run: `lookup` (which animal does this chip or tattoo resolve to, and may I
// claim it) and `claim_free` (take it, if nobody holds it).
//
// WHY THIS HANGS OFF `/me` AND NOT OFF A PET
// ---------------------------------------------------------------------------
// Not for `/me/appointments`'s reason ("the question is asked across every
// animal"). For a much harder one: THERE IS NO PET IN THE ADDRESS BECAUSE THERE
// MAY NOT BE ONE. Both writers resolve the animal from the private identifier
// and consult no caller-supplied token, and `submit-claim-dispute.ts` records
// exactly what a token in this position cost the last time it was there — the
// dispute writer used to take `petToken` straight into a `where`, which made it
// "a national denial-of-rescue button", because `/perdidas` hands out the token
// of every lost animal in the country with no login.
//
// So the URL names the CALLER's claims, and the animal is something the server
// derives from evidence. A `/pets/{token}/claim` route would be a route whose
// own shape invites the bug.
//
// TWO COMMANDS, AND THE THIRD IS REFUSED RATHER THAN DEFERRED
// ---------------------------------------------------------------------------
// The web's wizard has a third step: raise a `custody_dispute` when the animal
// already has a custody. It is not here and it is not "a later work unit" the
// way booking is missing from `/me/appointments`. `submitClaimDisputeForUser`
// requires at least one evidence FILE and refuses without one — a gate that
// exists because a dispute notifies the registered owner, appends an uneditable
// row to their animal's spine, flips `pets.in_custody_dispute` (which strips the
// owner's phone and the finder form off the public credential) and opens a case
// for a local authority. This app cannot attach a file: an image picker is a
// native module, which is an EAS build, which is the same wall the pet photo and
// the art. 14 export ran into.
//
// A `dispute` command over JSON would therefore be a command the server refuses
// on every call, and a client would draw the control anyway. The contract's
// input union has two members for exactly that reason, and a client meeting
// `variant: "active_owner"` sends the person to the browser.
//
// WHAT THIS DOOR IS STRICTER ABOUT THAN THE BROWSER, SAID OUT LOUD
// ---------------------------------------------------------------------------
// The web page is `requireUserOrRedirect()`, which PASSES a DEACTIVATED account
// on purpose (`lib/infra/auth-guards.ts`). This route runs `requireLiveUser`,
// which refuses one with `account_deactivated`. That is the same divergence
// `me/privacy` recorded on 2026-08-29 and left as a PO question — and here the
// direction is unambiguously the safe one: refusing a deactivated account the
// ability to take ownership of an animal grants nothing that the browser grants
// and this door does not. It is written down rather than silently mirrored,
// because the PO question is about the ERASURE, and somebody reading only that
// note might conclude every `/api/v1` door should relax.
//
// THE BUDGETS, AND THE ONE THAT IS DELIBERATELY NOT HERE
// ---------------------------------------------------------------------------
// ONE per-IP bucket for the whole route, and NO per-user bucket at the route.
//
// The per-user ceiling for this act already exists, inside both use-cases:
// `claim_lookup`, 30/min + 200/hr, keyed on the caller and spent by the lookup
// and the claim TOGETHER so a burst of probes counts as one. That is the budget
// the WEB spends through the same use-cases. Adding this surface's generic
// `API_V1_AUTHENTICATED_WRITE_USER_LIMIT` (10/min) on top would give the phone a
// ceiling three times tighter than the browser's for the same act, on the same
// account — the inverse of the argument that earned `inbox-state` its own
// family, and a ceiling a caller escapes by opening a browser is not a ceiling.
//
// The per-IP bucket has no such twin: the web page is a server action behind a
// cookie and takes no address-keyed ceiling at all. It is here because every
// `/api/v1` door takes one BEFORE the GoTrue round-trip, so a caller with a
// well-formed but invalid token cannot spend `auth.getUser()` calls unbounded.
//
// ONE BUCKET FOR BOTH COMMANDS, not one per command. The two share a per-user
// budget precisely so that alternating between them buys nothing; splitting the
// per-IP counter would hand a prober two.
//
// THE CEILING IT SPENDS IS TIGHTER THAN THIS ACT'S OWN DERIVATION, AND THAT IS
// A KNOWN, DECLARED GAP. `api-v1-limits.ts`'s rule is that a per-IP ceiling is
// `API_V1_SIMULTANEOUS_CALLERS` (12) times the per-user anchor, which for
// `claim_lookup`'s 30/min + 200/hr would be 360/min + 2 400/hr — a `pet-claim`
// family this file cannot create, because that file is another lane's territory
// in this window. `API_V1_AUTHENTICATED_WRITE_IP_LIMIT` (120/min + 1 200/hr) is
// what it spends meanwhile, which is FOUR simultaneous callers per carrier
// gateway rather than twelve. Tighter is the safe direction for a bucket — it
// refuses more, never less — and the cost is named rather than hidden: behind
// one CGNAT address, four people each probing at their full personal rate
// exhaust the gateway's minute. The integrator's note carries the exact family
// and derivation to land.
//
// `Idempotency-Key` IS NOT READ, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// `submitFreeClaimForUser` takes no `clientIdempotencyKey`. What it has instead
// is `SELECT … FOR UPDATE` on the pet row plus a re-check of active custody
// inside the transaction, which SERIALIZES two concurrent claims and refuses the
// second — it does not absorb it. So a retry after a timeout answers
// `claim_not_claimable` whether the first attempt landed or somebody else
// claimed the animal in between, and the client's move is to look, not to
// re-send. `@dim/contract/api`'s `pet-claim.ts` states that where a client author
// reads it.

import { apiV1Error } from "@/lib/infra/api-v1";
import { API_V1_AUTHENTICATED_WRITE_IP_LIMIT } from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { petClaimCommandInputSchema } from "@dim/contract/input";

import { runPetClaimCommand, unavailable } from "./commands";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body,
// and the act's own authorization — knowledge of the private identifier — then
// runs inside the use-cases, which is where it has to be, because the rule is
// about an animal this caller demonstrably does NOT hold. Said here for a reader
// scanning for the guard, and said WITHOUT writing the opt-out marker, because a
// comment that spells the marker in order to deny it still reads as one to a
// scanner matching the token.
export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_me_pet_claims_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper. `check-authz-guards` reads
  // the handler body ONLY and does not follow calls, so a guard factored into a
  // module-level function reads as ABSENT — and that is the right rule rather
  // than a limitation: a reader auditing who may reach this URL should find the
  // answer here, not one indirection away.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-pet-claims-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally. This is the backstop for a client out of step with the contract,
  // which is why it carries no field detail — the envelope is one key.
  const parsed = petClaimCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runPetClaimCommand({ userId: live.user.id, input: parsed.data });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing here would stop somebody REGISTERING AN ANIMAL THEY
 * FOUND to their own name — and the abuse this bucket bounds is a probe of a
 * 15-digit keyspace, which a limiter outage does not make cheaper in any useful
 * sense.
 *
 * THE AUTHORIZATION BOUNDARY IS NOT THIS, AND IT FAILS CLOSED. Knowledge of the
 * private identifier is what authorizes a claim, it is enforced inside the
 * use-cases against `pet_identifications`, and no failure of this function
 * reaches it: a caller who does not know the chip still resolves to no animal.
 * The per-user `claim_lookup` budget inside the use-cases fails open too, and
 * for the same reason.
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
    reportError(`api-v1-me-pet-claims/${endpoint}`, err);
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
      // STRICTER THAN THE WEB PAGE, deliberately — see the header.
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
