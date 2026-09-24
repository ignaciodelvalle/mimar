// `POST /api/v1/pets/{publicToken}/events` — record one of the thirteen
// asientos an owner may write: vacuna, peso, antiparasitario, medicación
// inicio, medicación fin, nota, microchip, reemplazo de microchip,
// esterilización, visita veterinaria, información clínica, síntoma,
// atestación de raza potencialmente peligrosa.
//
// ONE ENDPOINT, THIRTEEN KINDS, AND THE SPINE'S OWN SHAPE. `pet_events` is a
// single append-only table discriminated by `event_type`. Thirteen sibling URLs
// would be thirteen copies of one bearer check, one idempotency contract, one
// limiter pair and one access guard, kept in agreement by hand and drifting the
// first time somebody edited ten of them. The body's `kind` is the
// discriminator the table already has.
//
// IT ONLY EVER APPENDS. Nothing in this product edits or deletes a `pet_events`
// row — a database trigger refuses both, by name — so there is no PUT and no
// PATCH near this. A mistake is corrected by appending a correction
// (`POST .../events/{eventId}/amend`), which is why 201 is the only success.
//
// WHO MAY WRITE is decided in `./writers.ts`, against the web's own guards, and
// it is NOT uniform across the thirteen: ELEVEN mirror `requireAlivePetAccess`
// (any current holder; an org member with `event.write`; never on a deceased
// animal), and TWO — nota and reemplazo de microchip — mirror the same
// capability rule on the org path while still being accepted on a DECEASED
// animal, because that half is a fact about the ANIMAL: a memorial note is the
// one thing a grieving owner may still write, and a chip recovered from an
// animal that died still has to stop pointing at it. That file states it at
// length — along with which owner writers deliberately did NOT cross, and on
// what evidence, and which of the thirteen fans out past the animal's own
// record — and this one does not restate it, because two copies of a rule is
// how the copies disagree.
//
// `Idempotency-Key` IS REQUIRED, AND IT IS HONOURED
// ---------------------------------------------------------------------------
// The web has no header to send: its forms carry a `clientIdempotencyKey`
// hidden field, generated per form mount, and it lands in the same column. This
// endpoint takes the same fact from the header where an HTTP client's own retry
// machinery can re-send it, requires it rather than accepting it — optional
// idempotency is idempotency nobody has, as `POST /api/v1/pets` states — and
// insists it be a UUID, because `client_idempotency_key` is a Postgres `uuid`
// and a non-UUID would raise 22P02 INSIDE the write and surface as a
// retryable-looking failure that reproduces forever.
//
// A replay resolves to the first attempt's event and answers 201 with
// `wasDuplicate: true`. Nothing is appended twice, no reminder is scheduled
// twice, no cache is re-derived twice: every one of the thirteen use-cases skips
// every side effect when the idempotent insert reports a no-op — the canonical
// `pet_identifications` row a microchip asiento writes included, and the whole
// outbreak-signal fan-out a síntoma would otherwise repeat.

import { apiV1Error } from "@/lib/infra/api-v1";
import {
  API_V1_PET_RECORD_WRITE_IP_LIMIT,
  API_V1_PET_RECORD_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { isValidIdempotencyKey } from "@dim/contract/api";
import { recordEventInputSchema } from "@dim/contract/input";

import { unavailable, writeEvent } from "./writers";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

// THE `pet-record-write` FAMILY — numbers in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// ITS OWN FAMILY RATHER THAN THE AUTHENTICATED-WRITE ONE, because a per-IP ceiling
// in this repo is derived from the per-user anchor beneath it and this anchor is
// the widest write budget on the surface — 20/min + 80/hr + 300/day against the
// transfer family's 10 + 40 + 100. The reason for the width is this file's own
// sentence, and it is the whole derivation: "recording is the ORDINARY act on this
// surface and correcting is the exceptional one, and a vet day at a rescue is many
// animals from one egress in one afternoon."
//
// THE OLD PER-IP CEILING SAID IT WAS SIZED FOR CGNAT and was not: 30/min above a
// per-user 20/min is ONE AND A HALF people at their own ceiling, on a bucket a
// whole carrier gateway shares. Twelve of them is what it is now.
//
// SAME PER-MINUTE FIGURE AS `inbox-state`, DIFFERENT FAMILY, and deliberately so.
// An asiento is a row on the append-only spine; a read receipt is an UPDATE on the
// caller's own notification. Two families that meet at a number are still two.
//
// The per-user ceiling does not move and is where the reasoning stays: 20/min is
// headroom for retries plus an owner entering a vaccine, a weight and a note in
// one sitting; 80/hr is a shelter worker doing rounds; 300/day is the abuse
// backstop, past which an account is doing something no holder does — and every
// asiento it wrote is signed by it and auditable.

// AUTHORIZED, not opted out: this handler calls requireLiveUser and its writer
// calls resolvePetHolderAccess, and those two calls ARE the authorization. Said
// here for a reader scanning for the guard — and said WITHOUT writing the
// opt-out marker, because a comment that spells the marker in order to deny it
// still reads as one to a scanner matching the token.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  // Both are free — a regex over a header and a trim over another. Doing them
  // before the limiter means a client that got the envelope wrong costs the
  // platform no counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // ONE code for absent and for malformed, the same call every write on this
  // surface makes: both mean "send a well-formed header".
  const idempotencyKey = (request.headers.get("idempotency-key") ?? "").trim();
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return apiV1Error("idempotency_key_required", 400);
  }

  if (
    !(await spendBudget(
      "api_v1_event_ip",
      callerIp(request.headers),
      API_V1_PET_RECORD_WRITE_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-event-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (!(await spendBudget("api_v1_event_user", live.user.id, API_V1_PET_RECORD_WRITE_USER_LIMIT))) {
    return apiV1Error("rate_limited", 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally (VACCINE_NAME_REQUIRED, WEIGHT_TOO_HIGH, …). This is the backstop
  // for a client out of step with the contract, which is why it carries no
  // field detail — the envelope is one key.
  const parsed = recordEventInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  return writeEvent({
    publicToken,
    userId: live.user.id,
    idempotencyKey,
    input: parsed.data,
  });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo — including on this write. The limiter is itself a DB write; if
 * `rate_limit_buckets` is unavailable, refusing would stop every owner in the
 * country recording a vaccine over an abuse control, while the authorization
 * boundary stays intact and fails CLOSED. That is the one that must.
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
    reportError(`api-v1-event/${endpoint}`, err);
    return true;
  }
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `DEACTIVATED` is a refusal here and not a tolerated read: this is a WRITE,
 * and "reads stay open so the user can see why; writes stop" is the repo's
 * policy since the 2026-07-04 redirect incident.
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
