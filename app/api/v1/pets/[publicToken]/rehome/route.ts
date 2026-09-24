// `/api/v1/pets/{publicToken}/rehome` — ACOMPAÑAMIENTO DE ADOPCIÓN: the
// titular's surface for asking a verified org to sponsor the animal's adoption,
// cancelling that ask, and ending a running sponsorship.
//
// GET reads the three-state arrangement (none / pending / active), the orgs
// the titular may ask, and which of the three commands this caller may send.
// POST runs one of the three. Both reach the use-cases the web's
// `buscar-hogar` page reaches — `./commands.ts` says how, and why that is the
// whole point.
//
// ONE GUARD, AND IT IS NARROWER THAN THE REST OF THE SURFACE. Every other
// pet-scoped door here admits a co-owner; this one is the LEGAL OWNER's alone
// (`isLegalOwner`, `./payload.ts`), because consenting to hand an animal's
// listing to an org — and taking it back — is what spec REQ-1 and REQ-14 keep
// for the titular. The read refuses a co-owner with the same 403 the write
// does, rather than answering a payload whose every lever is off: the screen
// is not theirs, and the face's own gate (`canSeeAdoptionSupport`) never sends
// them here.
//
// `Idempotency-Key` IS REQUIRED FOR THE TWO WITHDRAWS AND HONOURED THERE. Each
// one's success invalidates its own precondition, so the use-cases keep the
// key on the closing fact and ask that ledger BEFORE the state guard (their
// headers). Absent or malformed on a withdraw is the one 400 every write on
// this surface makes (`idempotency_key_required`); ignored on the ask, whose
// replay shape `@dim/contract/input`'s `rehome.ts` states.
//
// TWO FAMILIES, ONE FILE — numbers and derivations in lib/infra/api-v1-limits.ts.
// The read takes `authenticated-read` (a client opens the pet and taps the row
// inside one second); the write takes `authenticated-write`, whose anchor was
// derived against this exact class of act — a change of who holds an animal in
// the national registry.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { getRehomeStateForPet } from "@/src/modules/rehome/application/get-rehome-state-for-pet";
import { listCoveringOrgs } from "@/src/modules/rehome/application/list-covering-orgs";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";
import { isValidIdempotencyKey } from "@dim/contract/api";
import {
  REHOME_COMMANDS_REQUIRING_IDEMPOTENCY_KEY,
  rehomeCommandInputSchema,
} from "@dim/contract/input";

import { runRehomeCommand, unavailable } from "./commands";
import { buildPetRehomeV1, isLegalOwner } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The access query, the spine's state read, the org list — indexed, few rows. */
const READ_BUDGET_MS = 8_000;

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
      "api_v1_rehome_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // CALLED IN THE HANDLER BODY, not through a helper the two methods share.
  // `check-api-v1-envelope` reads the handler body ONLY and does not follow
  // calls, so a guard factored into a module-level function reads as ABSENT.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-rehome-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_rehome_read_user",
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
      READ_BUDGET_MS,
      "api-v1-rehome-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  if (access.kind === "none") return apiV1Error("not_found", 404);
  if (!isLegalOwner(access)) return apiV1Error("rehome_forbidden", 403);

  // THE STATE AND THE LIST ARE ONE READ OR NONE: a payload that said "none" over
  // a spine it could not read would offer the ask to somebody whose animal is
  // mid-sponsorship. 503 with a retry-after is the honest "unknown".
  let state: Awaited<ReturnType<typeof getRehomeStateForPet>>;
  let orgs: Awaited<ReturnType<typeof listCoveringOrgs>>;
  try {
    [state, orgs] = await withDbBudgetOrThrow(
      Promise.all([
        getRehomeStateForPet(access.pet.id, { repo: RehomeRepository }),
        listCoveringOrgs(
          {
            province: access.pet.jurisdictionProvince,
            locality: access.pet.jurisdictionLocality,
          },
          { repo: RehomeRepository },
        ),
      ]),
      READ_BUDGET_MS,
      "api-v1-rehome-state",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return apiV1Json(buildPetRehomeV1({ pet: access.pet, access, state, orgs, now: new Date() }), {
    status: 200,
  });
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
      "api_v1_rehome_write_ip",
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
      "api-v1-rehome-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  if (
    !(await spendBudget(
      "api_v1_rehome_write_user",
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
  const parsed = rehomeCommandInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  // THE HEADER IS READ FOR THE TWO WITHDRAWS. Required and UUID-shaped there —
  // `client_idempotency_key` is a Postgres `uuid`, and a non-UUID would raise
  // inside the write as a retryable-looking failure that reproduces forever.
  // Ignored for the ask, whose writer keeps no key (see the header).
  const rawKey = (request.headers.get("idempotency-key") ?? "").trim();
  const needsKey = REHOME_COMMANDS_REQUIRING_IDEMPOTENCY_KEY.includes(parsed.data.command);
  if (needsKey && !isValidIdempotencyKey(rawKey)) {
    return apiV1Error("idempotency_key_required", 400);
  }

  return runRehomeCommand({
    publicToken,
    userId: live.user.id,
    input: parsed.data,
    idempotencyKey: needsKey ? rawKey : null,
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
    reportError(`api-v1-rehome/${endpoint}`, err);
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
