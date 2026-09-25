// The session store's failure paths — the ones auth-js reaches by THROWING.
//
// WHY THESE AND NOT THE HAPPY PATH
// ---------------------------------------------------------------------------
// auth-js 2.105.4 rethrows anything that is not an AuthError: `_setSession`
// (GoTrueClient.js:2849-2854) and `_callRefreshToken` (:3935-3936) both end in
// `throw error` for a non-AuthError. A failure coming out of `expo-secure-store`
// is a plain `Error`. So the Keystore failure this module has an es-AR message
// for did not arrive as `{ error }` — it arrived as a rejected promise, and the
// branch that names it was unreachable for exactly the case it names.
//
// Every one of these failures is a screen that never comes back: a sign-in
// button stuck on "Ingresando…", a splash that never resolves, a spinner behind
// `void load()`. None of them is visible in a type and none of them shows up in
// a happy-path test, which is why they get their own file.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
// The REAL error classes, not hand-rolled stand-ins: `isAuthRetryableFetchError`
// matches on `isAuthError(e) && e.name === "AuthRetryableFetchError"`, so a fake
// with the right shape would pin the fake. `@supabase/supabase-js` re-exports
// everything from `@supabase/auth-js` (dist/index.d.mts: `export * from`).
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// The `mock` prefix is load-bearing, not a naming preference: babel-plugin-jest-
// hoist lifts `jest.mock` factories above the imports and refuses any factory
// that closes over an out-of-scope variable — except one whose name begins with
// `mock`. Without the prefix this file fails to TRANSFORM, with an error about
// the factory rather than about the test.
type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const mockAuth: Record<"getSession" | "setSession" | "refreshSession" | "signOut", AsyncMock> = {
  getSession: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  setSession: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  refreshSession: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  signOut: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
};

const mockDropLocalSession: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockForgetAllCachedCredentials: AsyncMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockLogin: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchMe: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSignup: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCompleteIdentity: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();

const mockReadStoredSession = jest.fn<() => Promise<string | null>>();
const mockRestoreStoredSession = jest.fn<(raw: string) => Promise<void>>();

jest.mock("./supabase-auth", () => ({
  AUTH_STORAGE_KEY: "mimar.auth.session",
  authClient: () => ({ auth: mockAuth }),
  dropLocalSession: () => mockDropLocalSession(),
  readStoredSession: () => mockReadStoredSession(),
  restoreStoredSession: (raw: string) => mockRestoreStoredSession(raw),
}));

jest.mock("../credential/credential-cache", () => ({
  forgetAllCachedCredentials: () => mockForgetAllCachedCredentials(),
}));

/**
 * The push revoke, mocked for the same reason `forgetAllCachedCredentials` is:
 * it is a side effect of ending a session, it reaches the network, and what
 * matters here is WHEN the store calls it — not what it does.
 *
 * IT FORWARDS ITS ARGUMENT, and that is a correction rather than a detail. This
 * stub used to be `() => mockRevokeThisDeviceForPush()`, which drops the
 * `SessionPort` the store hands it — so every assertion below still passed with
 * the argument deleted from the call site, and the one thing that makes the
 * revoke authenticated was untested. A stub that discards what it receives can
 * only ever prove that a function was reached.
 */
const mockRevokeThisDeviceForPush: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRegisterThisDeviceForPush: AsyncMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../notifications/push-registration", () => ({
  revokeThisDeviceForPush: (...args: unknown[]) => mockRevokeThisDeviceForPush(...args),
  registerThisDeviceForPush: (...args: unknown[]) => mockRegisterThisDeviceForPush(...args),
}));

/**
 * The breadcrumb trail, captured (OBS-6, finding L2).
 *
 * The SDK, not `observability/report`: mocking the reporter would prove the
 * store calls a function this file wrote, which is the assertion that never
 * catches anything. This proves the crumb reaches the transport.
 */
const mockCrumbs: { category?: string; message?: string }[] = [];
/**
 * And the EVENTS, for the same reason and with the same instrument. This was
 * `captureException: () => undefined` — a stub that accepted the call and threw
 * away both arguments, so a handled failure reported with the wrong surface, the
 * wrong tags or no error at all was indistinguishable from one reported
 * correctly. It is now observable; the arrow wrapper (rather than the mock
 * itself) is what keeps the hoisted factory from dereferencing the const before
 * it is initialised.
 */
const mockCaptureException: jest.Mock = jest.fn();
jest.mock("@sentry/react-native", () => ({
  addBreadcrumb: (crumb: { category?: string; message?: string }) => {
    mockCrumbs.push(crumb);
  },
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

/**
 * "Cerrar sesión en todos los dispositivos", as a mock that can be OBSERVED.
 *
 * It was a literal `() => Promise.resolve({ outcome: "ok", … })` — a stub with
 * no identity, which is why nothing in this file could ask when it was called
 * relative to anything else, and why the ordering defect below lived here
 * unnoticed. It also dropped its `SessionPort`.
 */
const mockRevokeAllSessions: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockEraseMyAccount: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
  completeIdentity: (...args: unknown[]) => mockCompleteIdentity(...args),
  fetchMe: (...args: unknown[]) => mockFetchMe(...args),
  signup: (...args: unknown[]) => mockSignup(...args),
  revokeAllSessions: (...args: unknown[]) => mockRevokeAllSessions(...args),
  eraseMyAccount: (...args: unknown[]) => mockEraseMyAccount(...args),
}));

/**
 * The draft sweep, observed. Drafts can hold a THIRD party's name and phone (the
 * person a dog bit), so which exits sweep them is a data-protection property,
 * not a detail — see "every deliberate exit sweeps the drafts" below.
 */
const mockForgetAllEventDrafts: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../pets/event-draft-store", () => ({
  forgetAllEventDrafts: () => mockForgetAllEventDrafts(),
}));

/**
 * The SECOND draft sweep (Re-2, decision 16A): the alta wizard's own store, a
 * separate AsyncStorage prefix from the event drafts above but swept by the
 * SAME `sweepDraftsOnDeliberateExit`, for the same reason — a half-registered
 * pet must not survive into another account on a shared phone either.
 */
const mockForgetAllAltaDrafts: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../pets/alta-draft-store", () => ({
  forgetAllAltaDrafts: () => mockForgetAllAltaDrafts(),
}));

/**
 * The THIRD sweep on the same exits (M13 security review): the files handed to
 * the share sheet — the art. 14 export and the lost-pet poster PDFs.
 */
const mockForgetSharedFiles = jest.fn<() => void>();
jest.mock("../native/file-share", () => ({
  forgetSharedFiles: () => mockForgetSharedFiles(),
}));

import {
  SESSION_SERVER_UNAVAILABLE_MESSAGE,
  SESSION_UNREACHABLE_MESSAGE,
  bootstrapSession,
  completeIdentity,
  draftSweepEpoch,
  eraseAccount,
  getSessionState,
  sessionPort,
  signIn,
  signOut,
  signOutEverywhere,
  signUp,
} from "./session-store";

const LOGIN_OK = {
  outcome: "ok" as const,
  payload: {
    session: { accessToken: "at", refreshToken: "rt" },
    user: {
      id: "user-001",
      displayName: "Ana",
      role: "owner" as const,
      accountType: "personal" as const,
      profilePending: false,
    },
  },
};

/** The shape expo-secure-store failures actually have: a plain Error. */
const KEYSTORE_FAILURE = new Error("SecureStore: could not write value");

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mockAuth.setSession.mockResolvedValue({ data: {}, error: null });
  mockAuth.refreshSession.mockResolvedValue({ data: { session: null }, error: null });
  mockAuth.signOut.mockResolvedValue({ error: null });
  mockDropLocalSession.mockResolvedValue(undefined);
  mockForgetAllCachedCredentials.mockResolvedValue(undefined);
  mockRevokeThisDeviceForPush.mockResolvedValue({ outcome: "acknowledged" });
  mockRegisterThisDeviceForPush.mockResolvedValue({ outcome: "registered" });
  mockRevokeAllSessions.mockResolvedValue({ outcome: "ok", payload: { revoked: true } });
  mockEraseMyAccount.mockResolvedValue({ outcome: "ok", payload: { erased: true } });
  mockForgetAllEventDrafts.mockResolvedValue(undefined);
  mockForgetAllAltaDrafts.mockResolvedValue(undefined);
  mockLogin.mockResolvedValue(LOGIN_OK);
  mockFetchMe.mockResolvedValue({ outcome: "ok", payload: { user: LOGIN_OK.payload.user } });
  mockSignup.mockResolvedValue({
    outcome: "ok",
    payload: { session: { accessToken: "at", refreshToken: "rt" } },
  });
  // A keystore with nothing in it is the DEFAULT, so every pre-existing test
  // keeps reading "this device is signed out" exactly as it did.
  mockReadStoredSession.mockResolvedValue(null);
  mockRestoreStoredSession.mockResolvedValue(undefined);
  mockCrumbs.length = 0;
});

// ---------------------------------------------------------------------------
// signIn — the write path
// ---------------------------------------------------------------------------

describe("signIn — a Keystore write that THROWS", () => {
  it("returns the storage message instead of rejecting", async () => {
    mockAuth.setSession.mockRejectedValue(KEYSTORE_FAILURE);

    // The assertion is that this RESOLVES. Before the fix it rejected, the
    // screen's `submit()` had no catch, and `setBusy(false)` never ran — the
    // button stayed "Ingresando…" with no way forward.
    const result = await signIn("ana@dim.test", "hunter2");

    expect(result).toEqual({
      ok: false,
      message: "Iniciaste sesión, pero no pudimos guardarla en este dispositivo. Probá de nuevo.",
    });
  });

  it("reaches the same REFUSAL as an AuthError, and says a different thing", async () => {
    // THIS CASE USED TO ASSERT THE OPPOSITE, and its premise was wrong. It read
    // `expect(viaThrow).toEqual(viaError)` under "the library reports the same
    // condition two different ways ... and the user must not be able to tell".
    //
    // They are not the same condition. `setSession` calls `_getUser` over the
    // network BEFORE it saves anything (GoTrueClient.js:2835, `_saveSession` at
    // :2847), so a RETURNED AuthError means the server refused and storage was
    // never reached — while a REJECTED promise is the storage failure, because
    // auth-js rethrows non-AuthErrors (:2849-2854).
    //
    // What the collapse cost, on 2026-08-30: an app pointed at local Supabase
    // while `API_BASE_URL` still defaulted to staging signed in at staging and
    // handed a staging-signed token to local GoTrue, which answered
    // `invalid JWT: unrecognized JWT kid`. The screen blamed "este dispositivo",
    // and it was written up as an unexplained Keystore fault — an emulator PIN
    // tried and refuted, `adb logcat` searched for SecureStore lines that could
    // not exist, because that code never ran.
    mockAuth.setSession.mockResolvedValue({ data: {}, error: { message: "invalid session" } });
    const viaError = await signIn("ana@dim.test", "hunter2");

    mockAuth.setSession.mockRejectedValue(KEYSTORE_FAILURE);
    const viaThrow = await signIn("ana@dim.test", "hunter2");

    // Both still REFUSE — that half was right and is not being loosened.
    expect(viaError.ok).toBe(false);
    expect(viaThrow.ok).toBe(false);

    // But they name different subsystems, and only the throw names the device.
    expect(viaError).toEqual({
      ok: false,
      // NOT "en este dispositivo": the device is the one subsystem provably not
      // involved on the returned-error path (2026-09-01 review, finding 3a).
      message: "Iniciaste sesión, pero el servidor no aceptó la sesión. Probá de nuevo.",
    });
    expect(viaThrow).toEqual({
      ok: false,
      message: "Iniciaste sesión, pero no pudimos guardarla en este dispositivo. Probá de nuevo.",
    });
    expect(viaThrow).not.toEqual(viaError);
  });

  it("cleans up on the SERVER-refused shape too, not just on the throw", async () => {
    // The split must not turn one of the two into a softer path: a session the
    // server refused is as unusable as one that failed to store, so both clear.
    mockAuth.setSession.mockResolvedValue({ data: {}, error: { message: "invalid session" } });

    await signIn("ana@dim.test", "hunter2");

    expect(mockDropLocalSession).toHaveBeenCalledTimes(1);
    expect(getSessionState().phase).not.toBe("signed-in");
  });

  it("names the NETWORK for auth-js's retryable shape — not the server, not the device", async () => {
    // The THIRD shape, measured by the 2026-09-01 pre-push review: a fetch that
    // never reaches a server comes back as AuthRetryableFetchError — RETURNED,
    // not thrown (auth-js lib/fetch.js:33-40 wraps it, GoTrueClient.js:2836
    // returns it). Under the old two-way split it read as "el servidor no
    // aceptó", sending the reader to auth configuration when the actual fault
    // was the Supabase plane being unreachable — the WinNAT/container-down
    // class this repo's own memory documents. The guard is the library's own
    // (`__isAuthError` + name), so this fake is the exact shape it tests for.
    mockAuth.setSession.mockResolvedValue({
      data: {},
      error: { __isAuthError: true, name: "AuthRetryableFetchError", message: "fetch failed" },
    });

    const result = await signIn("ana@dim.test", "hunter2");

    expect(result).toEqual({
      ok: false,
      message:
        "Iniciaste sesión, pero no pudimos confirmarla con el servidor. Revisá tu conexión y probá de nuevo.",
    });
    // Same cleanup as every other refusal — a half-usable session must not
    // survive to the next cold start.
    expect(mockDropLocalSession).toHaveBeenCalledTimes(1);
    expect(getSessionState().phase).not.toBe("signed-in");
  });

  it("cleans up so a half-stored session cannot survive to the next cold start", async () => {
    mockAuth.setSession.mockRejectedValue(KEYSTORE_FAILURE);

    await signIn("ana@dim.test", "hunter2");

    expect(mockDropLocalSession).toHaveBeenCalledTimes(1);
    expect(getSessionState().phase).not.toBe("signed-in");
  });

  it("still refuses when even the CLEANUP throws", async () => {
    // A Keystore broken enough to fail a write can fail a delete. The recovery
    // path must not turn one failure into a second, thrown one.
    mockAuth.setSession.mockRejectedValue(KEYSTORE_FAILURE);
    mockDropLocalSession.mockRejectedValue(new Error("SecureStore: delete failed"));
    mockAuth.signOut.mockRejectedValue(new Error("network down"));

    const result = await signIn("ana@dim.test", "hunter2");

    expect(result.ok).toBe(false);
  });

  it("signs in normally when the write succeeds", async () => {
    // The control. Without it the tests above would pass on a function that
    // always failed.
    const result = await signIn("ana@dim.test", "hunter2");

    expect(result).toEqual({ ok: true });
    expect(getSessionState()).toEqual({ phase: "signed-in", user: LOGIN_OK.payload.user });
  });

  it("clears the shared device's display cache on the way IN", async () => {
    await signIn("ana@dim.test", "hunter2");

    // A family phone. The next person must not find the previous owner's
    // animals in the offline cache — and since `clearSession` now swallows a
    // failed clear, the sign-in is the second place that guarantees it.
    expect(mockForgetAllCachedCredentials).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sessionPort — the read paths, called from inside the fetch wrapper
// ---------------------------------------------------------------------------

describe("sessionPort — a keychain that will not answer", () => {
  it("accessToken() returns null rather than rejecting a request", async () => {
    mockAuth.getSession.mockRejectedValue(KEYSTORE_FAILURE);

    // `client.ts` calls this from inside a request a screen kicked off with
    // `void load()`. A throw here is a spinner that never stops.
    await expect(sessionPort.accessToken()).resolves.toBeNull();
  });

  it("refreshAccessToken() answers 'refused' rather than rejecting", async () => {
    // `_callRefreshToken` rethrows non-AuthErrors, so a Keystore write failure
    // during token ROTATION lands here and not in `error`. It is a DEVICE
    // failure: retrying the same call fails the same way, so it is not the
    // "unreachable" arm — see RefreshOutcome.
    mockAuth.refreshSession.mockRejectedValue(KEYSTORE_FAILURE);

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "refused",
    });
  });

  // -------------------------------------------------------------------------
  // A REFRESH THAT NEVER REACHED A SERVER IS NOT A DEAD SESSION (QA batch 2, D7)
  //
  // auth-js RETURNS a network-level failure as `AuthRetryableFetchError`
  // (lib/fetch.js:33-40) instead of throwing it, so `{ error }` covers both
  // "GoTrue refused this refresh token" and "the request never got there". This
  // port answered `null` for both and `apiRequest` ended the session for both —
  // a forced re-login over a dead spot, holding a refresh token nobody had
  // revoked. `signIn` in the same file has drawn this line since 2026-09-01.
  // -------------------------------------------------------------------------
  it("reports 'unreachable' for a refresh that never reached a server", async () => {
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("network request failed", 0),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("reports 'refused' for a refresh the server examined and rejected", async () => {
    // The shape GoTrue produces for a rotated or revoked refresh token: a plain
    // AuthError, not the retryable one. This session really is over.
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError(
        "Invalid Refresh Token: Already Used",
        400,
        "refresh_token_already_used",
      ),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "refused",
    });
  });

  it("hands back the rotated token when the refresh works", async () => {
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: { access_token: "rotated-token" } },
      error: null,
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: true,
      token: "rotated-token",
    });
  });

  it("still reads a token when the keychain is healthy", async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: "live-token" } },
      error: null,
    });

    await expect(sessionPort.accessToken()).resolves.toBe("live-token");
  });
});

// ---------------------------------------------------------------------------
// bootstrapSession — the splash screen
// ---------------------------------------------------------------------------

describe("bootstrapSession — a cold start on a broken keychain", () => {
  it("lands on signed-out instead of leaving the store at `starting`", async () => {
    mockAuth.getSession.mockRejectedValue(KEYSTORE_FAILURE);

    // The root layout calls this as `void bootstrapSession()`. A rejection
    // leaves the phase at `starting` forever — a splash with no way out and
    // nothing to retry from.
    await bootstrapSession();

    expect(getSessionState()).toEqual({ phase: "signed-out", reason: null });
  });

  it("verifies the identity when there IS a stored session", async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: "live-token" } },
      error: null,
    });

    await bootstrapSession();

    expect(mockFetchMe).toHaveBeenCalledTimes(1);
    expect(getSessionState().phase).toBe("signed-in");
  });
});

// ---------------------------------------------------------------------------
// A1-entrada-01 / A6-cuenta-resiliencia-01 — THE SUBWAY COLD START
//
// An access token past its expiry makes `getSession()` refresh before it
// answers, and a refresh that cannot reach GoTrue answers `{ session: null }`.
// That is byte-identical, at the call site, to a phone nobody ever signed in on
// — and the app read it as the second: sign-in screen, password please, over a
// network that could not have checked one.
// ---------------------------------------------------------------------------

describe("bootstrapSession — tokens on the device, server unreachable", () => {
  it("expired token, refresh unreachable → session-unverified", async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("network request failed", 0),
    });

    await bootstrapSession();

    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
    // The tokens are NOT dropped: there is nothing wrong with them.
    expect(mockDropLocalSession).not.toHaveBeenCalled();
  });

  it("uses the keystore as the tiebreaker when auth-js reports no error at all", async () => {
    // The shape the RETURNED error does not cover: a version or a path that
    // swallows its own refresh failure and answers `{ session: null, error:
    // null }`. The raw key is the only remaining witness that this device has a
    // session, and it is what tells "never signed in" from "could not check".
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mockReadStoredSession.mockResolvedValue('{"refresh_token":"rt"}');

    await bootstrapSession();

    expect(getSessionState().phase).toBe("session-unverified");
  });

  it("still signs out a device that really has no session", async () => {
    // THE CONTROL. Without it the two above would pass on a function that never
    // signs anybody out — which would be its own bug, and a worse one.
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await bootstrapSession();

    expect(getSessionState()).toEqual({ phase: "signed-out", reason: null });
  });
});

// ---------------------------------------------------------------------------
// A1-entrada-02 — A 503 IS NOT A DEAD SESSION
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L2 — `session-restored` is an event that HAPPENS, not a member of a union
// ---------------------------------------------------------------------------

describe("bootstrapSession — the restore leaves a mark on the trail (OBS-6)", () => {
  it("emits `session-restored` when the keystore had a session this cold start found", async () => {
    // `AUTH_EVENTS` declared this member and NOTHING emitted it, while
    // `report.test.ts` iterated the union and asserted all five land — which
    // reads as coverage of an event that could not occur. It is the fourth of
    // the four causes of "me sacó de la sesión" that OBS-6's own docblock
    // names: a keystore restore that then lost a race is indistinguishable
    // from a refusal without this crumb in front of it.
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: "live-token" } },
      error: null,
    });

    await bootstrapSession();

    expect(mockCrumbs).toContainEqual(
      expect.objectContaining({ category: "auth", message: "session-restored" }),
    );
  });

  it("says nothing on a device that never had a session", async () => {
    // The control. A crumb written unconditionally would say "restored" on a
    // phone somebody just installed the app on, which is the opposite fact.
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await bootstrapSession();

    expect(mockCrumbs.map((crumb) => crumb.message)).not.toContain("session-restored");
  });
});

describe("bootstrapSession — /me refuses for a reason that is not about the session", () => {
  beforeEach(async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: "live-token" } },
      error: null,
    });
    // A LIVE SESSION AS THE STARTING POINT, because the store is module state and
    // the phase it is IN is part of what these arms read: `markSessionUnverified`
    // refuses to overwrite `signed-out`, which is what keeps `apiRequest`'s
    // reason ("tu turno de trabajo terminó") from being replaced by "revisá tu
    // conexión". A test left signed-out by the file above would exercise that
    // guard instead of this arm.
    await signIn("ana@dim.test", "hunter2");
  });

  it("routes a 503 to session-unverified instead of the sign-in screen", async () => {
    mockFetchMe.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
    });

    await bootstrapSession();

    expect(getSessionState().phase).toBe("session-unverified");
  });

  it("honours retry-after on a 429, in the message", async () => {
    mockFetchMe.mockResolvedValue({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: 30,
    });

    await bootstrapSession();

    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: "Demasiadas consultas. Probá de nuevo en 30 segundos.",
    });
  });

  it("still signs out for a code that DOES mean the session is over", async () => {
    // The control for the split. `auth_required` is in `sessionEndingReason`'s
    // list in client.ts, and the two lists must agree.
    mockFetchMe.mockResolvedValue({
      outcome: "api-error",
      code: "auth_required",
      retryAfterSeconds: null,
    });

    await bootstrapSession();

    expect(getSessionState()).toEqual({ phase: "signed-out", reason: null });
  });

  // -------------------------------------------------------------------------
  // lote 1b F5 — A SYNTHESIZED `auth_required` IS NOT A SERVER VERDICT
  //
  // `apiRequest` answers `{ outcome: "api-error", code: "auth_required" }`
  // whenever `accessToken()` hands it a null token, WITHOUT ending anything and
  // without a status behind it. But `accessToken()` may have just set
  // `session-unverified` on its way out — so the code that means "the server saw
  // no bearer" arrived on a store that had just said "we could not reach the
  // server", and the guard only skipped `signed-out`. The person landed on the
  // sign-in screen with no sentence explaining why.
  // -------------------------------------------------------------------------
  it("keeps 'we could not check' instead of a blank sign-in screen", async () => {
    mockFetchMe.mockImplementation(async () => {
      // What `apiRequest` does first, and what it does with the null it gets.
      mockAuth.getSession.mockResolvedValue({
        data: { session: null },
        error: new AuthRetryableFetchError("network request failed", 0),
      });
      await sessionPort.accessToken();
      return { outcome: "api-error", code: "auth_required", retryAfterSeconds: null };
    });

    await bootstrapSession();

    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
  });
});

// ---------------------------------------------------------------------------
// A1-refuter-M1 / A6-refuter-M1 — A NULL TOKEN IS NOT ONE FACT
// ---------------------------------------------------------------------------

describe("sessionPort.accessToken — what a null token means", () => {
  it("ends the session when the refresh was REFUSED, so the gate can show sign-in", async () => {
    await signIn("ana@dim.test", "hunter2");
    expect(getSessionState().phase).toBe("signed-in");

    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"),
    });

    await expect(sessionPort.accessToken()).resolves.toBeNull();

    // Before: the store stayed `signed-in` and every screen rendered
    // "Necesitás iniciar sesión" with no way to do it — the gate never saw a
    // state to redirect on.
    expect(getSessionState()).toEqual({ phase: "signed-out", reason: "auth_expired" });
  });

  it("says 'we could not check' when the refresh was UNREACHABLE, and keeps the tokens", async () => {
    await signIn("ana@dim.test", "hunter2");

    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("network request failed", 0),
    });

    await expect(sessionPort.accessToken()).resolves.toBeNull();

    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
    expect(mockDropLocalSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// lote 1b F1 / F8 — THE ARM THAT DELETES THINGS
//
// `accessToken()`'s refused arm runs `clearSession()`, which drops the tokens
// AND calls `forgetAllCachedCredentials()`. Every status the old denylist did
// not name landed there, so the offline credential cache this whole batch
// exists to make reachable was destroyed by a rate limit.
// ---------------------------------------------------------------------------

describe("sessionPort.accessToken — a rate limit must not end the session", () => {
  it("keeps the tokens AND the credential cache when GoTrue answers 429", async () => {
    await signIn("ana@dim.test", "hunter2");
    mockDropLocalSession.mockClear();
    mockForgetAllCachedCredentials.mockClear();

    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Too Many Requests", 429, "over_request_rate_limit"),
    });

    await expect(sessionPort.accessToken()).resolves.toBeNull();

    // NOT signed-out: a per-IP limit — a clinic, a municipal office, CGNAT —
    // says nothing whatsoever about the tokens on this phone.
    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: SESSION_SERVER_UNAVAILABLE_MESSAGE,
    });
    expect(mockDropLocalSession).not.toHaveBeenCalled();
    expect(mockForgetAllCachedCredentials).not.toHaveBeenCalled();
  });

  it("names the SERVER, not the connection, when the answer carried a status (F8)", async () => {
    // A 500 already classified as unreachable before this batch — what was wrong
    // was the sentence. Somebody with four bars whose GoTrue fell over was told
    // to check their connection, which is the one thing that cannot help.
    await signIn("ana@dim.test", "hunter2");
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Internal Server Error", 500, undefined),
    });

    await expect(sessionPort.accessToken()).resolves.toBeNull();

    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: SESSION_SERVER_UNAVAILABLE_MESSAGE,
    });
  });

  it("still says 'no hay conexión' when nothing came back at all", async () => {
    // The control for the split: a transport failure carries status 0, and for
    // that person the connection really is the subject.
    await signIn("ana@dim.test", "hunter2");
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("network request failed", 0),
    });

    await expect(sessionPort.accessToken()).resolves.toBeNull();

    expect(getSessionState()).toEqual({
      phase: "session-unverified",
      message: SESSION_UNREACHABLE_MESSAGE,
    });
  });
});

// ---------------------------------------------------------------------------
// lote 1b F2 / F6 — A DELIBERATE SIGN-OUT MUST NOT BE UNDONE
//
// `restoreSnapshot`'s only guard was "is the key empty now?" — which is exactly
// what "Cerrar sesión" produces. The whole sequence fits inside one dead spot: a
// 401 starts a refresh, the refresh hangs, the person signs out, the refresh
// resolves `unreachable`, and the live refresh token is written back. The UI
// says signed out; the next cold start signs back in, and on a shared phone the
// display-only gate then renders the PREVIOUS person's cached credentials.
// ---------------------------------------------------------------------------

/** Let every already-queued microtask and 0 ms timer run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("signOut — the resurrection window", () => {
  it("does not restore a snapshot the sign-out deleted on purpose", async () => {
    await signIn("ana@dim.test", "hunter2");

    // The snapshot read lands first; the key is empty afterwards because the
    // sign-out emptied it — indistinguishable, to the old guard, from
    // `_removeSession()` throwing a good token away.
    mockReadStoredSession.mockResolvedValueOnce('{"refresh_token":"rt"}');
    mockReadStoredSession.mockResolvedValue(null);
    mockRestoreStoredSession.mockClear();

    let answerRefresh: (value: unknown) => void = () => {};
    mockAuth.refreshSession.mockReturnValue(
      new Promise((resolve) => {
        answerRefresh = resolve;
      }),
    );

    const refreshing = sessionPort.refreshAccessToken();
    // The snapshot and the epoch are both read before the call; without this the
    // test would read the epoch AFTER the bump and pass for the wrong reason.
    await flush();

    await signOut("/mascotas");

    answerRefresh({
      data: { session: null },
      error: new AuthRetryableFetchError("network request failed", 0),
    });
    await expect(refreshing).resolves.toEqual({ ok: false, reason: "unreachable" });

    expect(mockRestoreStoredSession).not.toHaveBeenCalled();
    expect(getSessionState()).toEqual({
      phase: "signed-out",
      reason: "user_action",
      endedAt: "/mascotas",
    });
  });

  it("still restores when NO sign-out happened — the epoch is not a way to never restore", async () => {
    // The control. Without it the assertion above would pass on a
    // `restoreSnapshot` that was simply deleted.
    await signIn("ana@dim.test", "hunter2");
    mockReadStoredSession.mockResolvedValueOnce('{"refresh_token":"rt"}');
    mockReadStoredSession.mockResolvedValue(null);
    mockRestoreStoredSession.mockClear();

    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError("network request failed", 0),
    });

    await sessionPort.refreshAccessToken();

    expect(mockRestoreStoredSession).toHaveBeenCalledWith('{"refresh_token":"rt"}');
  });

  it("re-deletes the local session when signOut outlives its 10 s budget (F6)", async () => {
    await signIn("ana@dim.test", "hunter2");
    jest.useFakeTimers();
    try {
      let answerSignOut: (value: unknown) => void = () => {};
      mockAuth.signOut.mockReturnValue(
        new Promise((resolve) => {
          answerSignOut = resolve;
        }),
      );
      mockDropLocalSession.mockClear();

      const pending = signOut("/ajustes");
      await jest.advanceTimersByTimeAsync(10_000);
      await pending;

      // The budget fired and the local delete ran without the server's answer —
      // which is the behaviour A6-cuenta-resiliencia-04 added and is correct.
      expect(mockDropLocalSession).toHaveBeenCalledTimes(1);

      // auth-js finally answers. Anything it had queued behind that answer — a
      // `_saveSession` from the auto-refresh ticker — lands AFTER the delete,
      // and the library's storage lock is no longer ordering us against it.
      answerSignOut({ error: null });
      await jest.advanceTimersByTimeAsync(0);

      expect(mockDropLocalSession).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("sessionPort.refreshAccessToken — the shapes auth-js deletes the session over", () => {
  it("reads an unparseable answer as unreachable and puts the session back", async () => {
    // A6-refuter-M1: `AuthUnknownError` is what auth-js raises when the body is
    // not JSON — an HTML 502, a captive portal, a proxy. It is not in its retry
    // list, so `_callRefreshToken` calls `_removeSession()`: a refresh token
    // GoTrue never saw, deleted by a hotel wifi.
    mockReadStoredSession
      .mockResolvedValueOnce('{"refresh_token":"rt"}')
      .mockResolvedValueOnce(null);
    // THE REAL CLASS, like every other error in this file. A hand-rolled
    // `{ __isAuthError: true, name: "AuthUnknownError" }` pinned the fake: it
    // could keep passing after auth-js renamed the class or started carrying a
    // status, which is exactly what `authFailureReason` reads.
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthUnknownError("Unexpected token <", new SyntaxError("Unexpected token <")),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(mockRestoreStoredSession).toHaveBeenCalledWith('{"refresh_token":"rt"}');
  });

  it("reads a 500 as unreachable too — a server that fell over said nothing", async () => {
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Internal Server Error", 500, undefined),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  // -------------------------------------------------------------------------
  // lote 1b F1 — A RATE LIMIT IS NOT A REFUSAL
  //
  // auth-js maps only [502,503,504,520,521,522,523,524,530] to
  // `AuthRetryableFetchError` (lib/fetch.js:32-40). EVERYTHING else becomes a
  // plain `AuthApiError`, so 429 arrived at a classifier whose default was
  // "refused" — and in `accessToken()` the refused arm runs `clearSession()`,
  // which drops the refresh token AND wipes the offline credential cache. One
  // clinic, one municipal office, one CGNAT range hitting a per-IP limit was
  // enough to destroy a session GoTrue never rejected.
  // -------------------------------------------------------------------------
  it("reads a 429 as unreachable and puts the session back", async () => {
    mockReadStoredSession
      .mockResolvedValueOnce('{"refresh_token":"rt"}')
      .mockResolvedValueOnce(null);
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Too Many Requests", 429, "over_request_rate_limit"),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
    expect(mockRestoreStoredSession).toHaveBeenCalledWith('{"refresh_token":"rt"}');
  });

  it("reads a 408 as unreachable too — a timeout is not a verdict", async () => {
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Request Timeout", 408, undefined),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("still reads a 401 as REFUSED — the allow-list is not a way to never sign out", async () => {
    // THE CONTROL for the inversion. Without it every test above would pass on a
    // classifier that answers "unreachable" to everything, which would be its own
    // bug and a worse one: a retry button that can never succeed.
    mockReadStoredSession.mockResolvedValue('{"refresh_token":"rt"}');
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Unauthorized", 401, "refresh_token_not_found"),
    });

    await expect(sessionPort.refreshAccessToken()).resolves.toEqual({
      ok: false,
      reason: "refused",
    });
    expect(mockRestoreStoredSession).not.toHaveBeenCalled();
  });

  it("does NOT put a session back when the refresh rotated one", async () => {
    // The guard on the restore: a successful refresh writes a NEWER value under
    // the same key, and blindly restoring the snapshot would replace a live
    // refresh token with the one it just superseded.
    mockReadStoredSession.mockResolvedValue('{"refresh_token":"rt"}');
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: { access_token: "rotated-token" } },
      error: null,
    });

    await sessionPort.refreshAccessToken();

    expect(mockRestoreStoredSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A6-cuenta-resiliencia-04 — THE AUTH PLANE GETS THE SAME 10 s BUDGET
// ---------------------------------------------------------------------------

describe("the auth plane under the request timeout", () => {
  it("gives up on a getSession that never answers", async () => {
    await signIn("ana@dim.test", "hunter2");
    jest.useFakeTimers();
    try {
      // A network that accepts the connection and answers nothing. The SDK's
      // own fetch has no timeout, so this used to hang for as long as the
      // platform allowed — under a splash, or a spinner behind `void load()`.
      mockAuth.getSession.mockReturnValue(new Promise(() => {}));

      const pending = sessionPort.accessToken();
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toBeNull();
      expect(getSessionState()).toEqual({
        phase: "session-unverified",
        message: SESSION_UNREACHABLE_MESSAGE,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("gives up on a refreshSession that never answers, as unreachable", async () => {
    jest.useFakeTimers();
    try {
      mockAuth.refreshSession.mockReturnValue(new Promise(() => {}));

      const pending = sessionPort.refreshAccessToken();
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toEqual({ ok: false, reason: "unreachable" });
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// A1-entrada-03 — "ok" WITH A `/me` THAT NEVER LANDED
//
// Both callers leave their button disabled on the success arm on purpose: the
// gate is supposed to redirect. When the follow-up `/me` failed, nothing
// redirected and nothing re-enabled — "Creando la cuenta…" forever.
// ---------------------------------------------------------------------------

describe("signUp — the follow-up /me read fails", () => {
  it("refuses instead of reporting a signed-in session that does not exist", async () => {
    mockFetchMe.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
    });

    const result = await signUp({
      email: "ana@dim.test",
      password: "hunter2hunter2",
      confirmPassword: "hunter2hunter2",
      tosAccepted: true,
    });

    expect(result.ok).toBe(false);
    // The account EXISTS — the copy must say so, or the person retries into the
    // duplicate masquerade with no explanation.
    expect(result.ok === false && result.message).toContain("Creamos tu cuenta");
    expect(result.ok === false && result.message).toContain("ingreso");
  });

  it("still reports the signed-in success when /me lands", async () => {
    const result = await signUp({
      email: "ana@dim.test",
      password: "hunter2hunter2",
      confirmPassword: "hunter2hunter2",
      tosAccepted: true,
    });

    expect(result).toEqual({ ok: true, signedIn: true });
  });
});

// ---------------------------------------------------------------------------
// A1-entrada-04 — STEP 2 WAS COMPLETED ON THE WEB
// ---------------------------------------------------------------------------

describe("completeIdentity — the server says it is already done", () => {
  it("re-reads /me and reports success instead of sending the person to Ajustes", async () => {
    // The DNI still lives on the web and this screen offers the link, so
    // finishing there and coming back to a phone still sitting on the form is a
    // NORMAL path. The 409's own sentence ("Ya completaste tus datos, volvé a
    // Ajustes") pointed at a screen that cannot advance anybody: the gate only
    // lets go when `/me` says `profilePending: false`, and nothing re-read it.
    await signIn("ana@dim.test", "hunter2");
    mockCompleteIdentity.mockResolvedValue({
      outcome: "api-error",
      code: "identity_already_complete",
      retryAfterSeconds: null,
    });
    mockFetchMe.mockResolvedValue({
      outcome: "ok",
      payload: { user: { ...LOGIN_OK.payload.user, displayName: "Ana Pérez" } },
    });

    await expect(completeIdentity({ firstName: "Ana", lastName: "Pérez" })).resolves.toEqual({
      ok: true,
    });
    expect(getSessionState()).toEqual({
      phase: "signed-in",
      user: { ...LOGIN_OK.payload.user, displayName: "Ana Pérez" },
    });
  });

  it("still refuses when the re-read says the identity is STILL pending", async () => {
    // The control: the 409 arm must not become a way to walk past a gate that
    // is still closed.
    await signIn("ana@dim.test", "hunter2");
    mockCompleteIdentity.mockResolvedValue({
      outcome: "api-error",
      code: "identity_already_complete",
      retryAfterSeconds: null,
    });
    mockFetchMe.mockResolvedValue({
      outcome: "ok",
      payload: { user: { ...LOGIN_OK.payload.user, profilePending: true } },
    });

    const result = await completeIdentity({ firstName: "Ana", lastName: "Pérez" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearSession — the push revoke, and the cycle it would otherwise close
// ---------------------------------------------------------------------------

describe("clearSession — telling the server to stop delivering", () => {
  it("revokes the push target BEFORE the tokens are dropped", async () => {
    const order: string[] = [];
    mockRevokeThisDeviceForPush.mockImplementation(async () => {
      order.push("push-revoke");
    });
    mockDropLocalSession.mockImplementation(async () => {
      order.push("drop-tokens");
    });

    await signOut("/mascotas");

    // THE ORDER IS THE WHOLE POINT. A revoke is an authenticated request, and
    // the credentials it needs are the ones the line below destroys. Reversed,
    // this call would 401 on every sign-out and the row would stay live.
    expect(order).toEqual(["push-revoke", "drop-tokens"]);
  });

  it("signs out anyway when the revoke fails", async () => {
    mockRevokeThisDeviceForPush.mockRejectedValue(new Error("offline"));

    await signOut("/mascotas");

    // Somebody who pressed "Cerrar sesión" is leaving. A push row that could
    // not be updated must not turn that into a session that stayed open.
    expect(mockDropLocalSession).toHaveBeenCalled();
    expect(getSessionState()).toMatchObject({ phase: "signed-out" });
  });

  // -------------------------------------------------------------------------
  // THE CYCLE, AND WHY A FLAG GUARDS IT
  //
  // The revoke goes out through `apiRequest`, which asks `accessToken()` for a
  // bearer. `accessToken()`'s REFUSED arm ends the session by calling
  // `clearSession()` — the same function that started the revoke. Sign-out →
  // revoke → accessToken → refused → sign-out, with no floor. It is an ASYNC
  // cycle, so it exhausts the HEAP rather than the stack: removing the guard
  // and running this file ends in `FATAL ERROR: Reached heap limit Allocation
  // failed` and SIGABRT (measured), with no catchable error anywhere. On a
  // phone that is the app dying on the way out.
  //
  // This test drives exactly that shape: the mocked revoke reaches for a token,
  // and the auth plane answers with the refusal that ends sessions.
  // -------------------------------------------------------------------------
  it("hands the revoke the session port it needs to authenticate", async () => {
    await signOut("/mascotas");

    // The port is what turns this into an AUTHENTICATED request; without it the
    // server sees an anonymous POST and the row stays live. Asserted because the
    // stub above used to throw the argument away.
    expect(mockRevokeThisDeviceForPush).toHaveBeenCalledWith(sessionPort);
  });

  it("cannot recurse when the revoke's own token read ends the session", async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError(
        "Invalid Refresh Token: Already Used",
        400,
        "refresh_token_already_used",
      ),
    });
    mockRevokeThisDeviceForPush.mockImplementation(async () => {
      // What `apiRequest` does first, and the step that re-enters the store.
      await sessionPort.accessToken();
    });

    await signOut("/mascotas");

    // ONCE. Without the guard this number is bounded only by the stack.
    expect(mockRevokeThisDeviceForPush).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// signOutEverywhere — the order, and why it is a security property
//
// `revokeAllSessions` kills THIS session too (the store's own docblock measured
// it: the access token is refused at once and the refresh token is gone). So a
// push revoke made afterwards carries a dead bearer and cannot land. Before the
// fix these two ran in exactly that order, which meant the one act somebody
// performs about a phone they no longer hold left that phone's delivery row
// live.
// ---------------------------------------------------------------------------

describe("signOutEverywhere — stopping delivery before stopping the session", () => {
  it("revokes this device's push target BEFORE it kills the sessions", async () => {
    const order: string[] = [];
    mockRevokeThisDeviceForPush.mockImplementation(async () => {
      order.push("push-revoke");
      return { outcome: "acknowledged" };
    });
    mockRevokeAllSessions.mockImplementation(async () => {
      order.push("revoke-all-sessions");
      return { outcome: "ok", payload: { revoked: true } };
    });

    const result = await signOutEverywhere("/ajustes");

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["push-revoke", "revoke-all-sessions"]);
  });

  it("does not repeat the revoke during the teardown", async () => {
    await signOutEverywhere("/ajustes");

    // `clearSession` revokes on its own for every OTHER exit, and must not here:
    // the credential a second attempt would carry is already dead, so it would
    // be a round trip that can only answer 401.
    expect(mockRevokeThisDeviceForPush).toHaveBeenCalledTimes(1);
  });

  it("reports a revoke that did not land, instead of swallowing it", async () => {
    mockRevokeThisDeviceForPush.mockResolvedValue({ outcome: "failed", detail: "api-error" });

    const result = await signOutEverywhere("/ajustes");

    // The sign-out still succeeds — the person asked to leave and they are
    // leaving — but the row may still be live, and that fact now leaves the
    // device instead of dying inside a `void`.
    expect(result).toEqual({ ok: true });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "push/push-revoke-failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({ surface: "push", failure: "push-revoke-failed" }),
      }),
    );
  });

  it("does NOT report a revoke lost to a phone with no signal", async () => {
    mockRevokeThisDeviceForPush.mockResolvedValue({ outcome: "failed", detail: "unreachable" });

    await signOutEverywhere("/ajustes");

    // Same exclusion `REPORT_FAILURES` already makes for the API surface: a
    // sign-out in a tunnel is not a defect, and one event per tunnel would bury
    // the ones that are.
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("leaves the session alone when the server refuses the revocation", async () => {
    mockRevokeAllSessions.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
      correlationId: null,
    });

    const result = await signOutEverywhere("/ajustes");

    expect(result.ok).toBe(false);
    // A half-done revocation that also signed this device out is the worst of
    // both. The push target was already revoked, and the next sign-in on this
    // device upserts it live again.
    expect(mockDropLocalSession).not.toHaveBeenCalled();
  });

  it("puts this phone's push target BACK when the revocation is refused", async () => {
    // THE SILENT MUTE. The push revoke goes first and lands; then
    // `revokeAllSessions` fails, so this arm returns without clearing the
    // session. The phase stays `signed-in` and `startPushRegistration`'s
    // `registeredFor` marker still holds this user's id — so nothing ever
    // re-registers, and the row stays revoked server-side until the app is
    // restarted. The person keeps using miMAR and never gets another urgent
    // lost-pet push on the phone in their hand.
    mockRevokeAllSessions.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
      correlationId: null,
    });

    const result = await signOutEverywhere("/ajustes");

    expect(result.ok).toBe(false);
    expect(mockRevokeThisDeviceForPush).toHaveBeenCalledTimes(1);
    expect(mockRegisterThisDeviceForPush).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-register when the revocation succeeded", async () => {
    // The other half, and the one that would make the fix a bug: on success
    // every session is gone by design, and putting the delivery row back would
    // undo the act the button performs.
    await signOutEverywhere("/ajustes");

    expect(mockRegisterThisDeviceForPush).not.toHaveBeenCalled();
  });

  it("still answers when the re-registration itself throws", async () => {
    mockRevokeAllSessions.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: null,
      correlationId: null,
    });
    mockRegisterThisDeviceForPush.mockRejectedValue(new Error("no network"));

    // Best effort: a phone with no signal must not turn a refused revocation
    // into an unhandled rejection on the way out of the screen.
    const result = await signOutEverywhere("/ajustes");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Every DELIBERATE exit sweeps the event drafts (PO decision 4A)
//
// A draft of a bite can hold the victim's name and phone — a third party who
// never agreed to be on this phone. Only "Cerrar sesión" used to sweep them;
// "cerrar sesión en todos los dispositivos" and "Eliminar mi cuenta" left them
// in the sandbox until the seven-day prune, and the second one is the Ley
// 25.326 art. 16 supresión itself. The INVOLUNTARY exit (a refused refresh) must
// keep NOT sweeping: an auth blip mid-form must not destroy what somebody was
// writing.
// ---------------------------------------------------------------------------

describe("every deliberate exit sweeps the shared files (the export, the poster PDFs)", () => {
  beforeEach(() => {
    mockForgetSharedFiles.mockClear();
  });

  it("signOut sweeps them", async () => {
    await signOut("/ajustes");
    expect(mockForgetSharedFiles).toHaveBeenCalledTimes(1);
  });

  it("signOutEverywhere sweeps them when the revocation lands", async () => {
    await signOutEverywhere("/ajustes");
    expect(mockForgetSharedFiles).toHaveBeenCalledTimes(1);
  });

  it("eraseAccount sweeps them when the erasure completes", async () => {
    await expect(eraseAccount("ya no la uso", "/ajustes")).resolves.toEqual({ ok: true });
    expect(mockForgetSharedFiles).toHaveBeenCalledTimes(1);
  });

  for (const reason of ["account_erased", "account_deactivated"] as const) {
    it(`a server-ended session (${reason}) sweeps them`, async () => {
      await sessionPort.endSession(reason);
      expect(mockForgetSharedFiles).toHaveBeenCalledTimes(1);
    });
  }

  it("a server-reported auth_expired does NOT sweep them — an auth blip is not an exit", async () => {
    await sessionPort.endSession("auth_expired");
    expect(mockForgetSharedFiles).not.toHaveBeenCalled();
  });
});

describe("every deliberate exit sweeps the event drafts", () => {
  const REFUSED = {
    outcome: "api-error",
    code: "temporarily_unavailable",
    retryAfterSeconds: null,
    correlationId: null,
  };

  it("signOut sweeps them", async () => {
    await signOut("/ajustes");

    expect(mockForgetAllEventDrafts).toHaveBeenCalledTimes(1);
    // Re-2, decision 16A: the SAME sweep also wipes the alta wizard's own
    // store — a separate module, a separate AsyncStorage prefix, called from
    // the same `sweepDraftsOnDeliberateExit` for the same reason.
    expect(mockForgetAllAltaDrafts).toHaveBeenCalledTimes(1);
  });

  it("signOutEverywhere sweeps them when the revocation lands", async () => {
    const result = await signOutEverywhere("/ajustes");

    expect(result).toEqual({ ok: true });
    expect(mockForgetAllEventDrafts).toHaveBeenCalledTimes(1);
    // And the other personal-data sweep sign-out performs, via the teardown.
    expect(mockForgetAllCachedCredentials).toHaveBeenCalled();
  });

  it("signOutEverywhere keeps them when the revocation is refused", async () => {
    // The session survives this arm, so the person is still mid-whatever.
    mockRevokeAllSessions.mockResolvedValue(REFUSED);

    const result = await signOutEverywhere("/ajustes");

    expect(result.ok).toBe(false);
    expect(mockForgetAllEventDrafts).not.toHaveBeenCalled();
  });

  it("eraseAccount sweeps them when the erasure completes", async () => {
    const result = await eraseAccount("ya no la uso", "/ajustes");

    expect(result).toEqual({ ok: true });
    expect(getSessionState()).toEqual({
      phase: "signed-out",
      reason: "account_erased",
      endedAt: "/ajustes",
    });
    expect(mockForgetAllEventDrafts).toHaveBeenCalledTimes(1);
    expect(mockForgetAllCachedCredentials).toHaveBeenCalled();
  });

  it("eraseAccount keeps them when the erasure is refused", async () => {
    // The account still exists and so does the session; the draft is still
    // that person's scratch paper.
    mockEraseMyAccount.mockResolvedValue(REFUSED);

    const result = await eraseAccount("ya no la uso", "/ajustes");

    expect(result.ok).toBe(false);
    expect(mockForgetAllEventDrafts).not.toHaveBeenCalled();
  });

  it("a sweep that rejects does not keep anybody signed in", async () => {
    mockForgetAllEventDrafts.mockRejectedValue(new Error("AsyncStorage is gone"));

    await expect(eraseAccount("ya no la uso", "/ajustes")).resolves.toEqual({ ok: true });
    await expect(signOutEverywhere("/ajustes")).resolves.toEqual({ ok: true });
    expect(getSessionState().phase).toBe("signed-out");
  });

  it("a REFUSED refresh ends the session WITHOUT sweeping them", async () => {
    await signIn("ana@dim.test", "hunter2");
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found"),
    });

    await expect(sessionPort.accessToken()).resolves.toBeNull();

    expect(getSessionState()).toEqual({ phase: "signed-out", reason: "auth_expired" });
    expect(mockForgetAllEventDrafts).not.toHaveBeenCalled();
  });

  // THE SERVER CAN END A SESSION FOR GOOD. An account erased from the web, or
  // this app's own erasure whose 200 was lost on the way back, reaches the
  // phone as `account_erased` on the next request; a deactivation as
  // `account_deactivated`. Neither is a blip that the person will sign back
  // into with their draft waiting — the account is gone or locked — so a bite
  // victim's name and phone must not outlive them in a draft.
  for (const reason of ["account_erased", "account_deactivated"] as const) {
    it(`a server-reported ${reason} sweeps them`, async () => {
      await signIn("ana@dim.test", "hunter2");

      await sessionPort.endSession(reason);

      expect(getSessionState()).toEqual({ phase: "signed-out", reason });
      expect(mockForgetAllEventDrafts).toHaveBeenCalledTimes(1);
    });
  }

  it("a server-reported auth_expired ends the session WITHOUT sweeping them", async () => {
    // What `apiRequest` calls when the refresh after a 401 fails. The person
    // signs back in and finds their text.
    await signIn("ana@dim.test", "hunter2");

    await sessionPort.endSession("auth_expired");

    expect(getSessionState()).toEqual({ phase: "signed-out", reason: "auth_expired" });
    expect(mockForgetAllEventDrafts).not.toHaveBeenCalled();
  });

  // THE EPOCH IS WHAT A FORM ON SCREEN ASKS (A2c). `use-event-draft` refuses
  // a late write only once this number has moved since it captured its owner,
  // so it must move on every sweep and on nothing else — a bump on an
  // involuntary end would destroy the writing the draft exists to keep, and a
  // missing bump on a sweep would let a late write resurrect what was swept.
  it("the draft-sweep epoch moves with every sweep and only with a sweep", async () => {
    await signIn("ana@dim.test", "hunter2");
    const before = draftSweepEpoch();

    await sessionPort.endSession("auth_expired");
    expect(draftSweepEpoch()).toBe(before);

    await signIn("ana@dim.test", "hunter2");
    await sessionPort.endSession("account_deactivated");
    expect(draftSweepEpoch()).toBe(before + 1);

    await signIn("ana@dim.test", "hunter2");
    await signOut("/ajustes");
    expect(draftSweepEpoch()).toBe(before + 2);
  });
});
