// POST /api/v1/pets — the first `/api/v1` endpoint that CHANGES something.
//
// A citizen registers their own animal and gets back the one thing that matters:
// the public token that IS the credential (invariant #1). Everything else this
// handler does is adapter work — turn a JSON body into the domain's `ParsedPet`,
// run the resolutions the contract package deliberately cannot (breed catalog,
// INDEC locality, PPP classification), and hand the result to `registerPet`,
// which is already plain-data with injected dependencies and needs nothing from
// Next.
//
// ---------------------------------------------------------------------------
// `Idempotency-Key` IS REQUIRED, AND WHY IT IS A HEADER
// ---------------------------------------------------------------------------
// The web posts a stable per-form-session UUID as a hidden field, so a
// double-tap resolves to the first submit's pet instead of creating a second
// animal (projection-writes audit §6). That mechanism is unchanged here — the
// value lands in `pet_events.client_idempotency_key` exactly as the form's does,
// and `registerPet` takes an advisory lock and looks it up INSIDE the
// transaction.
//
// What changes is where it travels. A phone on a subway retries; that is not an
// edge case, it is the normal operating condition of the client this endpoint
// exists for, and a retry that creates a second animal is unrecoverable by the
// person it happens to (two credentials, two QR codes, one dog). A header is
// where an HTTP client's own retry machinery can see and re-send the key without
// the application layer being involved, and it keeps a property of the REQUEST
// out of a body that describes an ANIMAL.
//
// REQUIRED rather than optional, and that is the whole point. Optional
// idempotency is idempotency nobody has. The refusal has its own code
// (`idempotency_key_required`) so a client author sees the envelope is wrong
// instead of hunting through a body schema that was never the problem.
//
// A REPLAY ANSWERS 201 WITH THE SAME BODY. Not 200, not 409: the caller asked
// for a pet to exist and a pet exists. `wasDuplicate: true` is there so a client
// can skip the confetti and not re-fire analytics; a client that ignores the
// field entirely still behaves correctly.
//
// ---------------------------------------------------------------------------
// THE GATES THIS RUNS, AND THE ONES IT STRUCTURALLY CANNOT
// ---------------------------------------------------------------------------
// RUNS, because they are server-side authority and a client cannot be trusted
// with any of them:
//   · BREED (QA A4, 2026-08-13) — `resolveBreedForWrite`, the same call
//     `createPetAction` makes. The catalog now ships in `@dim/contract/reference`
//     so a native picker renders offline, and that changes nothing here: the
//     server still resolves whatever arrives (folding + curated aliases) to a
//     canonical label or rejects it. A misspelled PPP breed must not escape a
//     LEGAL regime by spelling, and "the client had the list" is not a boundary.
//   · LOCALITY — `normalizeLocationForWrite(…, { locality: "strict" })`, the
//     same strict INDEC pair check the web alta runs. A locality that never came
//     from `GET /api/v1/localities` is refused here, not stored as free text.
//   · SAME-OWNER DEDUPE (data-quality gate P2) — an active owned pet matching on
//     normalized name + species + sex refuses with `duplicate_pet_suspected`, and
//     the caller re-sends with `duplicateOverride: true` if they mean it. Soft on
//     the web (an inline "¿es la misma?" prompt) and therefore soft here; the
//     client already holds the list from `GET /api/v1/me/pets` and can name the
//     pet it matched without this response disclosing which one.
//     THE SCAN SKIPS THE PET THIS REQUEST'S OWN KEY CREATED (A2-alta-asentar-04).
//     It runs before `registerPet`, so without that exclusion a retry after the
//     client's 10 s timeout — the case the key exists for — was answered 409
//     about the pet the phone had just created, and the replay 201 below was
//     unreachable. The ordering is not the bug and was not changed: a refused
//     registration should still cost the cheapest possible work.
//   · PPP CLASSIFICATION — jurisdiction-aware, so the flag stored on the pet is
//     the one that province's rules produce, not the one a national list guesses.
//
// CANNOT, and the reasons are in `@dim/contract/input/register-pet.ts` where a
// client author reads them:
//   · MICROCHIP. Registering a chip is a protocol, not a field: a collision can
//     land on a LOST pet (the web navigates to a match page), an ACTIVE one (a
//     force-token escape hatch plus a dispute written to the other pet's spine)
//     or a DECEASED one (a hard block). None of that has a native counterpart
//     yet, and half a protocol dead-ends its user at a web URL. The chip fields
//     are absent from the input schema, which makes the P3 duplicate-chip gate
//     and the cross-check structurally unreachable rather than skipped. Deferred
//     to the work unit that ports the collision flow.
//   · PHOTO. Multipart is its own transport decision; this endpoint takes JSON.
//     A pet registers without one, exactly as it can on the web.
//
// ---------------------------------------------------------------------------
// WHY `registerPet` IS NOT INSIDE A TIME BUDGET
// ---------------------------------------------------------------------------
// Every read on this surface is bounded by `withDbBudgetOrThrow`, and the reads
// below are. The WRITE is not, deliberately: that helper races a promise against
// a timer and rejects, which does not abort a Postgres transaction. Wrapping the
// registration would produce a 503 for a transaction that then COMMITS — the
// client sees failure, the registry sees a pet, and the two disagree forever.
// The honest bound on a hung write is the platform's function timeout, and the
// honest recovery is the retry this endpoint already guarantees is safe.

import { type PetRegisteredV1, isValidIdempotencyKey } from "@dim/contract/api";
import { registerPetInputSchema } from "@dim/contract/input";

import { db } from "@/db";
import { resolveBreedForWrite } from "@/lib/domain/breed-validation";
import { isIdentityPending } from "@/lib/domain/identity-completeness";
import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import {
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_PET_REGISTRATION_IP_LIMIT,
  API_V1_PET_REGISTRATION_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { findSameOwnerDuplicatePet } from "@/lib/infra/owner-pet-dedupe";
import { resolvePppClassificationForJurisdiction } from "@/lib/infra/ppp-classification";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { registerPet } from "@/src/modules/pets/application/register-pet";
import type { NewNotification, ParsedPet } from "@/src/modules/pets/domain/types";
import { PetsRepository } from "@/src/modules/pets/infrastructure/pets-repository";

export const dynamic = "force-dynamic";

/** One `auth.getUser()` round-trip to GoTrue plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * The pre-transaction resolutions: the strict INDEC locality lookup, the
 * same-owner dedupe scan and the jurisdiction's PPP rules. Three bounded reads
 * before anything is written, so a degraded pooler answers 503 instead of
 * holding the request open until the platform kills it.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// THE `pet-registration` FAMILY — numbers in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// THE OLD PER-IP CEILING CLAIMED THE DERIVATION IT DID NOT HAVE, which is the
// reason this paragraph is longer than its siblings'. It read "Sized for CGNAT,
// not for a household. Mobile carriers put hundreds of subscribers behind one
// address, so this bucket is shared far more widely than it looks and must never
// be the thing that stops a real registration" — above 30/min + 120/hr. Per hour
// that is FOUR accounts at their own 30/hr, for an entire carrier gateway.
//
// AND THE BURST IS THIS PRODUCT'S OWN. `/api/v1/localities` was raised to 600/min
// in api-v1-limits.ts for "a municipality running a registration drive in a plaza,
// twenty people registering a pet at once on the same cell", with that route's
// note that "a false throttle here costs a pet its credential". The typeahead was
// made to survive the drive; the registration it feeds was left at a ceiling the
// same drive exhausts inside an hour.
//
// THE SECOND JOB THIS BUCKET CLAIMS, re-checked rather than inherited. It was
// "here to bound a SCRIPTED farm running from one host, which the per-user budget
// below structurally cannot see (a farm makes an account per pet)". True, and the
// binding constraint on that farm is not this ceiling: accounts come from
// `auth_signup_ip`, and that ceiling is upstream of this one and far tighter,
// whether this endpoint allows 120/hr or 360/hr.
//
// THE COMPARISON MOVED A WINDOW DOWN on 2026-08-29 and the conclusion did not.
// This paragraph used to read "3/min + 15/hr, deliberately unchanged. Fifteen
// accounts an hour from one host is fifteen pets an hour … eight times tighter" —
// true, and an HOURLY comparison, which was all that existed while every auth
// bucket had only short windows. `signup-limits.ts` re-derived that bucket into a
// burst allowance under a DAY ceiling, so the honest comparison is now the one
// that decides a farm's yield rather than its peak: signup allows 360 accounts per
// address per day; this endpoint has no daily bound at all (360/hr = 8,640/day).
//
// SAID COMPLETELY: the multiple did not improve on every window. Signup against
// this bucket, before → after — minute 40× → 2×, hour 24× → 2×, day 24× → 24×.
// Both short windows collapsed to 2× and only the day held. Signup still binds,
// because a farm needs an account per pet and is bounded by its daily yield
// rather than by its best minute, and it binds at the SAME 360 pets a day the old
// 15/hr yielded over 24 hours. But there is now 2× of short-window headroom here,
// not 24×, and a burst argument that leans on this paragraph has to use that.
//
// The per-user ceiling does not move and is where the reasoning stays: 10/min is
// headroom for RETRIES of a form that takes minutes to type (a limit that punishes
// the retry it just asked for would be self-defeating); 30/hr is ten pets with
// three attempts each, past a household and past a foster with a litter — a rescue
// at real volume uses the org intake flow and its own budget; 60/day is the abuse
// backstop, and every pet created is owned by the account and auditable, so being
// wrong there costs a support conversation rather than an animal.

// AUTHORIZED, not opted out: this handler calls requireLiveUser in its own body
// and that call IS the authorization — a pet does not exist yet, so there is no
// pet-scoped guard to use and the liveness guard is the boundary (the same
// reasoning `createPetAction` records). Said here for a reader scanning for the
// guard, and said WITHOUT writing the opt-out marker, because a comment that
// spells the marker in order to deny it still reads as one to a scanner that
// matches the token.
export async function POST(request: Request) {
  // Both free — a regex over one header and a trim over another. Doing them
  // before the limiter means a client that got the envelope wrong costs the
  // platform no counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // MUST BE A UUID, and until 2026-08-25 this accepted any non-blank string
  // (WU-B review FB-1). `pet_events.client_idempotency_key` is a Postgres
  // `uuid`, so a ULID or a nanoid was accepted here, carried into the
  // transaction, and raised `22P02` inside it — surfacing as
  // `pet_registration_failed`, whose documented remedy is "retry ONCE with the
  // SAME key". That reproduces the identical 500 forever and spends the
  // caller's 10/min budget doing it, until the answer becomes a 429. A
  // permanent client bug wearing a retryable server error's clothes.
  //
  // ONE code for absent and for malformed, deliberately. `idempotency_key_required`
  // means "a client BUG in the ENVELOPE, not in the body" and the remedy is
  // identical in both cases: send a well-formed header. The bar for a new code
  // in this vocabulary is "a decision a client has to be able to act on
  // differently", and there is no different action here — a second code would
  // widen an exhaustive switch in every consumer to say the same sentence twice.
  const idempotencyKey = (request.headers.get("idempotency-key") ?? "").trim();
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return apiV1Error("idempotency_key_required", 400);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do (check-api-guard-headers).
  const ipAllowed = await spendBudget(
    "api_v1_pets_register_ip",
    callerIp(request.headers),
    API_V1_PET_REGISTRATION_IP_LIMIT,
  );
  if (!ipAllowed) return apiV1Error("rate_limited", 429);

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-pets-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!live.ok) return liveUserRefusal(live.reason);
  const userId = live.user.id;

  // Per-user budget, spent only once the caller is KNOWN. It cannot run earlier
  // — there is no user id before the guard answers — and running it here means
  // an unauthenticated hammer never writes into the per-user keyspace at all.
  const userAllowed = await spendBudget(
    "api_v1_pets_register_user",
    userId,
    API_V1_PET_REGISTRATION_USER_LIMIT,
  );
  if (!userAllowed) return apiV1Error("rate_limited", 429);

  // IDENTITY GATE — DEFENCE IN DEPTH, and the server is where the rule lives.
  //
  // This system is an identity registry: the whole point of a credential is
  // that it names a real titular. An account that never completed signup step 2
  // still carries the provisional, email-derived display name the
  // `handle_new_user` trigger writes, and a pet registered under it produces a
  // credential whose owner is a string nobody typed.
  //
  // Two gates already stop somebody REACHING this — the native client's
  // `useGate` sends a `profilePending` account to `identidad-pendiente`, and the
  // web `(app)` layout does the same for a cookie session — and neither is the
  // rule. Both are decisions made by a CLIENT about a screen; this endpoint is
  // independently addressable with a bearer token, and a client's gate has never
  // been an authorization boundary in this repo.
  //
  // Read off `live.profile`, which `requireLiveUser` already resolved, so the
  // gate costs no round-trip. `profile === null` is folded in by
  // `isIdentityPending` (a blank name is pending), which is the state a
  // service-role delete or a half-restored account leaves behind.
  if (isIdentityPending({ displayName: live.profile?.displayName, email: live.user.email })) {
    return apiV1Error("identity_pending", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally (NAME_REQUIRED, SPECIES_REQUIRED, …). This is the backstop for a
  // client out of step with the contract package, which is why it carries no
  // field detail (§2 — the envelope is one key).
  const parsedInput = registerPetInputSchema.safeParse(body);
  if (!parsedInput.success) return apiV1Error("invalid_request", 400);
  const input = parsedInput.data;

  // Province: the ISO code the locality search handed the client, back to its
  // canonical storage name. An unresolvable code never came from that search.
  const province = canonicalProvinceNameForStorage(input.provinceCode);
  if (!province) return apiV1Error("invalid_request", 400);

  // Breed catalog gate (QA A4) — before any DB work, because it needs none.
  const breedResolution = resolveBreedForWrite(input.species, input.breed);
  if (!breedResolution.ok) return apiV1Error("invalid_request", 400);

  // WRAPPED, and it was not (WU-B review FB-2). This is pure in-memory work with
  // one sharp edge: it derives a date of birth with `Date` arithmetic and
  // `toISOString()`, which THROWS a RangeError once the date leaves the
  // representable range. The schema now bounds the inputs that could get it
  // there (MAX_PET_AGE_YEARS), so this catch should be unreachable — which is
  // exactly why it is here rather than trusted away. A throw escaping at this
  // point does not produce the error envelope at all: it produces whatever
  // Next.js renders for an unhandled exception, on a surface whose entire
  // contract is "every failure is `{ error: code }`" (§2). One `try` is a
  // cheaper guarantee than an argument about reachability.
  let parsed: ParsedPet;
  try {
    parsed = buildParsedPet(input, { province, breed: breedResolution.breed });
  } catch (err) {
    reportError("api-v1-pets-build", err);
    return apiV1Error("invalid_request", 400);
  }

  // The three pre-transaction reads, under one budget.
  let resolution: PreWriteResolution;
  try {
    resolution = await withDbBudgetOrThrow(
      resolvePreWrite(parsed, {
        ownerUserId: userId,
        duplicateOverride: input.duplicateOverride,
        // A2-alta-asentar-04: the dedupe scan must not report THIS key's own pet
        // as a duplicate, or a retry after the client's 10 s timeout is answered
        // with "ya tenés una mascota llamada…" instead of the replay 201.
        clientIdempotencyKey: idempotencyKey,
        // A2-alta-asentar-03: the row the person actually tapped, when the
        // client is new enough to say which one it was.
        localityIndecId: input.localityIndecId,
      }),
      RESOLVE_BUDGET_MS,
      "api-v1-pets-resolve",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    // A locality outside the INDEC catalogue for this province. The web shows
    // the validator's own es-AR sentence; this surface answers a code, because a
    // client that reaches it picked something the search never returned.
    if (err instanceof JurisdictionValidationError) return apiV1Error("invalid_request", 400);
    throw err;
  }

  if (resolution.duplicateSuspected) return apiV1Error("duplicate_pet_suspected", 409);

  const result = await registerPet(
    {
      parsed: resolution.parsed,
      potentiallyDangerousBreed: resolution.potentiallyDangerousBreed,
      // No photo and no chip on this transport — see the header.
      uploadedPath: null,
      uploadMimeType: null,
      uploadSize: null,
      clientIdempotencyKey: idempotencyKey,
    },
    {
      repo: PetsRepository,
      actor: { user: { id: userId } },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
    },
  );

  if (!result.ok) {
    // ONE generic code. The use-case's failure arm is an untyped string carrying
    // es-AR prose written for a web form (§3), and it can name internal
    // constraints — putting it on a wire would be a worse answer than saying
    // nothing. Logged in full on this side, where it is useful.
    reportError("api-v1-pets/register", new Error(result.error), { userId });
    return apiV1Error("pet_registration_failed", 500);
  }

  const registered = result.value as NonNullable<typeof result.value>;

  await flushRegistrationNotifications(result.notifications, registered.eventId, userId);

  // 201 on both paths — a replay answers with the FIRST attempt's token and
  // `wasDuplicate: true`. See the header for why that is a success and not a
  // conflict.
  const payload: PetRegisteredV1 = {
    publicToken: registered.publicToken,
    wasDuplicate: registered.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

// ---------------------------------------------------------------------------
// Refusal helpers
// ---------------------------------------------------------------------------

/** The 503 this endpoint answers for every degraded read, with its backoff. */
function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes `/me` and
 * `/me/pets` use. A native client writes one handler for the auth failure space
 * and it works against every endpoint on this surface — which only stays true if
 * the mapping is written once per endpoint and never improvised per branch.
 *
 * `DEACTIVATED` is a refusal here and not a tolerated read: this is a WRITE, and
 * "reads stay open so the user can see why; writes stop" is the repo's policy
 * since the 2026-07-04 redirect incident.
 */
function liveUserRefusal(reason: LiveUserFailureReason) {
  switch (reason) {
    case "NO_SESSION":
      return apiV1Error("auth_expired", 401);
    case "ACCOUNT_ERASED":
      return apiV1Error("account_erased", 403);
    case "DEACTIVATED":
      return apiV1Error("account_deactivated", 403);
    // B9. Reachable but rare on this endpoint: registering an animal is a
    // citizen act, and citizens have no shift. An org staffer registering from
    // a console after eight hours is the case, and the answer is the same one
    // every other endpoint gives — re-authenticate, do not refresh.
    case "SHIFT_EXPIRED":
      return apiV1Error("session_shift_expired", 401);
    case "MAINTENANCE":
      return unavailable();
    default: {
      // Exhaustiveness: a new refusal reason without a branch here is a compile
      // error, not a silent fall-through to a 201.
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * in this repo — including on this write. The limiter is itself a DB write; if
 * `rate_limit_buckets` is unavailable, refusing would stop every citizen in the
 * country registering a pet over an abuse control, while the authorization
 * boundary (`requireLiveUser`) stays intact and fails CLOSED. That is the one
 * that must. Every failure is reported: a limiter that stopped working is an
 * incident even though the request continues.
 *
 * One function for both buckets so the two cannot drift into different failure
 * postures — the per-IP one failing open and the per-user one failing closed
 * would be an invisible difference until the day the table is down.
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
    reportError(`api-v1-pets/${endpoint}`, err);
    return true;
  }
}

/**
 * Post-transaction notification flush. Best-effort and NEVER throws: a failed
 * notification must not turn a committed registration into an error the client
 * retries.
 *
 * Through the notification service rather than a direct insert (the single
 * write-path ratchet, `pnpm lint:notifications`), so each row carries a dedupe
 * key and a dead letter on failure. The key is derived from the EVENT, so even a
 * retry that somehow reached this line twice cannot double-notify.
 *
 * `severity` is remapped because the two vocabularies differ by one member: the
 * pets module's `NewNotification` says `"error"` where the service says
 * `"urgent"`. Nothing today emits `"error"` on this path (the only notification
 * `registerPet` queues is the PPP reminder, a `"warning"`), and the branch is
 * here so a future one cannot fail to compile into silence.
 */
async function flushRegistrationNotifications(
  pending: NewNotification[],
  eventId: string,
  userId: string,
): Promise<void> {
  if (pending.length === 0) return;
  try {
    await createNotificationsBulk(
      pending.map((n) => ({
        ...n,
        severity: n.severity === "error" ? ("urgent" as const) : n.severity,
        dedupeKey: `event:${eventId}:${n.userId}:${n.notificationType}`,
      })),
    );
  } catch (err) {
    reportError("api-v1-pets/notifications", err, { userId });
  }
}

// ---------------------------------------------------------------------------
// Adapter helpers — wire shape in, domain value object out
// ---------------------------------------------------------------------------

/**
 * The wire body as a `ParsedPet`.
 *
 * The web's `parsePetForm` does this from `FormData` and cannot be reused: it
 * reads ~20 `formData.get()` calls and this transport has no FormData. What IS
 * reused is every RULE it encodes — the same age→date-of-birth derivation, the
 * same `birthDateIsEstimated` flag, the same "empty string means absent"
 * treatment. The fields this transport does not accept are set to their absent
 * value explicitly rather than omitted, so a reader can see the whole shape and
 * a new column on `ParsedPet` is a compile error here instead of a silent null.
 */
function buildParsedPet(
  input: {
    name: string;
    species: string;
    sex: "male" | "female" | "unknown";
    color: string | null;
    estimatedWeightKg: string | null;
    ageYears: number | null;
    ageMonths: number | null;
    acquisitionMethod: ParsedPet["acquisitionMethod"];
    localityName: string;
  },
  resolved: { province: string; breed: string | null },
): ParsedPet {
  // Estimated age → an estimated date of birth, byte-identical to the wizard's
  // arithmetic. `birthDateIsEstimated` is what keeps the credential honest about
  // where the date came from; a derived date stored without it would read as a
  // recorded fact.
  let dateOfBirth: string | null = null;
  let birthDateIsEstimated = false;
  if (input.ageYears !== null || input.ageMonths !== null) {
    const totalMonths = (input.ageYears ?? 0) * 12 + (input.ageMonths ?? 0);
    const dob = new Date();
    dob.setMonth(dob.getMonth() - totalMonths);
    dateOfBirth = dob.toISOString().slice(0, 10);
    birthDateIsEstimated = true;
  }

  return {
    name: input.name,
    species: input.species,
    sex: input.sex,
    breed: resolved.breed,
    dateOfBirth,
    birthDateIsEstimated,
    color: input.color,
    // Chip: absent on this transport, and absent means every one of the five
    // columns stays null — the web's parser enforces the same coupling.
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
    estimatedWeightKg: input.estimatedWeightKg,
    favouriteFoods: [],
    knownAllergies: [],
    trainingLevel: null,
    insuranceCompany: null,
    insurancePolicyNumber: null,
    jurisdictionProvince: resolved.province,
    jurisdictionLocality: input.localityName,
    acquisitionMethod: input.acquisitionMethod,
    emergencyInfoVisible: false,
    permanentConditions: [],
    permanentConditionsOther: null,
    discloseConditionsPublicly: false,
    // Registrations through this endpoint are `owner`. Declaring an animal as
    // held in tránsito is a custody claim with its own flow, and the web's
    // minimal alta does not offer it either.
    custodyKind: "owner",
  };
}

type PreWriteResolution = {
  /** `parsed` with the canonical locality and its structural FK filled in. */
  parsed: ParsedPet;
  potentiallyDangerousBreed: boolean;
  duplicateSuspected: boolean;
};

/**
 * The three reads that must happen before anything is written, in the order
 * `createPetAction` runs them.
 *
 * ORDER IS THE CONTRACT. The locality is canonicalized FIRST because the PPP
 * rules are jurisdiction-scoped and would otherwise be resolved against the
 * locality the caller typed rather than the one the registry recognises. The
 * dedupe scan runs BEFORE the classification because a refused registration
 * should cost the cheapest possible work.
 *
 * Throws `JurisdictionValidationError` for an unknown (province, locality) pair
 * — the caller maps it. Deliberately not caught here: a locality this registry
 * does not know is not something a use-case can shrug off.
 */
async function resolvePreWrite(
  parsed: ParsedPet,
  ctx: {
    ownerUserId: string;
    duplicateOverride: boolean;
    clientIdempotencyKey: string;
    localityIndecId: string | null;
  },
): Promise<PreWriteResolution> {
  const normalized = await normalizeLocationForWrite(
    {
      province: parsed.jurisdictionProvince,
      provinceCode: null,
      locality: parsed.jurisdictionLocality,
      // A2-alta-asentar-03. When the client sends the id of the row it showed
      // the person, THAT row is what gets stored — not the alphabetically first
      // department among the homonyms sharing the name.
      localityIndecId: ctx.localityIndecId,
      lat: null,
      lng: null,
      address: null,
    },
    { locality: "strict" },
  );

  const resolved: ParsedPet = {
    ...parsed,
    jurisdictionProvince: normalized.province,
    jurisdictionLocality: normalized.locality,
    // Structural locality-attribution FK (migration 0147).
    localityId: normalized.localityId,
  };

  if (!ctx.duplicateOverride) {
    const duplicate = await findSameOwnerDuplicatePet({
      ownerUserId: ctx.ownerUserId,
      name: resolved.name,
      species: resolved.species,
      sex: resolved.sex,
      // The pet this very key already created is a REPLAY, not a duplicate. See
      // the parameter's own docblock — this is A2-alta-asentar-04, and without
      // it the retry the endpoint promises is safe answers 409.
      excludeClientIdempotencyKey: ctx.clientIdempotencyKey,
    });
    if (duplicate) {
      return { parsed: resolved, potentiallyDangerousBreed: false, duplicateSuspected: true };
    }
  }

  const potentiallyDangerousBreed = await resolvePppClassificationForJurisdiction(
    resolved.species,
    resolved.breed,
    parseEstimatedWeightKg(resolved.estimatedWeightKg),
    {
      country: "AR",
      province: resolved.jurisdictionProvince,
      locality: resolved.jurisdictionLocality,
    },
  );

  return { parsed: resolved, potentiallyDangerousBreed, duplicateSuspected: false };
}

/**
 * The domain layer's `estimatedWeightKg: string | null` as the `number | null`
 * the PPP classifier expects. A malformed string is treated as "no weight data",
 * exactly as `createPetAction` treats it — never a throw, because a weight is
 * not a reason to refuse a registration.
 */
function parseEstimatedWeightKg(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? null : n;
}
