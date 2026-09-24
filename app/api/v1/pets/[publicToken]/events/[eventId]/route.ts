// `GET /api/v1/pets/{publicToken}/events/{eventId}` — one asiento, in full.
//
// The row a client tapped in the libreta, opened: the curated field set, when
// it happened and when it was written, who signed it, every correction it has
// received, and its files. It is `/mis-mascotas/{token}/eventos/{eventId}` on
// the web, over a bearer token.
//
// WHO MAY READ IT — the resolved rule
// ---------------------------------------------------------------------------
// `resolvePetHolderAccess`, the same function the libreta, the owner face and
// the web page use. Every current HOLDER (owner, co_owner, foster, caretaker)
// plus any active member of an organization that holds the pet. Anything else
// is 404 — including an event id that is real but belongs to ANOTHER animal,
// because every query in the reader carries `pet_id` and a caller who holds pet
// A must not be able to read pet B's clinical record by passing its event id.
//
// A MALFORMED EVENT ID IS ALSO 404, not a 400. `pet_events.id` is a Postgres
// `uuid`, so a non-uuid raises `22P02` inside the query — the failure this
// repo's `requireUuidParam` exists for, which on the web surfaced as an error
// boundary under HTTP 200. Here it would surface as a 500 for a stale link. It
// resolves to nothing the caller may see, which is exactly what `not_found`
// means.
//
// THE ONE ENDPOINT ON THIS SURFACE THAT HANDS OVER A FILE
// ---------------------------------------------------------------------------
// Until now no `/api/v1` route returned a signed URL at all — every private
// attachment in the product is signed inside an RSC page body, which is why no
// non-browser client could read one (RN-4 finding A1). This closes it, and it
// does so deliberately narrowly:
//
//   · ONE SCREEN'S files, not a timeline's. The libreta reports that a record
//     CARRIES a file and mints nothing; a client that wants the file opens this.
//   · A SHORT life, stated on the wire. `EVENT_ATTACHMENT_LINK_TTL_SECONDS` is
//     fifteen minutes — a quarter of the web's hour, because the web re-mints on
//     every render and a phone holds this payload for the life of a screen. The
//     same number that goes to the signer is what `expiresAt` is computed from,
//     so a client rendering the expiry is reading the real one.
//   · Signed as SERVICE ROLE, with the authorization here. The bucket has had no
//     authenticated SELECT policy since migration 0172 (the policy was
//     `bucket_id = 'event-attachments'` — true for every object in the country),
//     so the guard above and the pet fence inside the reader ARE the access
//     check. Calling the signer is equivalent to handing over the file.
//
// A signed URL must not reach a log or a cache that outlives it. Nothing in this
// handler logs the payload, and the contract tells the client the same thing.
//
// GET ONLY. The correction this screen offers is a WRITE and lives at
// `./amend`; this file must not grow one.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_USER_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { withholdUnreadableDecomisoEvidence } from "@/lib/infra/decomiso-evidence-access";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { eventAttachmentSignedUrl } from "@/lib/infra/storage";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { isUuid } from "@/lib/utils/uuid";
import { readTitularTenures } from "@/src/modules/events/application/amendment/amend-authorship";
import { loadPetEventDetail } from "@/src/modules/events/application/read/load-pet-event-detail";
import type { EventAttachmentV1 } from "@dim/contract/api";
import { buildAttachments, buildPetEventDetailV1 } from "./payload";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one indexed profile read. */
const AUTH_BUDGET_MS = 5_000;

/** The two access queries — both indexed, both single-row. */
const ACCESS_BUDGET_MS = 5_000;

/**
 * The event, its correction chain and its attachment rows.
 *
 * Narrower than the libreta's budget because the fan-out is: one indexed
 * single-row read plus two small pet-scoped reads. Long enough that a degraded
 * pooler answers 503 rather than hanging.
 */
const DETAIL_BUDGET_MS = 5_000;

/**
 * Signing runs against Supabase Storage, not Postgres, so it gets its own
 * deadline: a slow object store must degrade the ATTACHMENTS SECTION and not
 * the record. A client that could not read the files still gets the asiento,
 * and the section says which of the two happened.
 */
const SIGN_BUDGET_MS = 5_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// THE AUTHENTICATED-READ FAMILY — numbers in lib/infra/api-v1-limits.ts.
// ---------------------------------------------------------------------------
// The argument for them was this file's own: "the same numbers as the libreta and
// the owner face — a client that opens a ledger and taps three rows spends one
// budget, not three." Its own BUCKET NAME is kept, so the limiter's storage can
// still say which surface is being hammered.

// AUTHORIZED, not opted out: this handler calls requireLiveUser and then
// resolvePetHolderAccess in its own body, and those two calls ARE the
// authorization. Said here for a reader scanning for the guard — and said
// WITHOUT writing the opt-out marker, because a comment that spells the marker
// in order to deny it still reads as one to a scanner matching the token.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicToken: string; eventId: string }> },
) {
  const { publicToken, eventId } = await params;

  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  try {
    await enforceRateLimit(
      "api_v1_pet_event_detail_ip",
      callerIp(request.headers),
      API_V1_AUTHENTICATED_READ_IP_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    // FAIL OPEN — the limiter is itself a DB write, and the access guard below
    // is the one that fails closed.
    console.error("[api-v1-pet-event-detail] IP rate limiter unavailable, failing open:", err);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-pet-event-detail-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  try {
    await enforceRateLimit(
      "api_v1_pet_event_detail_user",
      live.user.id,
      API_V1_AUTHENTICATED_READ_USER_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
    console.error("[api-v1-pet-event-detail] user rate limiter unavailable, failing open:", err);
  }

  // Checked AFTER the guards and BEFORE any query — see the header. It costs
  // nothing and it is what keeps a stale link from becoming a 500.
  if (!isUuid(eventId)) return apiV1Error("not_found", 404);

  let access: Awaited<ReturnType<typeof resolvePetHolderAccess>>;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(publicToken, live.user.id),
      ACCESS_BUDGET_MS,
      "api-v1-pet-event-detail-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (access.kind === "none") return apiV1Error("not_found", 404);

  let read: Awaited<ReturnType<typeof loadPetEventDetail>>;
  // The viewer's titular-side tenures, for the legacy null-author half of the
  // authorship rule (PO decision 3B) — read alongside the record, inside the
  // same budget. The org path is never offered a correction, so it skips it.
  let titularTenures: Awaited<ReturnType<typeof readTitularTenures>> = [];
  try {
    [read, titularTenures] = await withDbBudgetOrThrow(
      Promise.all([
        loadPetEventDetail({ petId: access.pet.id, eventId }),
        access.kind === "owner"
          ? readTitularTenures(access.pet.id, live.user.id)
          : Promise.resolve([]),
      ]),
      DETAIL_BUDGET_MS,
      "api-v1-pet-event-detail-load",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // No such event, or an event of another animal. The two answer identically,
  // which is what stops this becoming a probe for which event ids are real.
  if (!read) return apiV1Error("not_found", 404);

  const now = new Date();
  const attachments = await signOrDegrade(read.attachments, eventId, live.user.id, now);

  return apiV1Json(
    buildPetEventDetailV1({
      publicToken: access.pet.publicToken,
      petStatus: access.pet.status,
      accessPath: access.kind === "owner" ? "owner" : "org",
      viewer: {
        userId: live.user.id,
        titularTenures,
      },
      read,
      attachments,
      now,
    }),
    { status: 200 },
  );
}

/**
 * The signed attachment list, or `null` when Storage could not be reached in
 * time.
 *
 * `null` becomes an `unavailable` SECTION rather than a failed request: a
 * record whose files could not be signed is still a record worth reading, and
 * an empty list would tell the owner their vaccine card was never attached.
 */
async function signOrDegrade(
  rows: NonNullable<Awaited<ReturnType<typeof loadPetEventDetail>>>["attachments"],
  eventId: string,
  viewerUserId: string,
  now: Date,
): Promise<EventAttachmentV1[] | null> {
  if (rows.length === 0) return [];
  try {
    return await withDbBudgetOrThrow(
      (async () => {
        // Decomiso evidence keeps its metadata (PO decision D7): withheld
        // unless the viewer reads the decomiso itself, not merely the pet.
        const visible = await withholdUnreadableDecomisoEvidence(
          rows.map((row) => ({ ...row, eventId })),
          viewerUserId,
        );
        return buildAttachments(visible, eventAttachmentSignedUrl, now);
      })(),
      SIGN_BUDGET_MS,
      "api-v1-pet-event-detail-sign",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return null;
    throw err;
  }
}

/** The 503 this endpoint answers for every degraded read, with its backoff. */
function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses, so a native client writes ONE handler for the
 * auth failure space.
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
