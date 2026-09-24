// `/api/v1/pets/{publicToken}/shares` — COMPARTIR, for the person deciding who
// else may look.
//
// GET reads the whole sheet: the active share links, the Tier-2 public window,
// and which of the four commands this caller may send. POST runs one of those
// four: crear un link de libreta, revocarlo, abrir la ventana Tier-2, cerrarla.
//
// WHY THESE TWO FEATURES SHARE ONE URL. A share link mints a bearer-readable
// secret into `libreta_share_tokens`; the Tier-2 window moves two columns on
// `pets` and changes what the PUBLIC credential shows. Different mechanisms, and
// a reader could reasonably expect two endpoints. The web disagrees and it
// disagrees for a product reason worth mirroring: `MergedShareSheet` (design
// ADR-7) puts both under one heading because a person here is choosing HOW MUCH
// to expose, not which subsystem to use. Two endpoints would be this surface
// re-splitting what the web deliberately joined — and would make "is anything
// open right now" a question that takes two round trips.
//
// ONE URL AND FOUR COMMANDS, for the reason the lost endpoint has one and five:
// four sibling routes would be four copies of one bearer check, one limiter pair
// and one access guard, kept in agreement by hand.
//
// WHO MAY DO WHAT is decided in `./commands.ts`, against the web's own guards,
// and it is NOT uniform — three commands are titular-only and revocation is
// creator-or-admin. That file states it at length and this one does not restate
// it, because two copies of a rule is how the copies disagree.
//
// THIS ENDPOINT HANDS OUT CREDENTIALS, WHICH CHANGES WHAT ITS RESPONSES ARE
// ---------------------------------------------------------------------------
// Every active link comes back with its `shareToken`, and that string reads the
// animal's medical record for whoever holds it. Three consequences, all of them
// already true of this file and worth checking it against:
//
//   · `cache-control: no-store` on every response. Set by `apiV1Json` for the
//     whole surface (api-invariants.md §2) rather than by this route, which
//     matters here more than anywhere else on it: a shared cache holding this
//     body is a shared cache holding a medical credential.
//   · NOTHING IS LOGGED. There is no `reportError` call carrying a body, no
//     `console.*`, and every refusal is a fixed code from a closed vocabulary.
//     The limiter buckets below are keyed by IP and by user id — never by a
//     share token, which would put the credential into `rate_limit_buckets`.
//   · NO TOKEN IS EVER AN INPUT. Revocation takes the ROW id, so the one
//     operation whose purpose is to kill a secret does not carry the secret
//     through a request body, an access log and a retry queue on its way.
//
// `Idempotency-Key` IS NOT READ, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// No writer behind these four takes a `clientIdempotencyKey`; nothing here
// appends to the spine at all. All four are idempotent on the STATE, and three
// of them recognise a replay and report it as `changed: false`. Requiring a
// header this endpoint could not honour would make its promise false — the same
// call `events/writers.ts` makes about atestación PPP and embarazo.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT,
  API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { getActiveLibretaShares } from "@/src/modules/pets/application/libreta-share/get-active-libreta-shares";
import { isPlatformAdmin } from "@/src/modules/pets/application/libreta-share/share-revocation-scope";
import { shareCommandInputSchema } from "@dim/contract/input";

import { runShareCommand, unavailable } from "./commands";
import { type SharesPetRow, buildPetSharesV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The access query — indexed, single row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The share list plus, when it can change an answer, the admin probe.
 *
 * At most five rows on a partial index, and one primary-key read. The same eight
 * seconds every sibling allows, for the same reason: short enough that a
 * degraded pooler produces a 503 a client can retry rather than a spinner it
 * cannot.
 */
const SHARES_BUDGET_MS = 8_000;

// TWO FAMILIES, ONE FILE — numbers and derivations in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// THE READ is the authenticated-read family, on this file's own argument: "the
// same numbers as `/pets/{token}`, `/libreta` and `/lost`, deliberately: a client
// that opens a pet and flips to its sharing sheet calls both inside one second."
//
// THE WRITE is `pet-disclosure-write`, which it shares with `POST /lost` and with
// nothing else. The per-user anchor is identical in both files and so is the act:
// an owner flipping what other people may see of one animal while they think about
// what they are comfortable publishing. The old per-IP ceiling was 20/min against
// a per-user 15/min — ONE owner at their own ceiling and a third of a second owner
// exhausted the whole carrier gateway, which is the inversion this repo has now
// corrected in four places.
//
// WHAT DOES NOT MOVE, and it is the load-bearing half of this endpoint's argument:
// what a successful create PRODUCES. It hands out a bearer credential over a
// medical record, the five-active cap bounds how many exist at once but not how
// fast they are minted and revoked, and the bucket that bounds THAT is the per-user
// one — unchanged at 15/min + 60/hr + 200/day. The IP ceiling never was that
// bucket; it was a CGNAT-blind proxy for it.
//
// Both keep their OWN bucket names: a shared counter makes "which surface is being
// hammered" unanswerable from the limiter's own storage.

// AUTHORIZED, not opted out: both handlers call requireLiveUser and then resolve
// pet access, and those two calls ARE the authorization. Said here for a reader
// scanning for the guard — and said WITHOUT writing the opt-out marker, because
// a comment that spells the marker in order to deny it still reads as one to a
// scanner matching the token.
export async function GET(
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
      "api_v1_shares_read_ip",
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
      "api-v1-shares-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_shares_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-shares-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const pet = access.pet as unknown as SharesPetRow;
  const accessPath = access.kind === "owner" ? "owner" : "org";
  const holderRole = access.kind === "owner" ? access.holderRole : null;

  // THE LIST IS SKIPPED ENTIRELY ON THE ORG PATH, and not merely emptied after
  // the fact. `getActiveLibretaSharesAction` returns `shares: []` for any caller
  // whose `accessPath !== "owner"` (`libreta-share.ts:152`) — so a shelter with
  // custody sees nothing, and a query that could only be discarded is a query.
  let shares: Awaited<ReturnType<typeof getActiveLibretaShares>> = [];
  let isAdmin = false;
  if (accessPath === "owner") {
    try {
      // THE SAME USE-CASE the web's own narrow read calls
      // (`libreta-share.ts:154`), so the two doors cannot disagree about what
      // "active" means.
      shares = await withDbBudgetOrThrow(
        getActiveLibretaShares(pet.id),
        SHARES_BUDGET_MS,
        "api-v1-shares-list",
      );
      // Read ONLY when it can change an answer — the same condition the web's
      // revoke uses. Every listed link being the caller's own is the ordinary
      // case, and it needs no probe.
      if (shares.some((row) => row.createdByUserId !== live.user.id)) {
        isAdmin = await withDbBudgetOrThrow(
          isPlatformAdmin(live.user.id),
          SHARES_BUDGET_MS,
          "api-v1-shares-admin",
        );
      }
    } catch (err) {
      // NOT an empty list. A read that failed and an animal with nothing shared
      // are different facts, and a client that rendered "no hay links activos"
      // over a pooler outage would tell an owner nobody can see the record.
      if (err instanceof DbBudgetExceededError) return unavailable();
      throw err;
    }
  }

  const payload = buildPetSharesV1({
    pet,
    shares,
    accessPath,
    holderRole,
    userId: live.user.id,
    isAdmin,
    now: new Date(),
  });

  return apiV1Json(payload, { status: 200 });
}

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
      "api_v1_shares_write_ip",
      callerIp(request.headers),
      API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT,
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
      "api-v1-shares-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_shares_write_user",
      live.user.id,
      API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT,
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
  const parsed = shareCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return runShareCommand({
    publicToken,
    userId: live.user.id,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop an owner REVOKING a link they no longer trust
 * — which is the one thing on this surface that must never be blocked by an
 * abuse control. The authorization boundary stays intact and fails CLOSED.
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
    reportError(`api-v1-shares/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `DEACTIVATED` refuses the WRITE and, here, the read too — this whole surface
 * is one URL, and splitting the liveness rule by method would be the endpoint
 * inventing a policy its siblings do not have.
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
