// `/api/v1/pets/{publicToken}/lost` — LOST MODE, for the person looking.
//
// GET reads the whole cockpit: the open episode, the sightings feed, what the
// public credential is publishing about the owner while the search runs, and
// which of the state commands this caller may send. POST runs one of six:
// marcar perdida, actualizar el avistaje, marcar encontrada, cambiar una
// preferencia de divulgación, reactivar la búsqueda, reportar un mensaje.
//
// WHY THIS IS NOT ON THE EVENTS ENDPOINT. Every kind behind
// `POST .../events` appends one row and answers with its id. These six move
// `pets.status`, open and close a case, publish or unpublish an owner's own
// contact details, fan an alert out to the organizations in a jurisdiction, and
// take a stranger's message off the owner's own feed. `events/writers.ts` names
// lost mode in its exclusion list and says exactly that: a feature, not an
// asiento.
//
// ONE URL AND SIX COMMANDS, for the reason the events endpoint has one URL and
// eleven kinds: six sibling routes would be six copies of one bearer check,
// one idempotency rule, one limiter pair and one access guard, kept in agreement
// by hand and drifting the first time somebody edited five of them.
//
// THE SIXTH IS A COMPLIANCE COMMAND, and it is worth naming as one. Google
// Play's IARC content-rating questionnaire declares this app as one where users
// interact and CONTENT CAN BE REPORTED. That declaration describes the app AS
// PUBLISHED, so `report_content` is not a feature request — it is the half of a
// statement already made to a store.
//
// WHO MAY DO WHAT is decided in `./commands.ts`, against the web's own guards,
// and it is NOT uniform: four of the five mirror `requirePetAccess` (any current
// holder including a caretaker, an org member with NO capability check, and a
// non-alive animal accepted at the door), while the caretaker-contact preference
// is titular-only and reactivation is refused on the org path outright. That
// file states it at length and this one does not restate it, because two copies
// of a rule is how the copies disagree.
//
// `Idempotency-Key` IS REQUIRED FOR EXACTLY ONE COMMAND, AND HONOURED THERE
// ---------------------------------------------------------------------------
// `report_last_seen` APPENDS a `note_added` to the spine and its use-case takes
// a `clientIdempotencyKey`; a double tap on a flaky connection must not put two
// sightings in one episode. It requires the header, insists it be a UUID for the
// same reason every write here does — `client_idempotency_key` is a Postgres
// `uuid` and a non-UUID raises 22P02 INSIDE the write, surfacing as a
// retryable-looking failure that reproduces forever — and reports the replay as
// `changed: false`.
//
// The other five carry no header, and that is a REFUSAL TO PROMISE rather than
// an omission. Their writers are idempotent on the STATE: marking lost an animal
// already lost is refused, marking found one already active writes nothing,
// reactivating with an open episode returns that episode, setting a preference
// to the value it already holds is a no-op, and reporting an item already
// reported appends nothing. Demanding a key those five could not honour would
// make this endpoint's promise false — the same call `events/writers.ts` makes
// about atestación PPP and embarazo.
//
// `report_content` IS THE ONE THAT PROVES THE RULE IS ABOUT STATE. It APPENDS —
// a `content_reported` event — and still carries no header, because "this item
// is reported" is a fact that is either true or not, never true twice. Reading
// the rule as "appends ⇒ header" would have demanded one here and got the
// taxonomy backwards.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT,
  API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { fetchLostEpisodeForPet, fetchLostScanEvents } from "@/lib/infra/lost-mode";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { isValidIdempotencyKey } from "@dim/contract/api";
import { lostCommandInputSchema } from "@dim/contract/input";

import { runLostCommand, unavailable } from "./commands";
import { type LostPetRow, buildPetLostV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The access query — indexed, single row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The two lost-mode reads: the episode (a case row plus its overlay probe) and
 * the feed (two capped event scans).
 *
 * The same eight seconds the libreta allows, and for the same reason: short
 * enough that a degraded pooler produces a 503 a client can retry rather than a
 * spinner it cannot.
 */
const LOST_BUDGET_MS = 8_000;

// TWO FAMILIES, ONE FILE — numbers and derivations in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// THE READ is the authenticated-read family, on this file's own argument: "the
// same numbers as `/pets/{token}` and `/libreta`, deliberately: a client that
// opens a pet and flips to its lost cockpit calls both inside one second."
//
// THE WRITE is `pet-disclosure-write`, shared with `POST /shares` and with nothing
// else: same per-user anchor, same act — an owner mid-search flipping what other
// people may see of one animal. The old per-IP ceiling of 20/min sat below a
// per-user 15/min, so a single owner and a third of a second one exhausted a whole
// carrier gateway.
//
// WHAT DOES NOT MOVE is this endpoint's real argument: the FAN-OUT. One `mark_lost`
// broadcasts to every organization in a jurisdiction, which is why the write is
// budgeted apart from an asiento at all — and the bucket that bounds a person
// producing that fan-out is the per-user one, unchanged at 15/min + 60/hr + 200/day.
// The per-IP ceiling was never the instrument for it; keyed on a carrier gateway it
// could not tell one owner from a hundred.
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
      "api_v1_lost_read_ip",
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
      "api-v1-lost-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_lost_read_user",
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
      "api-v1-lost-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const pet = access.pet as unknown as LostPetRow & { id: string };

  // THE READS ARE SKIPPED for an animal that is not lost, exactly as
  // `readLostData` skips them: there is no episode and no feed to find, and two
  // queries that can only answer "nothing" are two queries. The payload still
  // answers — with `episode: null`, an empty feed, the disclosure settings that
  // a FUTURE search would use, and `canMarkLost: true`.
  let episode: Awaited<ReturnType<typeof fetchLostEpisodeForPet>> = null;
  let scans: Awaited<ReturnType<typeof fetchLostScanEvents>> = [];
  if (pet.status === "lost") {
    try {
      episode = await withDbBudgetOrThrow(
        fetchLostEpisodeForPet(pet.id),
        LOST_BUDGET_MS,
        "api-v1-lost-episode",
      );
      scans = await withDbBudgetOrThrow(
        // Scoped to the OPEN episode so an older search's sightings cannot
        // pollute this one's feed — the same argument the web's reader passes.
        fetchLostScanEvents(pet.id, undefined, episode?.id),
        LOST_BUDGET_MS,
        "api-v1-lost-feed",
      );
    } catch (err) {
      // NOT an empty feed. A read that failed and a search nobody has reported
      // on are different facts, and a client that rendered "sin avistajes" over
      // a pooler outage would tell an owner nobody is looking.
      if (err instanceof DbBudgetExceededError) return unavailable();
      throw err;
    }
  }

  const payload = buildPetLostV1({
    pet,
    episode,
    scans,
    accessPath: access.kind === "owner" ? "owner" : "org",
    holderRole: access.kind === "owner" ? access.holderRole : null,
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
      "api_v1_lost_write_ip",
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
      "api-v1-lost-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_lost_write_user",
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
  const parsed = lostCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  // THE HEADER IS READ FOR ONE COMMAND. Required and UUID-shaped for the append;
  // ignored for the four state commands, whose writers are idempotent on the
  // state and for whom a key would be a guarantee nobody has. See the header.
  const rawKey = (request.headers.get("idempotency-key") ?? "").trim();
  const needsKey = parsed.data.command === "report_last_seen";
  if (needsKey && !isValidIdempotencyKey(rawKey)) {
    return apiV1Error("idempotency_key_required", 400);
  }

  return runLostCommand({
    publicToken,
    userId: live.user.id,
    idempotencyKey: needsKey ? rawKey : null,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing would stop an owner marking their animal lost over an
 * abuse control, while the authorization boundary stays intact and fails CLOSED.
 * That is the one that must.
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
    reportError(`api-v1-lost/${endpoint}`, err);
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
