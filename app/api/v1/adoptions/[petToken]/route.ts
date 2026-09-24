// `/api/v1/adoptions/{petToken}` — LA FICHA, and postularse.
//
// GET is one adoption listing: the same four answers `/adoptar/{petToken}`
// gives, with the state on the wire instead of in the choice of page. POST is
// the application.
//
// ONE PATH, TWO METHODS — the shape `pets/{token}/profile` and `me/privacy`
// already use. A `/applications` sub-path would be a second URL to authorize,
// to rate-limit and to keep in step with the first, for one command.
//
// THE FOUR ANSWERS ARE NOT THREE
// ---------------------------------------------------------------------------
// A listed pet renders. A pet adopted in the last seven days answers
// `recently_adopted`. A pet the org paused answers `paused`. Everything else is
// 404 — a token that resolves to nothing, a pet that was never listable, and an
// ERASED pet, which answers exactly like a token that never existed (art. 16,
// Ley 25.326; `unerasedPetByToken` inside the repository is what makes that
// true, and this is the surface where a fifth soft-delete leak would have gone).
//
// The two soft answers exist because somebody followed a shared link, which is
// the whole case spec D7.2 was written for. Flattening them into 404 would tell
// a person holding a WhatsApp message that the animal never existed.
//
// TWO FAMILIES, AND ONE OF THEM IS NEW
// ---------------------------------------------------------------------------
// GET joins `authenticated-read` and shares `api_v1_adoptions_read_ip` with the
// catalogue, because scrolling a list and tapping a card is one act on one
// public catalogue.
//
// POST gets its OWN family, `adoption-application`. `authenticated-write`'s
// ceiling is derived from what it costs to hand somebody an animal — "one person
// editing their own records" — and this write is not that: it lands a free-text
// letter about a stranger in a shelter's review queue and fans out to up to 25
// of its members. The per-IP half is derived in `lib/infra/api-v1-limits.ts`
// with every other bucket on this surface; the per-USER anchor it is 12× of, and
// why the abuse it bounds is BREADTH rather than hammering, is in
// `src/modules/adoption/application/adoption-application-limits.ts`.
//
// THE PER-USER BUDGET IS NOT SPENT HERE, deliberately: it lives inside
// `submitAdoptionApplication` so the web form and this endpoint spend ONE
// counter. A ceiling that belongs to the transport is a ceiling a caller
// escapes by using the other door.

import {
  ADOPTION_DETAIL_PAYLOAD_VERSION,
  ADOPTION_DETAIL_STALE_AFTER_MS,
  type AdoptionApplicationSubmittedV1,
  type AdoptionDetailV1,
} from "@dim/contract/api";
import { adoptionApplicationInputSchema } from "@dim/contract/input";

import { db } from "@/db";
import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_ADOPTION_APPLICATION_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { ADOPTION_APPLICATION_RATE_LIMITED_COPY } from "@/src/modules/adoption/application/adoption-application-limits";
import {
  buildAdoptionDetailClosed,
  buildAdoptionDetailListed,
} from "@/src/modules/adoption/application/adoption-payloads";
import { submitAdoptionApplication } from "@/src/modules/adoption/application/submit-adoption-application";
import { readAdoptionDetail } from "@/src/modules/adoption/infrastructure/adoption-detail-read";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { flushAdoptionNotifications } from "@/src/modules/adoption/infrastructure/notification-flush";

export const dynamic = "force-dynamic";

const AUTH_BUDGET_MS = 5_000;
const DETAIL_BUDGET_MS = 8_000;

// AUTHORIZED, not opted out: the handler calls requireLiveUser in its own body
// and that call IS the authorization. Said here for a reader scanning for the
// guard — and said WITHOUT writing the opt-out marker.
export async function GET(request: Request, context: { params: Promise<{ petToken: string }> }) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_adoptions_read_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  // In the handler body for the reason the sibling route's copy is — see the
  // note there. Two calls, not one shared helper, because the fence that keeps
  // this URL honest cannot see through a function.
  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-adoption-detail-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  // PER-USER BUDGET, spent only once the caller is KNOWN — same bucket
  // `adoptions/route.ts:122-130` spends, because this ficha and the catalogue
  // answer one question about one public listing, and a person scrolling a
  // list and tapping a card is one act. Reusing the bucket, not inventing one,
  // is what "shares with the catalogue" in this file's own docblock means.
  if (
    !(await spendBudget(
      "api_v1_adoptions_read_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  const { petToken } = await context.params;

  let found: Awaited<ReturnType<typeof readAdoptionDetail>>;
  try {
    found = await withDbBudgetOrThrow(
      readAdoptionDetail(petToken),
      DETAIL_BUDGET_MS,
      "api-v1-adoption-detail",
    );
  } catch (err) {
    // 503, NEVER 404. Answering "not found" to a read that failed is what the
    // contract calls the worst lie a public surface can tell — here it would
    // report an animal as gone to somebody who is looking for it.
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }

  if (found.state === "gone") return apiV1Error("not_found", 404);

  const envelope = apiV1Envelope({
    payloadVersion: ADOPTION_DETAIL_PAYLOAD_VERSION,
    staleAfterMs: ADOPTION_DETAIL_STALE_AFTER_MS,
  });

  if (found.state !== "listed") {
    const payload: AdoptionDetailV1 = {
      ...envelope,
      detail: buildAdoptionDetailClosed({
        state: found.state,
        petToken: found.petToken,
        name: found.name,
        orgName: found.state === "paused" ? found.orgName : null,
      }),
    };
    return apiV1Json(payload, { status: 200 });
  }

  // WHY THE SERVER ANSWERS "CAN I APPLY" INSTEAD OF THE CLIENT DECIDING.
  // `pets/{token}/profile` set the rule for this surface — a client must never
  // draw a control the write would refuse — and both refusals here need state
  // the phone does not have: whether this account is institutional, and whether
  // it already has an unresolved application for THIS animal. Recomputing
  // either on the client would be a second implementation of a rule the
  // use-case owns, and it would be wrong in the direction that shows a person a
  // form and then throws their letter away.
  const [profile, existing] = await Promise.all([
    AdoptionRepository.findApplicantProfile(live.user.id),
    AdoptionRepository.findExistingApplication(found.petId, live.user.id),
  ]);
  const institutional = profile?.accountType === "institutional";
  const blockedReason = institutional
    ? ("institutional_account" as const)
    : existing
      ? ("already_applied" as const)
      : null;

  const payload: AdoptionDetailV1 = {
    ...envelope,
    detail: buildAdoptionDetailListed({
      pet: found.pet,
      org: found.org,
      photoUrls: found.photoUrls,
      health: found.health,
      livesWithFamily: found.livesWithFamily,
      custodySince: found.custodySince,
      canApply: blockedReason === null,
      applyBlockedReason: blockedReason,
    }),
  };
  return apiV1Json(payload, { status: 200 });
}

// AUTHORIZED, not opted out: requireLiveUser in the handler body below.
export async function POST(request: Request, context: { params: Promise<{ petToken: string }> }) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  if (
    !(await spendBudget(
      "api_v1_adoption_apply_ip",
      callerIp(request.headers),
      API_V1_ADOPTION_APPLICATION_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-adoption-apply-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return apiV1Error("temporarily_unavailable", 503);
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  const { petToken } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  // The client validated against this schema first and got per-field codes
  // locally. This is the backstop for a client out of step with the contract,
  // which is why it carries no field detail — the envelope is one key. The
  // DOMAIN validates again inside the use-case, and that is not redundancy:
  // this parse decides the shape, `validateApplicationInput` decides the rules,
  // and the web door only ever passes the second.
  const parsed = adoptionApplicationInputSchema.safeParse(body);
  if (!parsed.success) return apiV1Error("invalid_request", 400);

  // NO `Idempotency-Key`, AND THE ENDPOINT ASKS FOR NONE. The use-case refuses a
  // second unresolved application for the same (pet, applicant) pair on its own
  // — `findExistingApplication` — so a retry after a timeout that in fact landed
  // is refused rather than duplicated. That is a stronger guarantee than a key
  // buys and it is why nothing here reads the header: asking for one the server
  // would ignore is a client believing it holds a promise nobody made.
  // THE TRY IS WHAT MAKES `adoption_application_failed` REACHABLE, and until it
  // was written that code was declared in `@dim/contract/api`, documented at
  // length, given es-AR copy in the app, and produced by nothing.
  //
  // What actually happened when the write failed was worse than a missing code.
  // `submitAdoptionApplication` returns `{ ok: false }` only for its DOMAIN
  // refusals; a transaction that throws — the pooler saturated, a constraint
  // nobody expected, `insertApplication` failing on the spine — propagates out
  // of the handler, and Next's default 500 is not the one-key `{ error: … }`
  // envelope every `/api/v1` failure is required to be. So a client hitting a
  // database fault got a body it could not parse on the one surface whose whole
  // contract is that it always can.
  //
  // 500 AND NOT 409: the caller did nothing wrong, and the distinction is what
  // the app's copy turns into "volvé a intentar" rather than "volvé a la ficha
  // para ver por qué". Retrying really is safe, and for a stronger reason than
  // most: if the first attempt in fact landed, the retry meets the
  // duplicate-pending refusal and comes back 409 — never a second letter in the
  // shelter's queue.
  let result: Awaited<ReturnType<typeof submitAdoptionApplication>>;
  try {
    result = await submitAdoptionApplication(
      {
        petPublicToken: petToken,
        housingType: parsed.data.housingType,
        otherPets: parsed.data.otherPets ?? null,
        dailyRoutine: parsed.data.dailyRoutine ?? null,
        notes: parsed.data.notes ?? null,
        profileSharingConsent: parsed.data.profileSharingConsent,
        motivation: parsed.data.motivation,
        priorPets: parsed.data.priorPets,
      },
      {
        repo: AdoptionRepository,
        applicant: { userId: live.user.id },
        transaction: db.transaction.bind(db),
      },
    );
  } catch (err) {
    reportError("api-v1-adoptions/submit", err);
    return apiV1Error("adoption_application_failed", 500);
  }

  if (!result.ok) {
    // ONE EXCEPTION FIRST, AND IT IS NOT A REFUSAL (A5-ciudadanas-02). The
    // use-case spends the applicant's own budget and reports an exhausted one as
    // one more `{ ok: false }`, so a 429 came back through this door as
    // `adoption_application_refused` 409 — which the app renders as "El refugio
    // no pudo tomar tu postulación. Volvé a la ficha para ver por qué." Three
    // things are wrong with that sentence and only one of them is tone: it
    // blames the SHELTER for a limit the registry imposed, it sends the person
    // back to a ficha whose `canApply` is still true and still offers
    // "Postularme", and every retry spends more of the budget that is the actual
    // problem. The real answer — wait — is never said.
    //
    // IDENTITY ON AN EXPORTED CONSTANT, not a match on prose. The comparison
    // below is `===` against the very string the use-case returned, imported
    // from the module that owns it, so a reworded sentence changes both sides at
    // once. That is what keeps this from being the copy-parsing the paragraph
    // below forbids — a `.includes("postulaciones")` here WOULD be it.
    if (result.error === ADOPTION_APPLICATION_RATE_LIMITED_COPY) {
      // NO `retry-after`, deliberately, and byte-identical to the per-IP branch
      // at the top of this handler: `apiV1Error`'s own docblock records why the
      // two rate-limit answers must not differ ("only one of them could set an
      // honest value, and the pair must stay byte-identical so the response
      // never says which budget ran out"). The ledger asked for a retry-after;
      // the invariant is older and the honest value is unknown here anyway —
      // the use-case's verdict is `"denied"` and does not say which of the
      // three windows (5/min, 15/hr, 30/day) filled.
      return apiV1Error("rate_limited", 429);
    }
    // ONE CODE FOR EVERY OTHER DOMAIN REFUSAL, and the coarseness is argued in
    // `@dim/contract/api`'s `errors.ts` rather than here: the use-case returns
    // es-AR PROSE, so a route that mapped its sentences onto codes would be
    // parsing copy. The sentence is not forwarded either — it is written for
    // the web form's inline error and half of it names fields this door already
    // validated. `canApply` on the READ is what pays that down.
    return apiV1Error("adoption_application_refused", 409);
  }

  // POST-TRANSACTION AND BEST-EFFORT, exactly as the web action flushes them: a
  // notification that fails to insert must not roll back an application that
  // landed on the spine.
  await flushAdoptionNotifications(result.notifications);

  const payload: AdoptionApplicationSubmittedV1 = {
    applicationId: result.value?.eventId ?? "",
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Spend one rate-limit budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN, on BOTH methods, and the write's case is the one worth stating.
 * This is the per-IP bucket, whose job is to refuse an unauthenticated hammer
 * before the GoTrue round-trip — not to bound the act. The bucket that bounds
 * the act is the per-APPLICANT one inside `submitAdoptionApplication`, and THAT
 * one fails CLOSED. So a limiter outage does not open unmetered writes into a
 * shelter's queue; it opens a wider pipe to a counter that is still refusing.
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
    reportError(`api-v1-adoptions/${endpoint}`, err);
    return true;
  }
}

/** The liveness refusals, mapped as every sibling on this surface maps them. */
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
      return apiV1Error("temporarily_unavailable", 503);
    default: {
      const unhandled: never = reason;
      throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}
