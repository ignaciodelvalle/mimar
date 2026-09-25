// The session, as a tiny observable store outside React.
//
// WHY NOT A CONTEXT WITH THE LOGIC INSIDE IT
// ---------------------------------------------------------------------------
// Because `client.ts` needs the same session and is not a component. The fetch
// wrapper has to be able to read the access token, refresh it, and end the
// session — from inside a request that a screen kicked off — and threading a
// React context into that is either a prop drilled through every call or a
// module-level escape hatch pretending to be a hook.
//
// So the store lives here, plain, and React subscribes to it
// (`useSyncExternalStore` in `useSession`). That also makes the interesting
// behaviour testable without a renderer.
//
// THE STATES ARE NOT INTERCHANGEABLE. In particular `session-unverified` is not
// a variant of `signed-out`: it means the device HAS tokens and could not reach
// the server to find out who they belong to — a cold start on the subway. The
// honest answer there is "we could not check", with a retry and a way out. The
// dishonest answers, both of which were considered: send the user to sign-in
// (they are not signed out, and signing in again needs the network they do not
// have), or wave them through with a fabricated profile.
//
// ===========================================================================
// EVERY auth-js CALL IN THIS FILE IS WRAPPED, AND THAT IS NOT DEFENSIVE STYLE
// ===========================================================================
// auth-js 2.105.4 RETHROWS anything that is not an AuthError. `_setSession`
// (GoTrueClient.js:2849-2854) and `_callRefreshToken` (:3935-3936) both end in
// `throw error` for a non-AuthError, and a failure coming out of
// `expo-secure-store` is a plain `Error`. So a Keystore write that fails does
// not arrive as `{ error }` — it arrives as a REJECTED PROMISE.
//
// The consequences were measured, not guessed, and every one of them is a screen
// that never comes back:
//
//   · `signIn` read `const { error } = await client.auth.setSession(...)` with no
//     catch, so its own branch below — "Iniciaste sesión, pero no pudimos
//     guardarla en este dispositivo" — was UNREACHABLE for the exact failure it
//     names. The rejection propagated into `app/ingreso.tsx`, whose `submit()`
//     has no catch either, so `setBusy(false)` never ran and the button stayed
//     "Ingresando…" forever.
//   · the two `sessionPort` reads are called from inside `client.ts`'s fetch
//     wrapper. A throw there rejects whatever request a screen kicked off, and
//     the screens call `void load()`, so the spinner never resolves.
//   · `bootstrapSession` is called as `void bootstrapSession()` from the root
//     layout's effect. A throw leaves the store at `starting` — a splash screen
//     with no way out.
//
// The direction of the fix follows the storage adapter's own rule, which was
// already right and only reached half the stack: a keychain that will not answer
// is a SIGNED-OUT user, never an app that will not start. Writes are the
// opposite — a failed write is reported to the person in front of the phone,
// because swallowing it produces the "it logs me out sometimes" mystery.

import type { ApiV1ErrorCode, MeV1User } from "@dim/contract/api";
import { MIN_PASSWORD_LENGTH } from "@dim/contract/input";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";

import {
  type ApiResult,
  REQUEST_TIMEOUT_MS,
  type RefreshOutcome,
  type SessionEndReason,
  type SessionPort,
  apiFailureMessage,
} from "../api/client";
import {
  completeIdentity as completeIdentityRequest,
  eraseMyAccount,
  fetchMe,
  login,
  requestPasswordReset as requestPasswordResetRequest,
  revokeAllSessions,
  signup as signupRequest,
} from "../api/endpoints";
import { planesLookCrossed } from "../config/api";
import { forgetAllCachedCredentials } from "../credential/credential-cache";
import { forgetSharedFiles } from "../native/file-share";
import {
  type PushRevocationOutcome,
  registerThisDeviceForPush,
  revokeThisDeviceForPush,
} from "../notifications/push-registration";
import { addAuthBreadcrumb, reportHandledFailure } from "../observability/report";
import { forgetAllAltaDrafts } from "../pets/alta-draft-store";
import { forgetAllEventDrafts } from "../pets/event-draft-store";
import {
  AUTH_STORAGE_KEY,
  authClient,
  dropLocalSession,
  readStoredSession,
  restoreStoredSession,
} from "./supabase-auth";

export type SessionState =
  /** Before `bootstrapSession()` has answered. Render a splash, not a screen. */
  | { phase: "starting" }
  /** This build has no auth plane. Nothing can sign in; say so. */
  | { phase: "unconfigured" }
  /**
   * `endedAt` is THE PATH THE PERSON WAS ON when they ended the session
   * themselves, and it is absent for every end that was done TO them.
   *
   * It exists because `reason` alone is sticky: nothing clears it until the
   * next sign-in, so "user_action" is still the reason five screens later.
   * The gate suppresses the sign-in `next` parameter for a deliberate end
   * (NAV-2), and without a place to scope that suppression it also swallowed
   * the destination of a deep link opened AFTER the sign-out — see
   * `signedOutHref` in `return-to.ts`.
   */
  | { phase: "signed-out"; reason: SessionEndReason | null; endedAt?: string }
  /** Tokens on the device, identity unconfirmed — see the header. */
  | { phase: "session-unverified"; message: string }
  | { phase: "signed-in"; user: MeV1User };

let state: SessionState = { phase: "starting" };
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getSessionState(): SessionState {
  return state;
}

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The sentence every "we could not check, and it was not your fault" path says
 * WHEN NOTHING CAME BACK. A cold start with no signal, a refresh that never
 * landed, a `/me` that timed out, a captive portal: one fact for the person
 * holding the phone, and one constant, because four literals had drifted.
 */
export const SESSION_UNREACHABLE_MESSAGE =
  "No pudimos verificar tu sesión: no hay conexión con el servidor. Tus datos siguen guardados en este teléfono.";

/**
 * The same fact when the SERVER answered and the answer was not usable.
 *
 * IT NAMES A DIFFERENT SUBSYSTEM AND THAT IS THE WHOLE POINT. Until now the
 * sentence above was served for every unreachable arm, including a GoTrue that
 * returned 500 or 429 — so somebody with four bars in a vet's waiting room was
 * told to check their connection, and the one thing they could do (wait) was
 * never named. It is the identical defect `cachedCredentialReason` fixed for the
 * credential banner (A3-documento-credencial-02), whose wording — "servidor no
 * disponible" for an answered-but-refused read — is the precedent this follows.
 */
export const SESSION_SERVER_UNAVAILABLE_MESSAGE =
  "No pudimos verificar tu sesión: el servidor no está disponible. Tus datos siguen guardados en este teléfono.";

/** Distinguishes a raced timeout from a real answer without a nullable. */
const TIMED_OUT = Symbol("session-timed-out");

/**
 * The 10 s budget `client.ts` gives every request, applied to the auth plane too.
 *
 * IT WAS MISSING EXACTLY WHERE IT MATTERS MOST (A6-cuenta-resiliencia-04).
 * `performRequest` aborts at `REQUEST_TIMEOUT_MS`, but `getSession()`,
 * `refreshSession()` and `signOut()` go to GoTrue through the SDK's own fetch,
 * which this app never configured a timeout on. On a network that accepts a
 * connection and then answers nothing — a captive portal, a hotel wifi — those
 * calls hang for as long as the platform lets them, and every one of them is
 * under a screen: the splash on a cold start, a spinner behind `void load()`,
 * and a "Cerrar sesión" button that stays pressed. A budget makes the failure
 * arrive as an answer this file already knows how to render.
 */
async function withSessionTimeout<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The HTTP statuses on which GoTrue has EXAMINED a credential and said no.
 *
 * AN ALLOW-LIST, AND THE DIRECTION IS THE FIX (lote 1b review, F1). This used to
 * be a denylist — "retryable, unparseable or 5xx is unreachable, EVERYTHING ELSE
 * is a refusal" — and the everything-else was wrong for the statuses that carry
 * no verdict at all. auth-js maps only [502,503,504,520,521,522,523,524,530] to
 * `AuthRetryableFetchError` (lib/fetch.js:32-40); every other status becomes a
 * plain `AuthApiError`, so a 429 from a per-IP rate limit — a clinic, a
 * municipal office, anything behind CGNAT — arrived here as "refused". In
 * `accessToken()` the refused arm runs `clearSession()`, which drops the tokens
 * AND calls `forgetAllCachedCredentials()`: a rate limit nobody asked for
 * destroying a refresh token the server never rejected and wiping the offline
 * credential cache with it. 408 has the same shape.
 *
 * The remaining risk of the inverted default is the mirror one — reading a
 * genuine revocation as unreachable would leave somebody at a retry button that
 * cannot succeed — and it is bounded: every refusal GoTrue produces carries one
 * of these five statuses, and `AuthApiError` is always constructed with a
 * numeric status (`error.status || 500`, lib/fetch.js:82), so there is no
 * status-less refusal to fall through.
 */
const AUTH_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

/**
 * Did the SERVER examine this credential and refuse it, or did the answer never
 * arrive intact?
 *
 * `isAuthRetryableFetchError` is auth-js's own guard and it covers the case it
 * was written for: a fetch that failed at the transport. TWO MORE SHAPES REACH
 * THE SAME PLACE AND MEAN THE SAME THING (A6-refuter-M1), and auth-js treats
 * both as fatal — `_callRefreshToken` calls `_removeSession()` for every
 * AuthError outside its retry list, so each of these DELETES a refresh token
 * GoTrue never rejected:
 *
 *   · `AuthUnknownError` — the answer's body would not parse as JSON
 *     (lib/fetch.js). An HTML 502 page, a captive portal's login screen, a proxy
 *     error. Nothing was examined; the request did not really reach GoTrue.
 *   · any status outside `AUTH_REFUSAL_STATUSES` — 500 and 520, and equally 429
 *     and 408. A server that fell over, or that is shedding load, is not a
 *     server that said no.
 *
 * Only a status in that set is a refusal. See it for why the default is
 * "unreachable" and not the reverse.
 */
function authFailureReason(error: unknown): "refused" | "unreachable" {
  if (isAuthRetryableFetchError(error)) return "unreachable";
  const candidate = error as { name?: unknown; status?: unknown } | null;
  if (candidate?.name === "AuthUnknownError") return "unreachable";
  const status = candidate?.status;
  if (typeof status === "number" && AUTH_REFUSAL_STATUSES.has(status)) return "refused";
  return "unreachable";
}

/**
 * WHICH unreachable sentence this failure earns — see the two constants above.
 *
 * The split is "did anything come back with a status on it". A transport failure
 * (`AuthRetryableFetchError` is constructed with status 0 for those) and an
 * answer whose body would not parse are "no hay conexión"; a 500, a 503 or a 429
 * are a server that answered, and telling that person to check their connection
 * sends them to restart a router while the problem is ours.
 */
function authUnverifiedMessage(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status > 0
    ? SESSION_SERVER_UNAVAILABLE_MESSAGE
    : SESSION_UNREACHABLE_MESSAGE;
}

/**
 * "We could not check" — WITHOUT overwriting a session that has already ended.
 *
 * The guard is `applyMeResult`'s, for its reason: `apiRequest` ends the session
 * with a REASON for every code that means the session is over, and replacing that
 * with "revisá tu conexión" would hide the explanation behind a retry button that
 * cannot work.
 */
function markSessionUnverified(message: string): void {
  if (state.phase === "signed-out") return;
  setState({ phase: "session-unverified", message });
}

/**
 * How many times this process has torn a session down.
 *
 * IT EXISTS BECAUSE "IS THE KEY EMPTY?" CANNOT TELL TWO OPPOSITE EVENTS APART
 * (lote 1b review, F2). An empty key is what `_removeSession()` leaves behind
 * after a failure nobody asked for — and it is also exactly what a DELIBERATE
 * "Cerrar sesión" produces. The sequence that cost the review its HIGH: a 401
 * starts `refreshAccessToken` and it snapshots the key; the refresh hangs; the
 * person taps "Cerrar sesión" and `clearSession()` empties the key; the refresh
 * finally resolves `unreachable` and `restoreSnapshot` writes the live refresh
 * token BACK. The UI says signed out and the next cold start signs back in — on
 * a shared phone, with this batch's display-only gate, rendering the previous
 * person's cached credentials.
 *
 * A counter and not a boolean: it has to survive being read across an await by
 * two overlapping refreshes, and "did the number change" answers that where
 * "is a flag set" does not.
 */
let signOutEpoch = 0;

/**
 * Whether `clearSession` is already inside its push revoke.
 *
 * A FLAG AND NOT AN EPOCH, deliberately, because the question is different. The
 * epoch above orders WRITES ("is this snapshot still the current one"); this one
 * breaks a CYCLE ("am I already in here"). See the long note at the call site:
 * the revoke asks `sessionPort.accessToken()` for a bearer, and that function's
 * refused arm ends the session by calling `clearSession`. Without this the two
 * call each other until the stack gives out.
 */
let pushRevokeInFlight = false;

/**
 * Put a snapshotted session back, if there was one and it is now gone.
 *
 * IT CHECKS TWICE, and both checks are load-bearing:
 *
 *   · the KEY must still be empty — a refresh that ROTATED the token writes a
 *     newer value under the same key, and blindly writing the snapshot back
 *     would replace a live refresh token with the one it just replaced.
 *   · no sign-out may have happened SINCE the snapshot was taken. See
 *     `signOutEpoch`: an empty key is `_removeSession()`'s leftovers and a
 *     deliberate sign-out's result, and only the caller's epoch tells them apart.
 */
async function restoreSnapshot(snapshot: string | null, epoch: number): Promise<void> {
  if (snapshot === null) return;
  if (signOutEpoch !== epoch) return;
  try {
    if ((await readStoredSession()) !== null) return;
    // Re-read AFTER the await too: the sign-out may have landed while this was
    // reading the key it is about to write to.
    if (signOutEpoch !== epoch) return;
    await restoreStoredSession(snapshot);
  } catch {
    // A keystore that will not answer cannot be repaired from here, and the
    // caller is already reporting a failure the person can retry.
  }
}

/**
 * The port `client.ts` uses. One instance, module-level, because there is one
 * session.
 */
export const sessionPort: SessionPort = {
  async accessToken() {
    const client = authClient();
    if (client === null) return null;
    try {
      // `getSession()` refreshes on its own when the stored token is past expiry,
      // which is why this is not `session.access_token` read out of our own state:
      // the library's copy is the one that is kept current. That autorefresh is
      // also why a READ can throw a WRITE's error — see the header.
      const answered = await withSessionTimeout(client.auth.getSession());
      if (answered === TIMED_OUT) {
        // Ten seconds without an answer from the auth plane. The tokens are
        // still here and nobody refused them.
        markSessionUnverified(SESSION_UNREACHABLE_MESSAGE);
        return null;
      }
      const { data, error } = answered;
      const token = data.session?.access_token ?? null;
      if (token !== null) return token;

      // A NULL TOKEN IS NOT ONE FACT, AND THIS FUNCTION USED TO REPORT IT AS ONE
      // (A1-refuter-M1). `apiRequest` reads null as "no session at all" and
      // answers `auth_required` WITHOUT ending anything, so the store stayed
      // `signed-in` while every screen rendered "Necesitás iniciar sesión" — a
      // shell with no way to sign in, because the gate never saw a signed-out
      // state to redirect on. The two causes need opposite answers:
      //
      //   refused     → the session really is over. End it here, so the gate
      //                 shows the sign-in screen with its reason.
      //   unreachable → the refresh never landed. Say so, keep the tokens, and
      //                 let the unverified screen offer its retry.
      //
      // No error and no session is the third case and the ordinary one: this
      // device is simply signed out. Nothing to announce.
      if (error) {
        if (authFailureReason(error) === "unreachable") {
          markSessionUnverified(authUnverifiedMessage(error));
        } else {
          await clearSession();
          setState({ phase: "signed-out", reason: "auth_expired" });
        }
      }
      return null;
    } catch {
      // No usable token, which is what the caller does with a null anyway. It
      // must not become a rejected request: the screens call `void load()`, so a
      // throw here is a spinner that never stops.
      return null;
    }
  },

  async refreshAccessToken() {
    // ONE BREADCRUMB PER OUTCOME, WRITTEN IN ONE PLACE (OBS-6). Every session
    // defect this app has had reads the same in a bug report — "me sacó de la
    // sesión" — and the three answers below are what tell a refusal from a dead
    // spot after the fact. Wrapped rather than repeated at each `return`
    // because a fourth arm added later must not be able to forget it.
    const outcome = await refreshAccessTokenOutcome();
    addAuthBreadcrumb(
      outcome.ok
        ? "refresh-ok"
        : outcome.reason === "refused"
          ? "refresh-refused"
          : "refresh-unreachable",
    );
    return outcome;
  },

  async endSession(reason) {
    await clearSession();
    // THE SERVER CAN END A SESSION FOR GOOD, and on those two answers the
    // drafts go too (A2b). `account_erased` arrives when the account was erased
    // from the web, or when this app's own "Eliminar mi cuenta" landed but its
    // 200 was lost on the way back; `account_deactivated` when the account was
    // locked. Neither is a blip somebody signs back into with their text
    // waiting, so they are swept like the deliberate exits. Every OTHER reason
    // here — above all `auth_expired`, a refresh that failed — keeps them: see
    // `sweepDraftsOnDeliberateExit` for why an ordinary session end must not.
    if (reason === "account_erased" || reason === "account_deactivated") {
      sweepDraftsOnDeliberateExit();
    }
    setState({ phase: "signed-out", reason });
  },
};

/**
 * The refresh itself. Wrapped by the port above, which is where the breadcrumb
 * is written — see `refreshAccessToken` there for why it is not written here.
 */
async function refreshAccessTokenOutcome(): Promise<RefreshOutcome> {
  const client = authClient();
  // No auth plane in this build: nothing to refresh against, ever. "Refused"
  // and not "unreachable" — waiting will not produce a server that this build
  // was never pointed at.
  if (client === null) return { ok: false, reason: "refused" } as const;
  {
    // SNAPSHOT BEFORE THE CALL, because the call is what deletes it. See
    // `authFailureReason` and `restoreStoredSession`: auth-js removes the stored
    // session for every AuthError outside its retry list, including the two
    // shapes that mean "nothing was examined". Best-effort — a keystore that will
    // not read is not a reason to refuse a refresh that might still work.
    const snapshot = await readStoredSession().catch(() => null);
    // THE EPOCH IS READ HERE, BEFORE THE CALL, for `restoreSnapshot`'s reason: a
    // sign-out that lands while this is in flight must not be undone by it.
    const epoch = signOutEpoch;
    try {
      const answered = await withSessionTimeout(client.auth.refreshSession());
      if (answered === TIMED_OUT) {
        await restoreSnapshot(snapshot, epoch);
        return { ok: false, reason: "unreachable" } as const;
      }
      const { data, error } = answered;
      if (error) {
        // THE SPLIT THIS FUNCTION USED TO COLLAPSE (native QA batch 2, D7). It
        // is the same guard `signIn` below already applies to `setSession`'s
        // returned error, for the same measured reason: auth-js RETURNS a
        // network-level failure as `AuthRetryableFetchError` (lib/fetch.js:33-40)
        // rather than throwing it, so `{ error }` covers both "GoTrue refused
        // this refresh token" and "the request never got there". Answering both
        // with `null` made `apiRequest` end the session over a dead spot — a
        // forced re-login for a session nobody had revoked.
        //
        // The classifier is `authFailureReason` and no longer the library's guard
        // alone: two more shapes mean "nothing was examined" and auth-js answers
        // both by DELETING the stored session, which is what `snapshot` undoes.
        const reason = authFailureReason(error);
        if (reason === "unreachable") await restoreSnapshot(snapshot, epoch);
        return { ok: false, reason } as const;
      }
      const token = data.session?.access_token;
      // No error and no token is not a shape GoTrue produces; it is answered
      // rather than assumed away, and "refused" is the honest reading of "the
      // provider said yes and handed over nothing".
      return token ? ({ ok: true, token } as const) : ({ ok: false, reason: "refused" } as const);
    } catch {
      // `_callRefreshToken` rethrows non-AuthErrors, so a Keystore write failure
      // during rotation lands here rather than in `error`. That is a DEVICE
      // failure, not a network one: the tokens on this phone cannot be updated,
      // so retrying the same request would fail the same way. "Refused".
      return { ok: false, reason: "refused" } as const;
    }
  }
}

/**
 * Drop the session locally, unconditionally.
 *
 * `signOut` is attempted first so GoTrue learns about it, and its failure is
 * DELIBERATELY ignored — `dropLocalSession()` runs either way. See the long note
 * on `dropLocalSession` for why ignoring it is the honest choice here and not
 * the lazy one: the library leaves the session in place on a 5xx, and a "Cerrar
 * sesión" that leaves a live refresh token in the Keystore is a lie told to the
 * person holding the phone.
 */
/**
 * What `clearSession` must NOT do again.
 *
 * One caller — `signOutEverywhere` — has to revoke this device's push target
 * BEFORE it starts, because by the time it starts the credentials the revoke
 * needs are already dead. It passes this so the teardown does not spend a second
 * round trip repeating a request that can now only fail.
 */
type ClearSessionOptions = { pushAlreadyRevoked?: boolean };

/**
 * A revoke that did not land, made visible — the reason the outcome exists.
 *
 * NOT SHOWN TO ANYBODY, and that is the right call rather than a cop-out: the
 * person is signing out and they are leaving either way, and there is no screen
 * in this app where "no pudimos apagar las notificaciones de este teléfono"
 * could be acted on. What there IS is a file, and this makes the failure
 * reachable there — which is the whole difference between best-effort and
 * unobservable.
 *
 * `unreachable` IS DROPPED, deliberately, and it is the same exclusion
 * `REPORT_FAILURES` already makes for the API surface: a phone signing out on
 * the subway is not a defect, and reporting it would bury the real events under
 * one per tunnel. It costs a real miss — a revoke genuinely lost to a flaky
 * network looks identical from here — and the trade is taken knowingly, because
 * an alert channel nobody can read is not an alert channel.
 */
function reportFailedPushRevocation(outcome: PushRevocationOutcome): void {
  if (outcome.outcome !== "failed") return;
  if (outcome.detail === "unreachable") return;
  reportHandledFailure({ surface: "push", failure: "push-revoke-failed" });
}

async function clearSession(options: ClearSessionOptions = {}): Promise<void> {
  // FIRST LINE, BEFORE ANY AWAIT. Everything below this point is a teardown, and
  // every in-flight refresh that resolves from here on must be refused its
  // `restoreSnapshot` — see `signOutEpoch`.
  const epoch = ++signOutEpoch;
  // The third auth breadcrumb (OBS-6). It goes HERE and not in `endSession`
  // because this is the function every way of ending a session funnels
  // through — the port's `endSession`, "Cerrar sesión", "Cerrar todas", and the
  // erasure — so a trail that shows a refresh refusal and no sign-out means the
  // session ended somewhere else, which is a fact worth being able to read.
  addAuthBreadcrumb("sign-out");
  // BEFORE THE TOKENS GO, because a revoke needs the credentials this function
  // is about to destroy. This is the only place it can go: `clearSession` is
  // the funnel every way of ending a session passes through, and a subscriber
  // watching for `phase: "signed-out"` would see it one step too late. The row
  // is soft-revoked rather than deleted, so the next sign-in on this device
  // brings it back live.
  //
  // TWO PATHS REACH HERE WITH A DEAD TOKEN AND THIS CALL IS A NO-OP ON BOTH:
  // `signOutEverywhere` (GoTrue already rejected it) and `eraseAccount` (the
  // account is gone, and `erase_subject_data` already deleted the row). The
  // first leaves a live row behind; see the report.
  //
  // THE GUARD IS NOT PARANOIA — WITHOUT IT THIS RECURSES FOREVER. The revoke
  // goes out through `apiRequest`, which asks `sessionPort.accessToken()` for a
  // bearer; and `accessToken()`'s REFUSED arm ends the session by calling this
  // very function. Sign-out → revoke → accessToken → refused → sign-out, with
  // no floor. One flag closes it: the re-entrant call skips the revoke, drops
  // the tokens, and the outer request then reads a null token and gives up on
  // its own.
  //
  // IT IS AN ASYNC CYCLE, SO IT EATS THE HEAP AND NOT THE STACK, which is worse
  // rather than better: there is no `RangeError` to catch and no stack trace
  // pointing here. Removing this line and running `session-store.test.ts` ends
  // in `FATAL ERROR: Reached heap limit Allocation failed` and SIGABRT
  // (measured). On a phone that is the app dying on the way out.
  if (!options.pushAlreadyRevoked && !pushRevokeInFlight) {
    pushRevokeInFlight = true;
    try {
      reportFailedPushRevocation(await revokeThisDeviceForPush(sessionPort));
    } catch {
      // Best-effort, exactly like `forgetAllCachedCredentials`: somebody who
      // pressed "Cerrar sesión" is leaving, and a push row that could not be
      // updated must not turn that into an error. `revokeThisDeviceForPush`
      // resolves rather than rejecting, so reaching here means something under
      // it broke its own contract.
      reportFailedPushRevocation({ outcome: "failed", detail: "threw" });
    } finally {
      pushRevokeInFlight = false;
    }
  }
  const client = authClient();
  if (client !== null) {
    try {
      // UNDER THE 10 s BUDGET, like every other call to the auth plane
      // (A6-cuenta-resiliencia-04). `signOut` reaches GoTrue through the SDK's
      // own fetch, which has no timeout of its own, and this call is what
      // "Cerrar sesión" waits on: a network that accepts the connection and
      // then answers nothing left the button pressed indefinitely. The local
      // delete below is what actually ends the session, and it does not need a
      // server's permission to run.
      //
      // THE BUDGET BOUGHT A RACE AND THIS IS ITS OTHER HALF (lote 1b review,
      // F6). Before it, this awaited auth-js to completion and the library's own
      // storage lock ordered the writes; now the local delete below can run
      // while auth-js still has queued work, and a `_saveSession` landing after
      // it puts the session back — the same resurrection F2 fixes for our own
      // refresh, on a path the epoch alone cannot reach because the write is
      // inside the library. So the delete is repeated once the abandoned call
      // finally settles.
      const settled = Promise.resolve(client.auth.signOut({ scope: "local" })).catch(
        () => undefined,
      );
      if ((await withSessionTimeout(settled)) === TIMED_OUT) {
        void settled.then(async () => {
          // Only if nothing has happened since. A later `clearSession` does its
          // own delete, and a person who signed back IN during those seconds
          // holds a session this must never touch.
          if (signOutEpoch !== epoch || state.phase !== "signed-out") return;
          await dropLocalSession().catch(() => undefined);
        });
      }
    } catch {
      // Ignored on purpose — see above.
    }
  }
  // NEITHER OF THESE MAY THROW OUT OF HERE. `clearSession` is the recovery path:
  // it runs when signing out, and again when a sign-in could not be stored. A
  // Keystore so broken that even DELETING fails would otherwise turn one failure
  // into a second, thrown one, in the exact code that exists to clean up after
  // the first. The state transition its callers perform must still happen.
  try {
    await dropLocalSession();
  } catch {
    // Nothing more to do here: the caller is already telling the user something
    // went wrong, and the local tokens are unusable either way.
  }
  // The device may be shared — a family phone, a rescue's tablet. The next
  // person to sign in must not find the previous owner's animals sitting in the
  // offline display cache. See credential-cache.ts.
  try {
    await forgetAllCachedCredentials();
  } catch {
    // A display cache that will not clear must not block a sign-out.
  }
}

/**
 * Resolve the session at app start.
 *
 * Called once from the root layout. Safe to call again (the retry button on the
 * unverified screen does).
 */
export async function bootstrapSession(): Promise<void> {
  const client = authClient();
  if (client === null) {
    setState({ phase: "unconfigured" });
    return;
  }

  let hasStoredSession = false;
  // "There are tokens here and we could not check them" — the subway cold start.
  let couldNotCheck = false;
  // WHICH of the two unverified sentences this cold start earned. It defaults to
  // the transport one because the TIMED_OUT arm below has no error to read a
  // status off: ten seconds of silence really is "nothing came back".
  let couldNotCheckMessage = SESSION_UNREACHABLE_MESSAGE;
  try {
    const answered = await withSessionTimeout(client.auth.getSession());
    if (answered === TIMED_OUT) {
      couldNotCheck = true;
    } else {
      hasStoredSession = answered.data.session !== null;
      if (!hasStoredSession) {
        // THE COLD START THIS FUNCTION USED TO GET WRONG (A1-entrada-01 /
        // A6-cuenta-resiliencia-01). An access token past its expiry makes
        // `getSession()` refresh before it answers, and a refresh that cannot
        // reach GoTrue comes back `{ session: null }` — indistinguishable, at
        // this line, from a phone nobody ever signed in on. The app read it as
        // the second and drew the sign-in screen, on a device holding a
        // perfectly good refresh token, asking for a password over a network
        // that could not have checked it.
        //
        // TWO SIGNALS, EITHER OF WHICH IS ENOUGH. auth-js RETURNS the failure
        // (`AuthRetryableFetchError` and the two shapes `authFailureReason`
        // adds), and the keystore still holds the session for anything it did
        // not delete. The raw read is what covers the versions and paths that
        // answer `{ session: null, error: null }` after swallowing a failure of
        // their own.
        const unreachable =
          answered.error !== null && authFailureReason(answered.error) === "unreachable";
        if (unreachable) couldNotCheckMessage = authUnverifiedMessage(answered.error);
        couldNotCheck = unreachable || (await readStoredSession().catch(() => null)) !== null;
      }
    }
  } catch {
    // A keychain that will not answer at cold start is a signed-out user, not a
    // splash screen forever. The root layout calls this as `void
    // bootstrapSession()`, so a throw would leave the store at `starting` with
    // nothing to retry from.
    hasStoredSession = false;
  }

  if (!hasStoredSession) {
    if (couldNotCheck) {
      setState({ phase: "session-unverified", message: couldNotCheckMessage });
      return;
    }
    setState({ phase: "signed-out", reason: null });
    return;
  }

  // THE FOURTH CAUSE OF "me sacó de la sesión", finally on the trail (finding
  // L2, review 2026-09-07). `AUTH_EVENTS` has carried `session-restored` since
  // OBS-6 and NOBODY EMITTED IT — `report.test.ts` iterated the union and
  // asserted all five land, which reads as coverage of an event that could not
  // occur. This is the transition it names: the keystore had a session, this
  // cold start found it, and everything after it in the trail happened to a
  // restored session rather than a fresh sign-in. Without the crumb, a
  // keystore restore that then lost a race to `/me` is indistinguishable,
  // after the fact, from a refusal.
  addAuthBreadcrumb("session-restored");
  const me = await fetchMe(sessionPort);
  applyMeResult(me);
}

/**
 * The `/me` refusals that mean THIS SESSION IS OVER.
 *
 * IT IS ALMOST `sessionEndingReason`'s list in `client.ts`, AND THE "ALMOST" IS
 * THE PART THAT BIT (lote 1b review, F5). That function decides when
 * `apiRequest` ends a session and this one decides when a `/me` read may draw
 * the sign-in screen, so they must agree — a code missing here is a person told
 * to sign in over a server outage. What they do NOT mirror is the STATUS:
 * `sessionEndingReason` gates `auth_required` on a real 401, while `apiRequest`
 * also SYNTHESIZES `{ outcome: "api-error", code: "auth_required" }` with no
 * status at all when `accessToken()` hands it a null token. That synthesized
 * code is not a server verdict about anything, which is why the arm below refuses
 * to act on it while the store says `session-unverified`.
 */
const SESSION_ENDING_CODES: ReadonlySet<ApiV1ErrorCode> = new Set<ApiV1ErrorCode>([
  "auth_expired",
  "session_shift_expired",
  "auth_required",
  "account_deactivated",
  "account_erased",
]);

/**
 * Turn a `/me` read into a session state.
 *
 * The `api-error` arm does NOT set `signed-out` itself: `apiRequest` has already
 * called `endSession` for every code that means the session is over, and that
 * call has already set the state WITH ITS REASON. Overwriting it here would
 * replace "tu turno de trabajo terminó" with a blank sign-in screen — the
 * refusal would still happen and the explanation would be gone.
 */
function applyMeResult(result: ApiResult<{ user: MeV1User }>): void {
  if (result.outcome === "ok") {
    setState({ phase: "signed-in", user: result.payload.user });
    return;
  }
  if (result.outcome === "api-error") {
    // Already ended, WITH ITS REASON, by `apiRequest`. See the note above.
    if (state.phase === "signed-out") return;
    // NOT EVERY REFUSAL IS A DEAD SESSION, and this arm used to answer all of
    // them with the sign-in screen (A1-entrada-02). A 503 from a deploy and a
    // 429 from the limiter say nothing whatsoever about the tokens on the
    // device — and "iniciá sesión de nuevo" is the one instruction that cannot
    // help, because signing in hits the same unavailable server. The codes that
    // DO end a session are the ones `apiRequest` already ends it for; anything
    // else is "we could not check", with the code's own sentence and its
    // retry-after when the server sent one.
    if (SESSION_ENDING_CODES.has(result.code)) {
      // AND NOT OVER A `session-unverified` THIS SAME CALL CHAIN JUST SET (lote
      // 1b review, F5). `apiRequest` synthesizes `auth_required` whenever
      // `accessToken()` returns null — including the arm where `accessToken()`
      // could not reach GoTrue and set `session-unverified` on its way out. A
      // real `auth_required` from the server has already gone through
      // `endSession`, so it arrives here as `signed-out` and is caught by the
      // guard above; the only refusal that reaches THIS line while the store
      // says "we could not check" is the synthesized one, and answering it with
      // a blank sign-in screen throws away the one sentence explaining why.
      if (state.phase === "session-unverified") return;
      setState({ phase: "signed-out", reason: null });
      return;
    }
    markSessionUnverified(apiFailureMessage(result) ?? SESSION_UNREACHABLE_MESSAGE);
    return;
  }
  // unreachable / malformed / unsupported-version: the tokens are fine, the
  // answer was not. Never sign the user out over a subway tunnel.
  setState({
    phase: "session-unverified",
    message: apiFailureMessage(result) ?? "No pudimos verificar tu sesión.",
  });
}

export type SignInResult = { ok: true } | { ok: false; message: string };

/**
 * Sign in: `POST /api/v1/auth/login`, then seed the SDK with what it returns.
 *
 * The order matters and is the whole design. The password never goes to GoTrue
 * from this app — it goes to `/api/v1/auth/login`, which applies OUR rate limits,
 * OUR account-state refusals and OUR non-enumerating error copy, and hands back
 * tokens. Only then is the SDK given a session to keep alive. A client that
 * called `signInWithPassword` directly would bypass every one of those.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const client = authClient();
  if (client === null) {
    return {
      ok: false,
      message:
        "Esta compilación de la app no tiene configurado el servidor de sesiones. Avisale a quien te la pasó.",
    };
  }

  const result = await login({ email, password });
  if (result.outcome !== "ok") {
    // The server's single non-enumerating sentence, verbatim. Do not decorate it
    // and do not split it by cause: `invalid_credentials` is byte-identical for
    // "no such account" and "wrong password" precisely so this screen cannot
    // become an account-enumeration oracle.
    return { ok: false, message: apiFailureMessage(result) ?? "No pudimos iniciar sesión." };
  }

  // THREE FAILURE SHAPES REACH THIS CALL AND THEY NAME THREE SUBSYSTEMS, so
  // they are caught together and answered apart. Until 2026-08-25 only one of
  // them existed; until 2026-08-31 all of them shared one sentence, and that
  // sentence cost a real diagnosis (see below); until 2026-09-01 every
  // RETURNED error was read as "the server refused", and the pre-push review
  // measured the shape that is not:
  //
  //   · `{ error }` RETURNED, retryable → the fetch inside `_getUser` never
  //     reached a server. auth-js wraps a network-level failure in
  //     AuthRetryableFetchError and RETURNS it (lib/fetch.js:33-40, returned by
  //     GoTrueClient.js:2836) — the Supabase plane down or unreachable, the
  //     WinNAT/container class this repo has already been burned by. Neither
  //     the device nor any refusal is involved.
  //   · `{ error }` RETURNED, anything else → a refusal. Either the server
  //     examined the token and said no, or auth-js refused it locally before
  //     sending (malformed JWT, missing session) — `setSession` calls
  //     `_getUser(access_token)` over the network BEFORE it saves anything
  //     (GoTrueClient.js:2835 vs `_saveSession` at :2847), so on this path
  //     storage is never even reached.
  //   · REJECTED PROMISE      → not an AuthError, so auth-js rethrew it
  //     (:2849-2854). An `expo-secure-store` failure is a plain Error, so THIS
  //     is the device-storage shape, and the only one.
  let stored: { error: unknown } = { error: null };
  let refusedByServer = false;
  let serverUnreachable = false;
  try {
    stored = await client.auth.setSession({
      access_token: result.payload.session.accessToken,
      refresh_token: result.payload.session.refreshToken,
    });
    // Returned errors split by the library's own guard, per the contract above.
    serverUnreachable = isAuthRetryableFetchError(stored.error);
    refusedByServer = Boolean(stored.error) && !serverUnreachable;
  } catch (err) {
    stored = { error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (stored.error) {
    // Signed in at the API, not usable on the device either way. Saying
    // "listo" here produces a session that evaporates on the next cold start,
    // which is the "it logs me out sometimes" report the whole storage adapter
    // exists to prevent. Refuse visibly — and say WHICH subsystem it was.
    //
    // WHY THE SPLIT IS WORTH ITS LINES. One sentence blaming the device covered
    // every shape, and on 2026-08-30 it sent a walkthrough down the wrong path:
    // the app was pointed at LOCAL Supabase while `API_BASE_URL` still defaulted
    // to staging, so it signed in at staging, handed a staging-signed token to
    // local GoTrue, and got `invalid JWT: unrecognized JWT kid`. Pure
    // configuration, zero device involvement — and the screen said "este
    // dispositivo". It was written up as an unexplained Keystore fault, an
    // emulator PIN was tried and refuted, and `adb logcat` was searched for
    // SecureStore lines that could not exist, because that code never ran.
    //
    // A message that names the wrong subsystem does not merely fail to help: it
    // spends someone's afternoon in the wrong file.
    //
    // `clearSession` is itself unconditional and swallows its own signOut
    // failure, so this cleanup cannot turn one failure into two.
    await clearSession();
    if (serverUnreachable) {
      // The one branch that MAY say "conexión": the guard above fires only on a
      // fetch that failed at the network level, never on an examined-and-refused
      // token.
      return {
        ok: false,
        message:
          "Iniciaste sesión, pero no pudimos confirmarla con el servidor. Revisá tu conexión y probá de nuevo.",
      };
    }
    if (refusedByServer) {
      // Deliberately NOT "revisá tu conexión" — the retryable shape was peeled
      // off above, so what remains is a refusal: a token this server does not
      // recognise, a server that is not the one that issued it, or a token
      // auth-js refused to decode. And NOT "este dispositivo" either: the
      // device is the one subsystem provably not involved on this path.
      //
      // When the build's own two origins straddle local and remote, that IS
      // the cause with overwhelming likelihood, so it gets named. A shipped
      // build cannot reach that clause — both origins are baked from one
      // environment — so the sentence only ever appears in front of the person
      // who can act on it.
      return {
        ok: false,
        message: planesLookCrossed()
          ? "Iniciaste sesión, pero el servidor no aceptó la sesión: esta compilación apunta a dos entornos distintos (API y Supabase). Alineá EXPO_PUBLIC_API_BASE_URL con EXPO_PUBLIC_SUPABASE_URL."
          : "Iniciaste sesión, pero el servidor no aceptó la sesión. Probá de nuevo.",
      };
    }
    return {
      ok: false,
      message: "Iniciaste sesión, pero no pudimos guardarla en este dispositivo. Probá de nuevo.",
    };
  }

  // The offline display cache is per-DEVICE, and this device may be shared — a
  // family phone, a rescue's tablet. `clearSession` already drops it on every
  // sign-out, so this is belt and braces; it became worth having when that call
  // started swallowing its own failure (see clearSession), which means a stale
  // cache CAN survive a sign-out now. Clearing on the way IN closes that without
  // making a failed cleanup block a sign-out.
  await forgetAllCachedCredentials().catch(() => undefined);

  setState({ phase: "signed-in", user: result.payload.user });
  return { ok: true };
}

export type SignUpResult =
  /** An account exists and this device is signed into it. */
  | { ok: true; signedIn: true }
  /**
   * The server answered 201 and handed back NO session. The person's next step
   * is the sign-in screen; see below for why this is not an error and why the
   * caller must not guess at a cause.
   */
  | { ok: true; signedIn: false }
  | { ok: false; message: string };

/**
 * Create an account: `POST /api/v1/auth/signup`, then seed the SDK with
 * whatever it returns.
 *
 * SAME ORDER AND SAME REASON AS `signIn`. The password never goes to GoTrue
 * from this app — it goes to `/api/v1/auth/signup`, which applies OUR rate
 * limit (`auth_signup_ip`, 3/min · 15/hr, spent inside the shared use-case
 * before GoTrue is touched — TIGHTER than login's, because a signup is never a
 * high-frequency legitimate action), OUR validation and OUR non-enumerating
 * response shape. A client that called `signUp` on the Supabase SDK directly
 * would bypass every one of those, and would also get the raw "User already
 * registered" error the masquerade exists to hide.
 *
 * THE 201 WITH NO SESSION IS A SUCCESS AND MUST BE REPORTED AS ONE. It has two
 * causes a caller cannot tell apart, and that indistinguishability is the whole
 * point (audit 28-#3): the email already has an account, or — if email
 * confirmations are ever turned ON in the Supabase dashboard — a genuine new
 * account is waiting to be confirmed. This function returns
 * `{ ok: true, signedIn: false }` for both and says nothing about which, so no
 * screen can accidentally become the account-enumeration oracle the server
 * refuses to be.
 *
 * THE AUTH-PLANE CHECK RUNS FIRST, BEFORE THE REQUEST, and that ordering is not
 * cosmetic. `signIn` checks it first to avoid a pointless round trip; here it
 * avoids CREATING AN ACCOUNT THIS BUILD CANNOT HOLD A SESSION FOR. Spending the
 * signup budget to mint a credential the app must then throw away is worse than
 * refusing, and the person would have no way to tell the two apart.
 */
export async function signUp(input: {
  email: string;
  password: string;
  confirmPassword: string;
  tosAccepted: boolean;
  /** The legal version whose consent sentence this bundle displayed. */
  legalVersion?: string;
}): Promise<SignUpResult> {
  const client = authClient();
  if (client === null) {
    return {
      ok: false,
      message:
        "Esta compilación de la app no tiene configurado el servidor de sesiones. Avisale a quien te la pasó.",
    };
  }

  const result = await signupRequest(input);
  if (result.outcome !== "ok") {
    return { ok: false, message: apiFailureMessage(result) ?? "No pudimos crear la cuenta." };
  }

  const session = result.payload.session;
  if (session === null) return { ok: true, signedIn: false };

  // Same wrapping as `signIn`, for the same measured reason: `setSession`
  // returns `{ error }` for an AuthError and THROWS for anything else
  // (GoTrueClient.js:2849-2854), and an expo-secure-store write failure is a
  // plain Error. Unwrapped, that rejection propagates into the screen, whose
  // `submit()` has no catch, and the button stays "Creando la cuenta…" forever.
  let stored: { error: unknown } = { error: null };
  try {
    stored = await client.auth.setSession({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    });
  } catch (err) {
    stored = { error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (stored.error) {
    // THE ACCOUNT EXISTS. It was created server-side and nothing here can undo
    // that, so the copy must not say "no pudimos crear la cuenta" — it would
    // send the person back to a form whose next submit answers with the
    // duplicate masquerade and no explanation. Point them at sign-in instead,
    // which is where an existing account is used.
    await clearSession();
    return {
      ok: false,
      message:
        "Creamos tu cuenta, pero no pudimos guardar la sesión en este dispositivo. Entrá desde la pantalla de ingreso con ese mismo email.",
    };
  }

  // Belt and braces, exactly as on the way IN through `signIn`: this device may
  // be shared, and `clearSession` now swallows its own failures, so a stale
  // display cache CAN survive a sign-out.
  await forgetAllCachedCredentials().catch(() => undefined);

  // `/me` RATHER THAN A USER OFF THE SIGNUP RESPONSE, because there is none:
  // `SignupV1` carries a session and nothing else, deliberately. That is also
  // the honest shape — a brand-new account has an identity that is not yet
  // COMPLETE, so `/me` answers `profilePending: true` and the gate sends the
  // person to `identidad-pendiente`, which is step 2 and lives on the web.
  // Fabricating a user here would be this app inventing an answer the server
  // declined to give.
  //
  // "No profile row yet" is what this used to say, and it was never true:
  // `handle_new_user` (db/triggers.sql) inserts the `profiles` row inside the
  // same transaction that creates the account. `profilePending` means THE NAME
  // IS STILL PROVISIONAL — the trigger's `split_part(email, '@', 1)` — which is
  // what `isIdentityPending` detects and why `/me` had to stop testing row
  // existence (native QA batch 1, D1).
  const me = await fetchMe(sessionPort);
  applyMeResult(me);
  // THE `/me` READ CAN FAIL AND THIS USED TO REPORT `signedIn: true` ANYWAY
  // (A1-entrada-03). The screen reads that as "the gate will redirect now" and
  // leaves its button disabled on purpose — so a 503 on this second call left a
  // brand-new account staring at "Creando la cuenta…" with nothing to press and
  // no sentence explaining it. The account EXISTS either way, so the honest
  // answer names that first and points at the door that works.
  if (state.phase !== "signed-in") {
    return {
      ok: false,
      message: `Creamos tu cuenta, pero no pudimos confirmarla con el servidor: ${
        apiFailureMessage(me) ?? "no pudimos conectarnos."
      } Entrá desde la pantalla de ingreso con ese mismo email.`,
    };
  }
  return { ok: true, signedIn: true };
}

export type CompleteIdentityResult = { ok: true } | { ok: false; message: string };

/**
 * Signup STEP 2, in the app: `POST /api/v1/me/identity`.
 *
 * WHAT THIS REPLACES (PO decision 2026-09-05). Until now the only way out of
 * `profilePending: true` was `IDENTITY_COMPLETION_URL` — open a browser, sign in
 * AGAIN (this app holds a bearer token, the web resolves a cookie), type a name
 * there, come back, and cycle the session so the app re-read `/me`. Pilot testers
 * read the second login as "confirm your email" and stopped: 8 invalid-credential
 * attempts and 2 duplicate signups in one hour of GoTrue log. The name is now
 * collected here, and since 2026-09-07 it is the ONLY thing this step collects:
 * the screen's browser link is gone with the DNI field it led to (PO decision —
 * official identity waits for Mi Argentina). So there is no longer any path out
 * of the app in signup step 2, which is what this whole paragraph was about.
 *
 * IT LIVES IN THIS FILE FOR `signOutEverywhere`'S REASON: the call and the
 * session-state transition are ONE act. A screen that made the request and then
 * remembered to update the store is a screen that will one day forget, and the
 * failure would be invisible — the write lands, the person stays on the gate.
 *
 * THE STORED USER COMES FROM THE RESPONSE, NOT FROM A FOLLOW-UP `/me`. The
 * endpoint answers `IdentityCompletedV1` precisely so this can be one round trip:
 * a `fetchMe` here would spend a second call to learn what the first already
 * said, and would leave a window in which `useGate` still refuses. It is the same
 * shape `signIn` uses with `LoginV1.user` and for the same reason — one type, one
 * answer.
 *
 * ON FAILURE THE STATE IS LEFT ALONE, deliberately. `apiRequest` has already
 * ended the session for every code that means the session is over (and set its
 * own reason); for everything else the person is still signed in, still pending,
 * and still looking at a form whose values they have not lost.
 */
export async function completeIdentity(input: {
  firstName: string;
  lastName: string;
}): Promise<CompleteIdentityResult> {
  const result = await completeIdentityRequest(sessionPort, input);
  if (result.outcome !== "ok") {
    // ALREADY DONE IS NOT A FAILURE (A1-entrada-04). The identity can be
    // completed on the WEB — that is where the DNI still lives, and the screen
    // itself offers the link — so somebody who finishes there and comes back to
    // a phone that is still on this form gets a 409 for a step they HAVE taken.
    // The old answer was the code's own sentence ("Ya completaste tus datos.
    // Volvé a Ajustes"), which sends a person to a screen that cannot advance
    // them: the gate only lets go when `/me` says `profilePending: false`, and
    // nothing here was re-reading it. So re-read, and if the server agrees the
    // step is done, this call succeeded — a moment earlier, elsewhere.
    if (result.outcome === "api-error" && result.code === "identity_already_complete") {
      applyMeResult(await fetchMe(sessionPort));
      if (state.phase === "signed-in" && !state.user.profilePending) return { ok: true };
    }
    return { ok: false, message: apiFailureMessage(result) ?? "No pudimos guardar tus datos." };
  }
  setState({ phase: "signed-in", user: result.payload.user });
  return { ok: true };
}

// ===========================================================================
// PASSWORD RECOVERY — THE TWO HALVES, AND WHY THEY GO TO DIFFERENT PLACES
// ===========================================================================
// The REQUEST goes through `/api/v1/auth/password-reset`, for `signIn`'s reason:
// that endpoint spends OUR budgets (`auth_password_reset_ip`,
// `auth_password_reset_email`) inside the same use-case the web form calls, so a
// phone gets no fresh ceiling by being a phone. Calling
// `supabase.auth.resetPasswordForEmail` from here would bypass both.
//
// The REDEMPTION goes to GoTrue DIRECTLY, and that is not the same shortcut
// wearing a different hat. It is the auth plane — `verifyOtp` exchanges a
// mailed credential for a session and `updateUser` replaces a password inside
// `auth.users`; neither reads an application table, so PO decision #2 (no
// PostgREST for pets, events or custody) is untouched. It is the same line
// `AuthSessionV1` draws for token refresh.
//
// WHY THERE IS NO SERVER ENDPOINT FOR THE SECOND HALF. Because there is nothing
// for one to add. A `POST /api/v1/auth/password-reset/confirm` would hold a
// credential the caller already holds, forward it to GoTrue, and forward the
// answer back — a round trip and a second place to get the recovery-token window
// wrong. What it WOULD add is our own ceiling on code guesses, and that is the
// honest cost of not building it: the brute-force bound on a six-digit code is
// GoTrue's `token_verifications` (30 per 5 minutes per IP, supabase/config.toml)
// and not ours. Six digits, one hour of validity, thirty attempts per five
// minutes is a bound; it is not a bound WE chose, and if that ever needs to be
// ours, the confirm endpoint is what to build.
//
// WHY A CODE AND NOT THE LINK, which is the whole design in one paragraph. The
// mail carries the same recovery token twice — a link and a six-digit code.
// Android hands an unverified `https` link to Chrome, because verified App Links
// need a Play-signed fingerprint this project does not have yet (app.config.ts),
// so the link cannot come back into this app. A `mimar://` link would be worse
// rather than better: the scheme is unverified and any installed app may claim
// it, so mailing a recovery credential to it hands account recovery to whoever
// claimed it first. The code is the only channel that survives a device with no
// verified deep links, because it travels through the person's own eyes.
//
// THE DASHBOARD GATE, SAID OUT LOUD RATHER THAN DISCOVERED. Supabase's DEFAULT
// recovery template renders `{{ .ConfirmationURL }}` and nothing else, so the
// six-digit `{{ .Token }}` reaches nobody until the template is edited in the
// Supabase dashboard (PO-gated, exactly like "email confirmations ON" in
// `signup.ts`). Until then this flow's first half works and its second half has
// nothing to type in — which is why `RecuperarScreen` still offers the browser
// bridge as a secondary affordance, and why that bridge is not dead weight.

export type PasswordResetRequestResult = { ok: true } | { ok: false; message: string };

/**
 * Ask for a recovery credential. See the block above for what this is half of.
 *
 * SUCCESS SAYS NOTHING ABOUT THE ADDRESS and this function must never learn to.
 * The server answers the same 202 for an e-mail with an account and one without,
 * because it does not know which it was; a caller that turned the two into
 * different copy would rebuild the enumeration oracle on the phone.
 *
 * NO AUTH-PLANE CHECK FIRST, unlike `signIn` and `signUp`. Those two need a
 * client to store what they get back; this one gets nothing to store. A build
 * with no `EXPO_PUBLIC_SUPABASE_URL` can still send somebody a recovery mail they
 * can redeem in a browser, and refusing here would take that away for a reason
 * that does not apply until the second half.
 */
export async function requestPasswordReset(email: string): Promise<PasswordResetRequestResult> {
  const result = await requestPasswordResetRequest({ email });
  if (result.outcome !== "ok") {
    return {
      ok: false,
      message: apiFailureMessage(result) ?? "No pudimos enviar el correo de recuperación.",
    };
  }
  return { ok: true };
}

export type PasswordResetResult = { ok: true } | { ok: false; message: string };

/**
 * Redeem the six-digit code and set a new password, then land signed in.
 *
 * THE PASSWORD IS VALIDATED BEFORE THE CODE IS SPENT, and the order is the
 * interesting part of this function rather than a style choice. A recovery code
 * is SINGLE-USE: `verifyOtp` consumes it. Checking the new password only after
 * that — which is what the obvious ordering does — means a typo'd confirmation
 * burns the code and sends the person back to ask for another one, on an endpoint
 * that allows five an hour for their address. So the two local rules run first
 * and cost nothing.
 *
 * ON A FAILED `updateUser` THE SESSION IS DROPPED. By then `verifyOtp` has
 * already stored a live recovery session, and leaving it there would give this
 * app a session it never told the store about: the screen shows an error, the
 * person backs out, and the app is signed in while its UI says otherwise. That is
 * the inverse of the "it logs me out sometimes" mystery the storage adapter
 * exists to prevent, and it is worse, because it is a session nobody asked for.
 * The code is burnt either way, so the honest instruction is "pedí un código
 * nuevo".
 *
 * EVERY GoTrue CALL IS WRAPPED, for the reason at the top of this file: auth-js
 * rethrows anything that is not an AuthError, and an expo-secure-store write
 * failure is a plain `Error`. Unwrapped, that rejection propagates into a screen
 * whose `submit()` has no catch and the button never comes back.
 */
export async function resetPasswordWithCode(input: {
  email: string;
  code: string;
  password: string;
  confirmPassword: string;
}): Promise<PasswordResetResult> {
  const client = authClient();
  if (client === null) {
    return {
      ok: false,
      message:
        "Esta compilación de la app no tiene configurado el servidor de sesiones. Avisale a quien te la pasó.",
    };
  }

  // The same two rules `updatePasswordAction` applies on the web, in the same
  // order and with the same sentences — a person who typed the same short
  // password twice should be told the length, not that the two boxes disagree.
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    };
  }
  if (input.password !== input.confirmPassword) {
    return { ok: false, message: "Las contraseñas no coinciden." };
  }

  let verified: { error: unknown } = { error: null };
  try {
    const { error } = await client.auth.verifyOtp({
      email: input.email,
      token: input.code,
      type: "recovery",
    });
    verified = { error };
  } catch (err) {
    verified = { error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (verified.error) {
    // ONE SENTENCE FOR EVERY CAUSE, and that is a security property rather than
    // laziness. A wrong code, an expired code, a code for an address that has no
    // account and a code already spent all arrive here, and telling them apart
    // would answer "does this e-mail have an account" — the exact question the
    // request half refuses. It also names the recovery, which is what a person
    // who mistyped one digit actually needs.
    return {
      ok: false,
      message: "El código no es válido o ya venció. Pedí uno nuevo y volvé a intentar.",
    };
  }

  let updated: { error: unknown } = { error: null };
  try {
    const { error } = await client.auth.updateUser({ password: input.password });
    updated = { error };
  } catch (err) {
    updated = { error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (updated.error) {
    await clearSession();
    return {
      ok: false,
      message: "No pudimos cambiar la contraseña. Pedí un código nuevo y volvé a intentar.",
    };
  }

  // MED-5 parity with the web's `updatePasswordAction`: a reset is the canonical
  // response to a compromised account, so any session an attacker minted before
  // it must die. `scope: "others"` spares the recovery session this device is
  // holding, which is what keeps the person signed in on the phone they just
  // recovered. Best-effort on purpose — the password is already changed, and a
  // transient failure here must not be reported as a failed reset.
  try {
    await client.auth.signOut({ scope: "others" });
  } catch {
    // Ignored, deliberately. See above.
  }

  // The device may be shared. Same reasoning as `signIn`.
  await forgetAllCachedCredentials().catch(() => undefined);

  // `/me` rather than a fabricated user: this account may be mid-signup, in which
  // case the gate belongs at `identidad-pendiente` and not at the pet list. The
  // same call `signUp` makes, for the same reason.
  const me = await fetchMe(sessionPort);
  applyMeResult(me);
  // Same trap as `signUp`, one step sharper (A1-entrada-03): the PASSWORD IS
  // ALREADY CHANGED and the code is already spent, so a failure here must never
  // read as "the reset did not work" — that sends somebody to ask for a second
  // code with the new password in their hands. It says what happened and where
  // to go.
  if (state.phase !== "signed-in") {
    return {
      ok: false,
      message: `Cambiamos tu contraseña, pero no pudimos abrir la sesión: ${
        apiFailureMessage(me) ?? "no pudimos conectarnos."
      } Entrá desde la pantalla de ingreso con la contraseña nueva.`,
    };
  }
  return { ok: true };
}

/**
 * "Cerrar sesión" — this device.
 *
 * `endedAt` IS REQUIRED, not optional, and TypeScript is the enforcement. It is
 * the path the person was standing on when they pressed the button, and the
 * gate needs it to know WHICH screen must not be re-opened at the next sign-in
 * (`signedOutHref`). A call site that could omit it would silently re-open the
 * bug in one direction or the other: default "suppress everywhere" swallows a
 * deep link's destination, default "suppress nowhere" resurrects the screen the
 * person just closed.
 */
export async function signOut(endedAt: string): Promise<void> {
  await clearSession();
  sweepDraftsOnDeliberateExit();
  setState({ phase: "signed-out", reason: "user_action", endedAt });
}

/**
 * Remove every event draft on the device — called by the three DELIBERATE exits
 * only: "Cerrar sesión", "Cerrar sesión en todos los dispositivos" (success arm)
 * and "Eliminar mi cuenta" (success arm). PO decision 4A. Plus the two TERMINAL
 * answers the server can give (`account_erased`, `account_deactivated`, through
 * `sessionPort.endSession`): the account is gone or locked, which is the same
 * "done" the erasure arm means, reached without the person's app hearing it.
 *
 * DRAFTS ARE SWEPT HERE AND NOT IN `clearSession`, and the distinction is the
 * whole of the decision. `clearSession` is the funnel EVERY session end passes
 * through, including the refused arm of `accessToken()` — a refresh that fails
 * on a bad connection. Sweeping there would mean an auth blip mid-form destroys
 * what somebody was writing, which is the exact loss the draft feature exists to
 * prevent, delivered by the fix. These callers are the other kind of ending: a
 * person said they are done, and a draft of a bite holds a THIRD party's name
 * and phone (the victim), who never agreed to sit on this phone until the
 * seven-day prune. On the erasure path that would be the Ley 25.326 art. 16
 * supresión leaving personal data behind on the very device that asked for it.
 *
 * WHAT THIS DOES NOT BUY, so nobody mistakes it for the fence: confidentiality
 * between two people sharing a phone is already bought by the owner id inside
 * every draft key (`event-draft-store.ts`) — person B cannot name, let alone
 * read, person A's draft. This only stops the bytes from sitting in the app
 * sandbox on the exits where the person has said they are done.
 *
 * Deliberately NOT awaited before the state change: a storage failure must not
 * keep somebody signed in. Best-effort, like every other local sweep on these
 * paths; the `.catch` keeps a broken storage from becoming an unhandled
 * rejection even though `forgetAllEventDrafts` promises not to reject.
 *
 * SWEEPS THE ALTA WIZARD'S DRAFT TOO (Re-2, decision 16A): it is a second,
 * separate AsyncStorage prefix (`alta-draft-store.ts`), keyed by owner id the
 * same way, and the argument for sweeping it here is identical — a
 * half-registered pet's locality and photo URI must not survive into another
 * account on the same phone.
 */
function sweepDraftsOnDeliberateExit(): void {
  // BUMPED FIRST AND SYNCHRONOUSLY, before the sweep takes its snapshot of the
  // keys: a form still on screen asks this number at write time, and any write
  // it attempts from here on must already see the new value.
  draftSweeps += 1;
  void forgetAllEventDrafts().catch(() => undefined);
  void forgetAllAltaDrafts().catch(() => undefined);
  // The files handed to the share sheet (M13): the art. 14 export is the whole
  // record, a lost-pet poster carries the owner's phone. Same exits, same
  // reasoning as the drafts — see `native/file-share.ts`. Never throws.
  forgetSharedFiles();
}

/**
 * How many draft sweeps this process has run. Only ever grows.
 *
 * IT EXISTS SO A FORM CAN TELL "THE SESSION IS NOT SIGNED-IN RIGHT NOW" APART
 * FROM "THE DRAFTS WERE SWEPT" (A2c). Those are different facts and only the
 * second one forbids a write. A refresh that times out moves the phase to
 * `session-unverified`, and a refused one to `signed-out` with `auth_expired`;
 * in both the tokens or the person are coming back, and the form that unmounts
 * on the way (the gate swaps in another screen) must still save what was typed.
 * A sweep, on the other hand, is a person saying they are done — or the server
 * saying the account is — and a write landing behind it would put back the very
 * bytes the sweep was for. `use-event-draft` captures this number with its owner
 * and refuses to write once it has moved.
 */
let draftSweeps = 0;

export function draftSweepEpoch(): number {
  return draftSweeps;
}

export type RevokeResult = { ok: true } | { ok: false; message: string };

/**
 * "Cerrar sesión en todos los dispositivos".
 *
 * A 200 means THIS session is gone too — GoTrue rejects the access token
 * immediately and the refresh comes back `refresh_token_not_found` (measured).
 * So on success the tokens are dropped and the user goes to sign-in, and NOTHING
 * tries to refresh on the way out: that refresh is guaranteed to fail, and its
 * failure would surface as "tu sesión venció", which reads like a bug instead of
 * like the thing the user just asked for.
 *
 * On failure the session is left ALONE. A half-done revocation that also signs
 * you out locally is the worst of both: the other devices keep working and you
 * lost the one you were holding.
 */
export async function signOutEverywhere(endedAt: string): Promise<RevokeResult> {
  // THE PUSH REVOKE GOES FIRST, AND IT IS THE ONE PLACE IN THIS FILE WHERE THE
  // ORDER IS NOT A MATTER OF TASTE.
  //
  // `clearSession()` revokes this device's push target on its way out, which is
  // correct for every other exit — the tokens are still in hand when it runs. It
  // is NOT correct here, and this function was the counter-example all along.
  // `revokeAllSessions` kills THIS session too: the moment it answers 200, the
  // access token is refused by GoTrue and the refresh token is gone (the
  // docblock above measured exactly that). So the revoke `clearSession` then
  // makes goes out with a dead bearer, comes back 401, and changes nothing.
  //
  // The scenario that makes it matter is the one the button is FOR. Somebody's
  // phone is gone; they sign in somewhere else and press "cerrar sesión en todos
  // los dispositivos". Every session dies — and the phone in a stranger's pocket
  // keeps its live `push_targets` row and keeps lighting up, because a push is
  // delivered server-side and never consults a session. Moving the call above
  // `revokeAllSessions` is what makes the request carry a credential that still
  // works.
  //
  // IT IS NOT THE WHOLE FIX AND MUST NOT BE MISTAKEN FOR ONE: this only ever
  // reaches the device in the caller's hand. The device the person is trying to
  // cut off is silenced by the SERVER, which revokes every target for the user
  // inside `POST /api/v1/me/revoke-sessions`. This half is what keeps the phone
  // that pressed the button from re-registering nothing and from being the one
  // exception to its own act.
  const pushRevocation = await revokeThisDeviceForPush(sessionPort).catch(
    (): PushRevocationOutcome => ({ outcome: "failed", detail: "threw" }),
  );
  reportFailedPushRevocation(pushRevocation);

  const result = await revokeAllSessions(sessionPort);
  if (result.outcome !== "ok") {
    // THE REVOKE FAILED, SO THE PHONE IN THIS PERSON'S HAND HAS TO GET ITS
    // DELIVERY ROW BACK — and nothing else in the app will do it for us.
    //
    // This arm returns without calling `clearSession`, which is right: a
    // half-done revocation that also signed this device out is the worst of
    // both. But the push revoke ABOVE already landed, and the session stays
    // `signed-in`, so no state transition ever reaches
    // `startPushRegistration`'s listener — and even if one did, its
    // `registeredFor` marker still equals this user's id and would short it
    // out. The row is revoked server-side and this install would never
    // re-register until the app was restarted: the person keeps using miMAR
    // and silently never gets another urgent lost-pet push on this phone. A
    // failure of "cerrar sesión en todos los dispositivos" must not be a
    // permanent, invisible mute of the one device that pressed it.
    //
    // RE-REGISTER RATHER THAN JUST CLEARING THE MARKER, because clearing it
    // only arms a retry for a transition that may not come for hours. The
    // credential is still live — `revokeAllSessions` FAILING is exactly the
    // case where this session survived — so the request can land now.
    // `registerThisDeviceForPush` is idempotent by contract, it upserts one row
    // on `device_id`, and it asks for no permission this install has not
    // already been granted, so a person who declined is not re-prompted.
    //
    // BEST EFFORT, AND SILENT. There is no surface for "no pudimos volver a
    // encender las notificaciones de este teléfono", and the sentence this
    // function returns is about the sessions, which is what was asked and what
    // failed.
    await registerThisDeviceForPush(sessionPort).catch(() => undefined);
    return {
      ok: false,
      message: apiFailureMessage(result) ?? "No pudimos cerrar las otras sesiones.",
    };
  }
  // `pushAlreadyRevoked` regardless of the outcome above: the credential that
  // could have carried a retry is dead now, so a second attempt is a round trip
  // that can only answer 401. The failure was already reported.
  await clearSession({ pushAlreadyRevoked: true });
  // A deliberate exit, like "Cerrar sesión" — and the one somebody reaches for
  // when a phone is being handed over or was lost. See the helper.
  sweepDraftsOnDeliberateExit();
  setState({ phase: "signed-out", reason: "revoked_all", endedAt });
  return { ok: true };
}

export type EraseAccountResult = { ok: true } | { ok: false; message: string };

/**
 * "Eliminar mi cuenta" — Ley 25.326 art. 16, from the phone.
 *
 * IT LIVES HERE AND NOT IN THE SCREEN for the reason `signOutEverywhere` does:
 * the call and the session teardown are one act, and a screen that made the
 * request and then remembered to clear the keychain is a screen that will one
 * day forget. Anything that ends this session ends it in this file.
 *
 * THE SUCCESS ARM DROPS THE TOKENS AND NOTHING TRIES TO REFRESH. `auth.users` is
 * deleted inside the erasure, so the access token in hand is already dead and a
 * refresh is guaranteed to fail — and its failure would surface as "tu sesión
 * venció", which reads like a bug instead of like the thing the person just
 * asked for. Exactly the trap `signOutEverywhere` documents, one step harder:
 * there is no longer an account for the token to belong to.
 *
 * THE REASON IS `account_erased`, which already existed in the vocabulary with
 * the copy "Esta cuenta ya no existe." — written for the arm where the SERVER
 * refuses a request from an erased account. It is the same fact and the same
 * sentence, so the sign-in screen says the true thing whether the person got
 * here by finishing a supresión or by opening an app whose account was erased
 * from the web.
 *
 * ON FAILURE THE SESSION IS LEFT ALONE. A refused erasure that also signed
 * somebody out would leave them staring at a login screen with no idea whether
 * their account still exists — and the honest answer, "it does, try again", is
 * unavailable from there.
 */
export async function eraseAccount(reason: string, endedAt: string): Promise<EraseAccountResult> {
  const result = await eraseMyAccount(sessionPort, { command: "erase_account", reason });
  if (result.outcome !== "ok") {
    return {
      ok: false,
      message: apiFailureMessage(result) ?? "No pudimos completar la baja.",
    };
  }
  // The device may be shared, and the cached credentials of pets this person no
  // longer holds must not survive the account that held them. Same call and same
  // reasoning as `signIn`/`signOut`; best-effort, because a cache that refuses to
  // clear must not turn a completed supresión into an error message.
  await forgetAllCachedCredentials().catch(() => undefined);
  await clearSession();
  // The supresión must not leave a bite victim's name and phone behind in a
  // draft on the device that asked for it. See the helper.
  sweepDraftsOnDeliberateExit();
  setState({ phase: "signed-out", reason: "account_erased", endedAt });
  return { ok: true };
}

/** es-AR copy for why the sign-in screen is showing. Exhaustive. */
export function sessionEndMessage(reason: SessionEndReason | null): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "auth_expired":
      return "Tu sesión venció. Iniciá sesión de nuevo.";
    case "session_shift_expired":
      return "Tu turno de trabajo terminó. Volvé a iniciar sesión para seguir.";
    case "auth_required":
      return "Tu sesión ya no es válida en el servidor. Iniciá sesión de nuevo.";
    case "account_deactivated":
      return "Esta cuenta está desactivada. Si la desactivaste vos, podés volver a activarla desde Mi cuenta en la web; si la desactivó tu organización, hablá con ella.";
    case "account_erased":
      return "Esta cuenta ya no existe.";
    case "revoked_all":
      return "Cerraste la sesión en todos los dispositivos, incluido este.";
    case "user_action":
      return null;
  }
}

/** Exported for the storage test's key layout assertions. */
export { AUTH_STORAGE_KEY };
