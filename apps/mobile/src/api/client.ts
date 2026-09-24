// The one place this app talks to `/api/v1`.
//
// WHY A UNION AND NOT `throw`
// ---------------------------------------------------------------------------
// Most of the outcomes below are NORMAL operation, not exceptions: a 429 from
// the limiter, a 404 for a token that resolves to nothing, a 503, and a phone
// with no signal. Modelling them as thrown errors pushes every screen into a
// single `catch` that can only say "algo salió mal", which is the copy this
// product's per-section honesty exists to avoid. The shape is the one
// `credential-api.ts` established in M1; this module generalises it rather than
// starting a second vocabulary beside it.
//
// TWO LAYERS, AND THE SPLIT IS LOAD-BEARING
// ---------------------------------------------------------------------------
//   `performRequest` — transport only. Answers "did the server answer, and with
//   what status and body". It knows nothing about sessions or payload versions,
//   which is what lets the PUBLIC credential read (whose 503 carries a readable
//   degraded envelope, not a bare `{ error }`) use the same transport as every
//   authenticated read without pretending its 503 is an error.
//
//   `apiRequest` — the bearer layer. Attaches the token, maps the envelope
//   through the ONE exhaustive switch in `error-copy.ts`, gates the payload
//   version, and owns the entire session-ending policy below.
//
// THE SESSION POLICY, STATED ONCE HERE SO NO SCREEN RE-DERIVES IT
// ---------------------------------------------------------------------------
//   401 `auth_expired`          → refresh ONCE, retry ONCE. Still 401 → sign out.
//   401 `session_shift_expired` → sign out immediately, NEVER refresh. The
//                                 refresh would SUCCEED (the token is valid at
//                                 GoTrue; the 8-hour shift is our policy) and
//                                 the retry would be refused again, forever.
//                                 The web app paid for this lesson on
//                                 2026-07-04 as a redirect loop; the native
//                                 shape of the same bug is a retry loop.
//   401 `auth_required`         → the server saw no bearer at all. Sign out: our
//                                 idea of "signed in" and the server's disagree,
//                                 and the only honest resolution is a fresh
//                                 sign-in.
//   403 deactivated / erased    → sign out. The session is live and useless.
//
// ONE refresh, ONE retry. Not a loop with a counter: a counter is a knob, and a
// knob on this particular code path is how a client ends up hammering GoTrue on
// behalf of a user who is simply signed out.

import type { ApiV1ErrorCode } from "@dim/contract/api";

import { API_BASE_URL } from "../config/api";
import { reportHandledFailure, telemetryPath } from "../observability/report";
import { apiErrorMessage, apiV1ErrorCode, carriesUnknownErrorCode } from "./error-copy";

/** Nothing in this app is worth a spinner that never ends. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Why a session ended. Each value has its own sentence on the sign-in screen. */
export type SessionEndReason =
  | "auth_expired"
  | "session_shift_expired"
  | "auth_required"
  | "account_deactivated"
  | "account_erased"
  | "revoked_all"
  | "user_action";

/**
 * What `apiRequest` needs from the session, as a port.
 *
 * A port rather than a direct import of the supabase client for one concrete
 * reason: the refresh-and-retry policy above is the single most test-worthy
 * behaviour in this app, and a native module (`expo-secure-store`) cannot run
 * under Jest. With a port the policy is exercised with three fakes and no mocks
 * of anything native.
 */
/**
 * What came back from a refresh attempt — and WHY "it failed" is not one answer.
 *
 * TWO FAILURES, TWO DIFFERENT FACTS ABOUT THE SESSION (native QA batch 2, D7):
 *
 *   · `refused`     — GoTrue examined the refresh token and said no (rotated,
 *                     revoked, the session timeboxed out). The session is over
 *                     and no amount of waiting fixes it.
 *   · `unreachable` — the refresh request never reached a server. auth-js wraps
 *                     that in `AuthRetryableFetchError` and RETURNS it
 *                     (lib/fetch.js:33-40); nothing was examined and nothing was
 *                     refused. The refresh token on the device is still perfectly
 *                     good.
 *
 * They used to collapse into `null`, and `apiRequest` answered both by calling
 * `endSession("auth_expired")` — so one dead spot at the wrong moment signed a
 * person out and made them retype a password, over a session GoTrue would have
 * renewed. The screen said "Tu sesión venció", which was not true.
 *
 * `session-store.ts` already draws exactly this line for `signIn` (see the long
 * note above `setSession` there, and `isAuthRetryableFetchError`): the same file
 * knew the distinction and this port could not carry it.
 */
export type RefreshOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: "refused" | "unreachable" };

export type SessionPort = {
  /** The current access token, or null when there is no session at all. */
  accessToken(): Promise<string | null>;
  /** Refresh against GoTrue. See RefreshOutcome for why failure has two arms. */
  refreshAccessToken(): Promise<RefreshOutcome>;
  /** Drop the local session and send the user to sign-in, with a reason. */
  endSession(reason: SessionEndReason): Promise<void>;
};

export type RawResponse =
  /** The server answered and the body parsed as JSON. */
  | { transport: "answered"; status: number; body: unknown; retryAfterSeconds: number | null }
  /** Connected, answered, and the body was not JSON we could read. */
  | { transport: "malformed"; detail: string }
  /** Never got an answer: no signal, DNS, TLS, or the timeout above. */
  | { transport: "unreachable"; detail: string };

/**
 * Eight hex characters naming the Sentry event this failure produced, when one
 * was produced (OBS-3). Optional on purpose: it is added by `apiRequest` after
 * `interpret` runs, it is absent on every arm nobody reports, and every switch
 * over `outcome` in this app keeps compiling without touching it.
 */
type Correlated = { correlationId?: string };

export type ApiResult<T> =
  | { outcome: "ok"; payload: T }
  | ({ outcome: "api-error"; code: ApiV1ErrorCode; retryAfterSeconds: number | null } & Correlated)
  /** `received` is `null` when the field was absent or not a number at all. */
  | ({ outcome: "unsupported-version"; received: number | null } & Correlated)
  | ({ outcome: "malformed"; detail: string } & Correlated)
  | { outcome: "unreachable"; detail: string };

export type RequestSpec = {
  /** Path under the origin, e.g. `/api/v1/me/pets`. */
  path: string;
  method?: "GET" | "POST";
  /** Serialized as JSON. Omit for GET. */
  body?: unknown;
  /** Extra headers — `idempotency-key`, and nothing else so far. */
  headers?: Record<string, string>;
  /**
   * The `payloadVersion` this build understands. When given, a payload that
   * declares anything else is `unsupported-version` BEFORE any field is read.
   *
   * The contract exports these constants and says they are "bumped when a change
   * would break an existing client's parse"; a client that ships the constant
   * and never compares it has taken the cost of the version field and none of
   * its benefit. An old build should say "actualizá la app", not render half a
   * screen from a shape it is guessing at.
   */
  expectedPayloadVersion?: number;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `retry-after`, in seconds, when the server sent a usable one.
 *
 * Only the numeric form is read. The HTTP-date form is legal and this API never
 * emits it; guessing at a date would produce a countdown from a clock we do not
 * control, and a wrong countdown is worse than none.
 */
function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * One request. No retry, no backoff loop, no polling timer anywhere.
 *
 * The retry that DOES exist lives one layer up and fires only after a token
 * refresh — i.e. only when the first attempt failed for a reason a second
 * attempt can actually fix.
 */
export async function performRequest(
  spec: RequestSpec,
  init: { authorization?: string } = {},
): Promise<RawResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // The transport and the body are read in SEPARATE try blocks because they
    // fail for different reasons and a user can act on only one of them. Folded
    // together, a truncated or non-JSON body reports "revisá tu conexión" to
    // someone whose connection is fine — a false diagnosis, and the kind that
    // sends people to restart their router while the server is the problem.
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${spec.path}`, {
        method: spec.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.authorization ? { authorization: init.authorization } : {}),
          ...spec.headers,
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      return { transport: "unreachable", detail: describeError(error) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // THE STATUS IS READ FIRST, AND IT USUALLY ANSWERS THE QUESTION
      // (A6-cuenta-resiliencia-07). A 502 from a load balancer, a 503 from a
      // deploy and a captive portal's login page all arrive as a body that will
      // not parse — and reporting "el servidor respondió algo que no pudimos
      // leer" for them describes the JSON rather than the outage, on a screen
      // whose person can only act on the outage. A non-2xx WITH an unreadable
      // body is a refusal we could not read the code of, which `interpret`
      // already has an honest answer for (`temporarily_unavailable`, plus the
      // `retry-after` this same response may carry).
      //
      // A 2xx whose body will not parse stays `malformed`, and that distinction
      // is the point: there the transport worked, the server said yes, and what
      // is broken really is the payload.
      if (response.status < 200 || response.status >= 300) {
        return {
          transport: "answered",
          status: response.status,
          body: null,
          retryAfterSeconds: retryAfterSeconds(response.headers),
        };
      }
      return { transport: "malformed", detail: describeError(error) };
    }

    return {
      transport: "answered",
      status: response.status,
      body,
      retryAfterSeconds: retryAfterSeconds(response.headers),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Maps a transport answer onto the typed result. No session logic here. */
function interpret<T>(raw: RawResponse, spec: RequestSpec): ApiResult<T> {
  if (raw.transport === "unreachable") return { outcome: "unreachable", detail: raw.detail };
  if (raw.transport === "malformed") return { outcome: "malformed", detail: raw.detail };

  if (raw.status < 200 || raw.status >= 300) {
    // An unrecognised code is a contract violation, not something to display
    // raw. Anything unexpected reads as a failed read, never as 404 — answering
    // 404 to a read failure is what the contract calls "the worst lie a public
    // surface can tell".
    const code = apiV1ErrorCode(raw.body);
    if (code !== null) {
      return { outcome: "api-error", code, retryAfterSeconds: raw.retryAfterSeconds };
    }
    // A 4xx THAT DECLARED A CODE THIS BUILD DOES NOT KNOW IS VERSION SKEW, not
    // an outage (CANON-451, critic gap 3). `/api/v1` answers every 4xx from a
    // closed vocabulary, so a string outside it can only mean the server is
    // newer than this bundle — and an OTA channel makes exactly that ordinary.
    // Calling it `temporarily_unavailable` told the person to wait for a code
    // that will still be unknown tomorrow.
    //
    // 5xx is left alone deliberately: a load balancer's `{"error":"Bad
    // Gateway"}` is an outage, and telling somebody to update their app during
    // one is the same lie in the other direction.
    //
    // AND SO ARE 401, 403 AND 429, BELT AND BRACES (P1, review 2026-09-07).
    // Those three are answered by layers that are NOT this app's `/api/v1`
    // vocabulary — an auth proxy, a WAF, a rate limiter, a platform edge — and
    // any of them can put a string in `error` that this build has never heard
    // of. "Actualizá la app" is the wrong instruction for every one of them:
    // signing in again, waiting, or nothing at all is. Today `apiV1ErrorCode`
    // recognises the codes those statuses actually carry, so this guard changes
    // no measured behaviour; it is here so that the day something in front of
    // the app answers 429 with its own vocabulary, the app does not tell a whole
    // fleet to update.
    const skewCandidate = raw.status !== 401 && raw.status !== 403 && raw.status !== 429;
    if (
      raw.status >= 400 &&
      raw.status < 500 &&
      skewCandidate &&
      carriesUnknownErrorCode(raw.body)
    ) {
      return { outcome: "unsupported-version", received: null };
    }
    return {
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }

  if (spec.expectedPayloadVersion !== undefined) {
    const declared = (raw.body as { payloadVersion?: unknown } | null)?.payloadVersion;
    if (declared !== spec.expectedPayloadVersion) {
      return {
        outcome: "unsupported-version",
        received: typeof declared === "number" ? declared : null,
      };
    }
  }

  return { outcome: "ok", payload: raw.body as T };
}

/**
 * The api-error codes worth a Sentry event, and it is a SHORT list on purpose.
 *
 * Everything else in the vocabulary is either a person's situation (`not_found`,
 * `duplicate_pet_suspected`, `transfer_expired`) or an outage the server has
 * already logged with far more context than a phone can add (`*_failed`,
 * `temporarily_unavailable`). Reporting those would file thousands of events
 * that say nothing and bury the two below.
 *
 * These two mean THIS BUILD AND THIS SERVER DISAGREE — the app sent a body or a
 * header the server could not accept — which is exactly the version-skew class
 * an OTA channel can create (CANON-451) and the one class no server log
 * attributes to a client build.
 */
const REPORTABLE_API_ERROR_CODES: ReadonlySet<ApiV1ErrorCode> = new Set<ApiV1ErrorCode>([
  "invalid_request",
  "idempotency_key_required",
]);

/**
 * File the handled failure, and stamp the result with the id the screen prints.
 *
 * `unreachable` is deliberately NOT reported: a phone in a lift is not a defect,
 * and the events would arrive by the thousand from the subway and drown the one
 * malformed payload that mattered.
 */
function reportFailure<T>(result: ApiResult<T>, route: string): ApiResult<T> {
  if (result.outcome === "ok" || result.outcome === "unreachable") return result;
  if (result.outcome === "api-error" && !REPORTABLE_API_ERROR_CODES.has(result.code)) return result;

  const correlationId = reportHandledFailure({
    surface: "api",
    failure: result.outcome,
    route,
    ...(result.outcome === "api-error" ? { code: result.code } : {}),
  });
  return { ...result, correlationId };
}

/** The codes that mean "this session is over", with the reason to end it under. */
function sessionEndingReason(code: ApiV1ErrorCode, status: number): SessionEndReason | null {
  if (status === 401) {
    if (code === "session_shift_expired") return "session_shift_expired";
    if (code === "auth_required") return "auth_required";
    if (code === "auth_expired") return "auth_expired";
  }
  if (status === 403) {
    if (code === "account_deactivated") return "account_deactivated";
    if (code === "account_erased") return "account_erased";
  }
  return null;
}

/**
 * A bearer request against `/api/v1`, with the session policy in the header
 * applied exactly once.
 */
export async function apiRequest<T>(
  spec: RequestSpec,
  session: SessionPort,
): Promise<ApiResult<T>> {
  const token = await session.accessToken();
  if (token === null) {
    // No session at all. NOT an `endSession` call: there is nothing to end, and
    // calling it would fire the "your session ended" copy at somebody who simply
    // opened the app signed out.
    return { outcome: "api-error", code: "auth_required", retryAfterSeconds: null };
  }

  let raw = await performRequest(spec, { authorization: `Bearer ${token}` });

  // The refresh-and-retry arm. Reached ONLY for a 401 that a new access token
  // could plausibly fix — which is `auth_expired` and nothing else.
  if (raw.transport === "answered" && raw.status === 401) {
    const code = apiV1ErrorCode(raw.body);
    if (code === "auth_expired") {
      const refreshed = await session.refreshAccessToken();
      // A REFRESH THAT NEVER REACHED A SERVER IS NOT AN EXPIRED SESSION (native
      // QA batch 2, D7). Ending the session here would sign somebody out — and
      // make them retype a password — over a dead spot, holding a refresh token
      // GoTrue would have honoured a second later. It is reported as what it is:
      // a request that could not be made, which every screen already renders as
      // "revisá tu conexión" with a retry.
      if (!refreshed.ok && refreshed.reason === "unreachable") {
        return { outcome: "unreachable", detail: "refresh unreachable" };
      }
      if (!refreshed.ok) {
        await session.endSession("auth_expired");
        return { outcome: "api-error", code: "auth_expired", retryAfterSeconds: null };
      }
      raw = await performRequest(spec, { authorization: `Bearer ${refreshed.token}` });
    }
  }

  const result = interpret<T>(raw, spec);

  if (result.outcome === "api-error" && raw.transport === "answered") {
    const reason = sessionEndingReason(result.code, raw.status);
    // Reached on the SECOND attempt too, which is the whole point: a refresh
    // that succeeded and a retry that was still refused means the session is
    // over for a reason a token cannot fix.
    if (reason !== null) await session.endSession(reason);
  }

  return reportFailure(result, telemetryPath(spec.path));
}

/**
 * es-AR copy for a result. `null` only for the success arm.
 *
 * The switch has no `default` and no trailing return, so adding an outcome
 * without adding its copy does not compile.
 *
 * The 429 refinement in front of it is deliberate and is NOT a second switch: it
 * replaces one arm's sentence with a more specific one IF the server ever tells
 * us how long to wait. It does not today — no `/api/v1` 429 sets `Retry-After`
 * yet (`docs/architecture/api-invariants.md:860` records why: only one of the
 * two 429 branches can carry an honest value today, and setting it on one and
 * not the other would fabricate a hint on the other). This branch is defensive
 * against a future server that closes that gap, not dead code: when it does,
 * "Esperá un momento" (honest but useless) becomes "en 30 segundos" — what
 * stops a person tapping the button eight more times and spending the budget
 * of the finder standing over a lost animal in the street.
 */
export function apiFailureMessage(result: ApiResult<unknown>): string | null {
  const sentence = failureSentence(result);
  if (sentence === null) return null;
  // THE CORRELATION ID, WHERE THE PERSON CAN READ IT (OBS-3). A tester says "no
  // me dejó entrar"; without a shared token the only way to find their event is
  // to guess at a timestamp across fourteen phones. Eight hex characters is
  // short enough to read out over WhatsApp and specific enough to land on one
  // event.
  //
  // ADDED HERE AND NOT IN THE NOTICE COMPONENTS, and the reason is that this is
  // the only function that sees the `ApiResult` the id is attached to —
  // `ErrorNotice`, `StaleNotice` and `Callout` all receive a finished string.
  // The consequence is worth stating: the 23 screens that still hand-roll their
  // own `failureMessage` switch instead of calling this (A6-cuenta-resiliencia-14)
  // do NOT print a code, and they will start to on the day those switches are
  // deleted — which is the point of deleting them.
  //
  // Only a REPORTED failure carries an id, so the ordinary refusals (`not_found`,
  // `rate_limited`, a dead spot) keep their sentence exactly as it was: a code
  // nobody can look up is noise on a screen somebody is already annoyed at.
  const correlationId = "correlationId" in result ? result.correlationId : undefined;
  return correlationId === undefined ? sentence : `${sentence}\nCódigo: ${correlationId}`;
}

function failureSentence(result: ApiResult<unknown>): string | null {
  if (
    result.outcome === "api-error" &&
    result.code === "rate_limited" &&
    result.retryAfterSeconds !== null
  ) {
    const seconds = result.retryAfterSeconds;
    return seconds === 1
      ? "Demasiadas consultas. Probá de nuevo en 1 segundo."
      : `Demasiadas consultas. Probá de nuevo en ${seconds} segundos.`;
  }

  switch (result.outcome) {
    case "ok":
      return null;
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return `Esta versión de la app no entiende la respuesta del servidor (v${
        result.received ?? "desconocida"
      }). Actualizá la app.`;
    case "malformed":
      return "El servidor respondió algo que no pudimos leer. Volvé a intentar.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
  }
}
