// `/api/v1/me/privacy` — the two rights Ley 25.326 gives a person over their own
// file, from the phone.
//
//   GET  → art. 14, acceso. Hand the subject their file.
//   POST → art. 16, supresión. End the account.
//
// WHY THIS EXISTS AT ALL, GIVEN THAT PLAY IS ALREADY SATISFIED
// ---------------------------------------------------------------------------
// The app has shipped a link to `/cuenta/privacidad` since the Play submission
// and that link meets the store's data-deletion rule. So this is NOT a
// compliance fix; it is the upgrade `apps/mobile/src/config/api.ts` named and
// then declined to build in a hurry, and its docblock is worth reading before
// this one — it lists the two costs the browser link accepts (the person
// re-authenticates in a signed-out tab, and the app cannot know the deletion
// happened) and says the honest fix is an endpoint, not a thinner second
// definition of "delete my account" written to satisfy a checklist.
//
// The endpoint is that fix, and it is only defensible because it is NOT a second
// definition: both handlers below call the same use-cases the web buttons call,
// and everything between the guard and the database — six ordered steps for the
// erasure, one RPC for the export, one shared per-user budget each — lives in
// `src/modules/auth/application/subject-rights/`. What differs here is the door.
//
// WHY ONE URL AND NOT `DELETE /api/v1/me`
// ---------------------------------------------------------------------------
// That is the shape the config file predicted, and it fits one of the two rights.
// A DELETE cannot carry "hand me my file", and there is no verb on `/me` that
// means it — so the alternative was two URLs with two bearer checks, two limiter
// pairs and two liveness guards kept in step by hand. `pets/{token}/profile`
// already refused that trade for the same reason. See `@dim/contract/api`'s
// `my-privacy.ts` for the full argument.
//
// TWO FAMILIES, TWO ORDERS OF MAGNITUDE APART, AND THAT IS ON PURPOSE
// ---------------------------------------------------------------------------
// The numbers and their derivations are in `lib/infra/api-v1-limits.ts`; the
// short version is that the per-IP buckets here bound an UNAUTHENTICATED hammer
// and nothing else, so the read takes the ordinary authenticated-read ceiling
// and the write takes `account-security` — the family `revoke-sessions` was
// derived for, and the same kind of act.
//
// WHAT ACTUALLY BOUNDS EITHER RIGHT is the per-USER budget, and it is NOT in
// this file. It lives in the use-case, so the web button and this endpoint spend
// one budget instead of two — the lesson `revoke-sessions.ts` recorded on
// 2026-08-25, where a ceiling that belonged to the transport was a ceiling a
// caller escaped by using the other door. Before WU-R neither surface had one at
// all.
//
// NO Idempotency-Key ON THE WRITE, and it is a decision. The header is required
// on `POST /api/v1/pets` because a retried registration creates a SECOND ANIMAL.
// A supresión has no second copy to create: the RPC is idempotent on the state,
// and after a successful one the token in the caller's hand is dead, so the
// retry lands on 401 rather than on a second erasure. Demanding a key would add
// a failure mode to a legal right in exchange for nothing.

import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import {
  API_V1_ACCOUNT_SECURITY_IP_LIMIT,
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
} from "@/lib/infra/api-v1-limits";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { createClientFromBearer } from "@/lib/supabase/bearer";
import { eraseSubjectDataFor } from "@/src/modules/auth/application/subject-rights/erase-subject-data";
import { exportSubjectDataFor } from "@/src/modules/auth/application/subject-rights/export-subject-data";
import {
  MY_PRIVACY_PAYLOAD_VERSION,
  MY_PRIVACY_STALE_AFTER_MS,
  type MySubjectDataExportV1,
  type SubjectDataErasedV1,
} from "@dim/contract/api";
import { subjectRightsCommandInputSchema } from "@dim/contract/input";

export const dynamic = "force-dynamic";

/** One GoTrue round-trip plus one memoized profile read. */
const AUTH_BUDGET_MS = 5_000;

/**
 * The export RPC walks every table that holds the subject's data — fifteen-odd
 * reads keyed on one user id, all indexed, but genuinely more than the single
 * lookup every other read on this surface makes. Twenty seconds is the ceiling
 * at which a phone has already given up (`REQUEST_TIMEOUT_MS` is 10s client-side
 * and it retries), so this bounds the SERVER's willingness to keep a connection
 * busy rather than the client's patience.
 */
const EXPORT_BUDGET_MS = 20_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

// AUTHORIZED, not opted out: both handlers call requireLiveUser in their own
// bodies and those calls ARE the authorization. Said WITHOUT writing the opt-out
// marker, because a comment that spells the marker in order to deny it still
// reads as one to a scanner matching the token (see /api/v1/me for the
// measurement).
export async function GET(request: Request) {
  // Free: a regex over one header, before any counter write.
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do (check-api-guard-headers).
  if (
    !(await spendIpBudget(
      "api_v1_me_privacy_read_ip",
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
      "api-v1-me-privacy-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
  if (!live.ok) return liveUserRefusal(live.reason);

  // NO PER-USER BUCKET HERE. It is spent inside `exportSubjectDataFor`, shared
  // with the web button — see the header.
  let result: Awaited<ReturnType<typeof exportSubjectDataFor>>;
  try {
    result = await withDbBudgetOrThrow(
      exportSubjectDataFor({ userId: live.user.id, supabase: client.supabase }),
      EXPORT_BUDGET_MS,
      "api-v1-me-privacy-export",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  if (!result.ok) {
    // A throttle is not an outage. Answering 503 to one would tell a phone the
    // platform is broken while it works exactly as designed — and this endpoint
    // is the one where that mistake matters most, because the person on the
    // other side is exercising a legal right and deserves to know whether to
    // wait or to complain.
    if (result.reason === "rate_limited") return apiV1Error("rate_limited", 429);
    return apiV1Error("export_failed", 500);
  }

  const payload: MySubjectDataExportV1 = {
    ...apiV1Envelope({
      payloadVersion: MY_PRIVACY_PAYLOAD_VERSION,
      staleAfterMs: MY_PRIVACY_STALE_AFTER_MS,
    }),
    subject: result.data,
  };

  // `staleAfter === issuedAt` by construction (MY_PRIVACY_STALE_AFTER_MS is 0),
  // which is how this payload tells every client on this surface "already stale,
  // never reuse me" without inventing a rule of its own. The response is
  // `no-store` anyway — apiV1Json sets it — so nothing between here and the
  // phone keeps a copy either.
  return apiV1Json(payload, { status: 200 });
}

export async function POST(request: Request) {
  const client = createClientFromBearer(request.headers.get("authorization"));
  if (!client.ok) {
    return apiV1Error(client.reason === "MISSING" ? "auth_required" : "auth_expired", 401);
  }

  // In the handler body for the same reason the read's copy is — see the note
  // there. Two calls, not one shared helper, because the fence that keeps this
  // URL honest cannot see through a function.
  if (
    !(await spendIpBudget(
      "api_v1_me_privacy_write_ip",
      callerIp(request.headers),
      API_V1_ACCOUNT_SECURITY_IP_LIMIT,
    ))
  ) {
    return apiV1Error("rate_limited", 429);
  }

  let live: Awaited<ReturnType<typeof requireLiveUser>>;
  try {
    live = await withDbBudgetOrThrow(
      requireLiveUser({ supabase: client.supabase, accessToken: client.token }),
      AUTH_BUDGET_MS,
      "api-v1-me-privacy-auth",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // ART. 16 OUTRANKS A DEACTIVATION. This is the ONE handler on this surface
  // that does not hand every refusal to `liveUserRefusal`, and the divergence is
  // deliberate — see that function's docblock for the read half, which stays
  // refused.
  //
  // An INSTITUTIONALLY deactivated account is one whose organisation closed it.
  // That is a decision the organisation took, and the right to be erased is the
  // person's, not the organisation's. Refusing it here would let an employer
  // stand between a data subject and Ley 25.326 art. 16 by flipping one column.
  // The web has always granted it — `requireUserOrRedirect` documents
  // `DEACTIVATED → PASSES` — so the phone refusing it was a DIVERGENCE, and it
  // was never argued: the surrounding docblock derives the export refusal at
  // length and says nothing about erasure. It was carried in by symmetry with
  // art. 14, and symmetry is not a reason.
  //
  // Ratified by the PO on 2026-08-31: grant the erasure, keep the export
  // refused. The general rule this is the written exception to — "the phone may
  // be stricter than the web, that direction is safe" — holds for product
  // writes and NOT for legal rights, where refusing IS the harm.
  //
  // `live.user` is populated on this branch by construction: `requireLiveUser`
  // carries the id and email on DEACTIVATED specifically because it is the one
  // refusal a caller is allowed to tolerate. The null check is here so that
  // stops being an assumption if that ever changes.
  let subjectUserId: string;
  if (live.ok) {
    subjectUserId = live.user.id;
  } else if (live.reason === "DEACTIVATED" && live.user !== null) {
    subjectUserId = live.user.id;
  } else {
    return liveUserRefusal(live.reason);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiV1Error("invalid_request", 400);
  }

  const parsed = subjectRightsCommandInputSchema.safeParse(body);
  if (!parsed.success) {
    // THE REASON GETS ITS OWN CODE, and the rest of the body does not. A client
    // that sent no `command` at all has a bug and `invalid_request` is the whole
    // truth; a client that sent a two-word motivo has a PERSON behind it who can
    // fix exactly one field, and telling them their request was malformed would
    // point them at nothing. The distinction is recoverable here because the
    // union has one member: any parse failure carrying a reason issue is the
    // reason. `@dim/contract/input` exports `firstSubjectRightsCommandInputCode`
    // for a client that wants the same split locally, before the round trip.
    const short = parsed.error.issues.some(
      (issue) => issue.message === "REASON_TOO_SHORT" || issue.message === "REASON_TOO_LONG",
    );
    return apiV1Error(short ? "erasure_reason_required" : "invalid_request", 400);
  }

  // NO DB BUDGET AROUND THE ERASURE, and it is the one call on this surface that
  // must not have one. `withDbBudgetOrThrow` does not cancel the work — it stops
  // WAITING for it — so a budget here would answer 503 while six ordered steps
  // kept running, and the subject would be told the supresión failed while their
  // account was being erased underneath the message. That is the worst available
  // answer on an irreversible act. The web button has no timeout either.
  const result = await eraseSubjectDataFor({
    userId: subjectUserId,
    supabase: client.supabase,
    reason: parsed.data.reason,
  });

  if (!result.ok) {
    switch (result.reason) {
      // Unreachable from here — the schema above already refused a short reason
      // with `erasure_reason_required`, and this is the same rule stated by the
      // use-case for the web caller, which has no schema in front of it. Mapped
      // rather than collapsed into the 500 so the two guards agreeing stays
      // visible, and so the day one of them changes the other does not silently
      // start answering "the platform is broken".
      case "reason_required":
        return apiV1Error("erasure_reason_required", 400);
      case "rate_limited":
        return apiV1Error("rate_limited", 429);
      case "failed":
        return apiV1Error("erasure_failed", 500);
      default: {
        const unhandled: never = result.reason;
        throw new Error(`Unhandled erasure refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // NO `supabase.auth.signOut()` HERE, and its absence is measured rather than
  // forgotten. `revoke-sessions.ts` verified in auth-js 2.105.4 that `signOut`
  // on a bearer client reads the session from STORAGE, finds none (this client
  // is `persistSession: false`), skips the revocation entirely and returns
  // `{ error: null }` — success, revoking nothing. Calling it would be a line
  // that looks like session teardown and is not one. The teardown that actually
  // happens is `auth.users` being deleted inside the erasure, which kills this
  // token, plus the client dropping its own keychain entry on this 200.
  const payload: SubjectDataErasedV1 = { erased: true };
  return apiV1Json(payload, { status: 200 });
}

/**
 * Spend one per-IP budget. `true` → proceed, `false` → over the limit.
 *
 * FAILS OPEN on limiter infrastructure failure, matching every sibling limiter
 * on this surface. The limiter is itself a DB write; if `rate_limit_buckets` is
 * unavailable, refusing here would stand between a person and a right the law
 * gives them, over an abuse control. The guard below it is the authorization
 * boundary and it fails CLOSED — that is the one that must.
 *
 * NOTE THIS IS THE **IP** BUDGET AND ITS DIRECTION IS NOT THE EXPORT'S. The
 * per-user export budget fails CLOSED, because letting a limiter outage through
 * THERE means an unbounded PII dump. Here there is no dump to bound: this bucket
 * only makes an unauthenticated hammer cheap, and it is spent before anyone is
 * identified.
 */
async function spendIpBudget(
  endpoint: string,
  identifier: string,
  limit: { maxPerMinute?: number; maxPerHour?: number; maxPerDay?: number },
): Promise<boolean> {
  try {
    await enforceRateLimit(endpoint, identifier, limit);
    return true;
  } catch (err) {
    if (err instanceof RateLimitError) return false;
    reportError(`api-v1-me-privacy/${endpoint}`, err);
    return true;
  }
}

function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The liveness guard's refusals, mapped to the SAME statuses and codes every
 * sibling on this surface uses.
 *
 * `ACCOUNT_ERASED` reaches here on a SECOND supresión from a session that is
 * somehow still alive, and 403 is the honest answer: the token is fine and
 * refreshing it will keep working, so a 401 would produce a refresh loop that
 * succeeds forever against an account that no longer exists.
 *
 * `DEACTIVATED` refuses the READ ONLY, and reaches this function only from GET.
 * The repo's written policy after the 2026-07-04 redirect incident is "reads
 * stay open so the user can see why", and this read is not that kind of read:
 * it does not show somebody their situation, it hands them a copy of their PII
 * record — and an INSTITUTIONALLY deactivated account is one whose organisation
 * closed it, which is exactly the state in which a full export should not be
 * minted on a token nobody has re-verified. If the PO decides an art. 14 request
 * outranks a deactivation, the change is here and it needs its own decision.
 *
 * The WRITE half used to come here too and no longer does. Art. 16 outranks a
 * deactivation (PO, 2026-08-31): the organisation closed the account, but the
 * right to be erased is the person's. POST resolves its own subject and never
 * calls this function with `DEACTIVATED` — the argument is at that call site,
 * where the decision lives. The two halves diverge ON PURPOSE; if a future
 * change makes them symmetric again, it has to say which one it moved and why.
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
