// `GET /api/v1/pets/{publicToken}` — the OWNER face of one pet, over bearer auth.
//
// THIS IS NOT THE CREDENTIAL. `/api/v1/pets/{publicToken}/credential` is the
// anonymous public document and renders IDENTICALLY for the owner and for a
// stranger who scanned the QR. This is what the person RESPONSIBLE for the
// animal sees: the alert strip, the compliance stamp, the reminders coming due,
// the arrangements they made. A client shows both; neither replaces the other,
// and the credential endpoint is untouched by this file.
//
// WHO MAY READ IT — the resolved rule
// ---------------------------------------------------------------------------
// Exactly what the web page at `/mis-mascotas/{publicToken}` enforces, because
// it is the same function: `resolvePetHolderAccess`, which
// `requirePetAccess` (the cookie-session door) also calls. Verified against that
// page's behaviour rather than assumed. In words:
//
//   · OWNER PATH — the caller has an ACTIVE `ownerships` row on this pet, in
//     ANY holder role: owner, co_owner, foster or caretaker. Access is not
//     titular-only. When several rows exist the most privileged wins, ranked
//     deterministically, because a user who is both owner and caretaker of one
//     animal is reachable and must not resolve at random.
//   · ORG PATH — the caller is an ACTIVE member (`leftAt IS NULL`) of an
//     organization that itself holds an active ownership row on the pet, in any
//     role (shelter_custody, foster, or owner).
//   · Anything else is a 404, deliberately: a permission denial and a
//     nonexistent pet answer identically, so this endpoint cannot be used to
//     probe which tokens exist.
//
// The titular-only surfaces are a strict SUBSET and stay behind
// `viewer.isTitular` in the payload — a caretaker gets the face, not the
// arrangements the owner made about them.
//
// GET ONLY. Every write on this animal (edit identity, mark lost, designate a
// caretaker) is titular-gated and lives on its own endpoint; none of them are
// here, and this file must not grow one.

import { ownerPetDetailPorts } from "@/app/_composition/owner-pet-detail-ports";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { loadOwnerPetDetail } from "@/src/modules/pets/application/read/load-owner-pet-detail";
import { buildOwnerPetDetailV1 } from "./payload";
import { resolvePostAdoptionCheckin } from "./post-adoption-checkin";
import { resolvePppRegistries } from "./ppp-registries";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The two access queries — both indexed, both single-row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The owner face itself: three stages of fan-out over a pet's spine, its
 * jurisdiction rules, its cases and the household carousel.
 *
 * Longer than the auth budget because this is genuinely the widest read outside
 * the dashboards — the page it was extracted from wraps the same work in its own
 * timeout for the same reason. Short enough that a degraded pooler produces a
 * 503 a client can retry rather than a spinner it cannot.
 */
const DETAIL_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// THE AUTHENTICATED-READ FAMILY — and the sentence that proves it always was
// ---------------------------------------------------------------------------
// The numbers and the carrier-NAT arithmetic live in lib/infra/api-v1-limits.ts.
// What was specific to this file is kept, because it is the record of a claim
// that turned out to be true and then went unhonoured for two days.
//
// The per-IP ceiling here was 60/min + 600/hr and its docblock said: "Byte-
// identical to `/me/pets`, and identical ON PURPOSE rather than by copy-paste: a
// client that opens a list and then taps into a pet calls both at the same
// moments, so one number bounds both and a client author has one budget to reason
// about." WU-EAS-2 then moved `/me/pets` to 600/min and left this one at 60 — so
// the client that opens a list and taps into a pet met two numbers an order of
// magnitude apart, one screen apart. That is the cliff, and a literal beside one
// of two siblings is how "one number bounds both" became a sentence nothing kept.
//
// What did NOT change: the pairing or the ordering. The IP bucket runs first,
// before the GoTrue round-trip, because that is what bounds a hammer cheaply. The
// USER bucket runs after the guard, because there is no user id before it.

// AUTHORIZED, not opted out: this handler calls requireLiveUser and then
// resolvePetHolderAccess in its own body, and those two calls ARE the
// authorization. Said here for a reader scanning for the guard — and said
// WITHOUT writing the opt-out marker, because a comment that spells the marker
// in order to deny it still reads as one to a scanner matching the token.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  // Free: a regex over one header. Doing it before the limiter means a client
  // that forgot the header costs the platform no counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do.
  try {
    await enforceRateLimit(
      "api_v1_pet_detail_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN, deliberately — the same direction `/me/pets` chose. The limiter
    // is itself a DB write; if it cannot answer, refusing here would blank every
    // owner's pet over an abuse control on a read that discloses only animals
    // the caller already holds. The access guard below fails CLOSED, and that is
    // the one that must.
    console.error("[api-v1-pet-detail] IP rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-pet-detail-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    throw err;
  }

  if (!live.ok) {
    switch (live.reason) {
      case "NO_SESSION":
        return apiV1Error("auth_expired", 401);
      case "ACCOUNT_ERASED":
        return apiV1Error("account_erased", 403);
      case "DEACTIVATED":
        return apiV1Error("account_deactivated", 403);
      case "SHIFT_EXPIRED":
        return apiV1Error("session_shift_expired", 401);
      case "MAINTENANCE":
        return apiV1Error("temporarily_unavailable", 503, {
          "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
        });
      default: {
        const unhandled: never = live.reason;
        throw new Error(`Unhandled liveness refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // Per-user budget, spent only once the caller is KNOWN. It cannot run earlier
  // — there is no user id before the guard answers — so an unauthenticated
  // hammer never writes into the per-user keyspace at all.
  try {
    await enforceRateLimit(
      "api_v1_pet_detail_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    console.error("[api-v1-pet-detail] user rate limiter unavailable, failing open:", err);
  }

  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-pet-detail-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    throw err;
  }

  // A pet this caller may not read and a pet that does not exist answer
  // IDENTICALLY. Anything else turns this endpoint into an oracle for which
  // tokens are real.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const accessPath = access.kind === "owner" ? "owner" : "org";

  let detail: Awaited<ReturnType<typeof loadOwnerPetDetail>>;
  try {
    detail = await withDbBudgetOrThrow(
      loadOwnerPetDetail(
        {
          user: { id: live.user.id },
          pet: access.pet,
          accessPath,
          // The guard RANKED this row (owner < co_owner < foster < caretaker)
          // because one user can hold two on one animal. The reader used to
          // re-query it with no ORDER BY and resolve at random — see
          // `OwnerPetDetailInput.holderRole`.
          holderRole: access.kind === "owner" ? access.holderRole : null,
        },
        ownerPetDetailPorts,
      ),
      DETAIL_BUDGET_MS,
      "api-v1-pet-detail-load",
    );
  } catch (err) {
    // NOT an empty face. A read that failed and an animal with nothing to report
    // are different facts; a client that renders "sin avisos" over a pooler
    // outage tells an owner everything is fine when the server does not know
    // that. 503, same as every other degraded read on this surface.
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    throw err;
  }

  const payload = buildOwnerPetDetailV1({
    publicToken: access.pet.publicToken,
    petStatus: access.pet.status,
    pregnancyStatus: access.pet.pregnancyStatus ?? null,
    accessPath,
    detail,
    pppRegistries: await resolvePppRegistries(access.pet),
    postAdoptionCheckin: await resolvePostAdoptionCheckin({
      kind: access.kind,
      petId: access.pet.id,
      userId: live.user.id,
    }),
    now: new Date(),
  });

  return apiV1Json(payload, { status: 200 });
}
