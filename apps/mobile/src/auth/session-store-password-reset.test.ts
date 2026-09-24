// `requestPasswordReset` / `resetPasswordWithCode` — the two halves of native
// password recovery, and the ORDER inside the second one.
//
// WHY A SECOND SESSION-STORE FILE
// ---------------------------------------------------------------------------
// `session-store.test.ts` is about ONE thing — the failures auth-js reaches by
// THROWING — and it says so in its own header. These are about a different
// thing, and folding them in would make that file's title a lie. The doubles
// also differ: this flow reaches `verifyOtp` and `updateUser`, which that file's
// `mockAuth` deliberately does not name.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. THE REQUEST GOES THROUGH OUR API AND NEVER THROUGH GoTrue. A client that
//      called `resetPasswordForEmail` on the SDK would bypass both our budgets —
//      `auth_password_reset_ip` and `auth_password_reset_email` — and get a fresh
//      ceiling for being a phone. This is asserted as an absence, which is weak
//      on its own, so it is paired with the positive: the endpoint WAS called.
//   2. THE PASSWORD IS CHECKED BEFORE THE CODE IS SPENT. A recovery code is
//      single-use; `verifyOtp` consumes it. Validating the confirmation
//      afterwards burns the code on a typo, on a flow that allows the address
//      five mails an hour. This is THE assertion of this file.
//   3. EVERY REDEMPTION FAILURE COLLAPSES TO ONE SENTENCE. Wrong code, expired
//      code, spent code and an address with no account all arrive at the same
//      place; telling them apart would answer "does this e-mail have an account",
//      which is the question the request half refuses.
//   4. A FAILED `updateUser` DROPS THE SESSION `verifyOtp` ALREADY STORED.
//      Leaving it would give the app a live session it never told its store
//      about — the screen shows an error, the person backs out, and the app is
//      signed in while its UI says otherwise.
//   5. A SUCCESSFUL RESET REVOKES EVERY OTHER SESSION (`scope: "others"`), which
//      is the web's MED-5 posture reaching the phone. A reset is the canonical
//      response to a compromised account.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// The `mock` prefix is load-bearing — see the sibling file's note on
// babel-plugin-jest-hoist.
type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

const mockAuth: Record<
  "getSession" | "setSession" | "signOut" | "verifyOtp" | "updateUser" | "resetPasswordForEmail",
  AsyncMock
> = {
  getSession: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  setSession: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  signOut: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  verifyOtp: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  // Present ONLY so the "never called" assertion below is meaningful: a spy that
  // does not exist cannot be observed not to have been called.
  resetPasswordForEmail: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
};

const mockDropLocalSession: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockForgetAllCachedCredentials: AsyncMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRequestPasswordReset: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchMe: AsyncMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("./supabase-auth", () => ({
  AUTH_STORAGE_KEY: "mimar.auth.session",
  authClient: () => ({ auth: mockAuth }),
  dropLocalSession: () => mockDropLocalSession(),
}));

jest.mock("../credential/credential-cache", () => ({
  forgetAllCachedCredentials: () => mockForgetAllCachedCredentials(),
}));

jest.mock("../api/endpoints", () => ({
  login: () => Promise.resolve({ outcome: "unreachable", detail: "unused" }),
  fetchMe: (...args: unknown[]) => mockFetchMe(...args),
  requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
  revokeAllSessions: () => Promise.resolve({ outcome: "ok", payload: { revoked: true } }),
}));

import { requestPasswordReset, resetPasswordWithCode } from "./session-store";

const USER = {
  id: "user-001",
  displayName: "Ana",
  role: "owner" as const,
  accountType: "personal" as const,
  profilePending: false,
};

/** A valid redemption, so each test can vary exactly one thing. */
const REDEMPTION = {
  email: "ana@example.com",
  code: "123456",
  password: "unaClaveLarga",
  confirmPassword: "unaClaveLarga",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mockAuth.setSession.mockResolvedValue({ data: {}, error: null });
  mockAuth.signOut.mockResolvedValue({ error: null });
  mockAuth.verifyOtp.mockResolvedValue({ data: {}, error: null });
  mockAuth.updateUser.mockResolvedValue({ data: {}, error: null });
  mockAuth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mockDropLocalSession.mockResolvedValue(undefined);
  mockForgetAllCachedCredentials.mockResolvedValue(undefined);
  mockRequestPasswordReset.mockResolvedValue({ outcome: "ok", payload: { requested: true } });
  mockFetchMe.mockResolvedValue({ outcome: "ok", payload: { user: USER } });
});

// ---------------------------------------------------------------------------
// The request half
// ---------------------------------------------------------------------------

describe("requestPasswordReset", () => {
  it("goes through our API and NEVER through GoTrue directly", async () => {
    const result = await requestPasswordReset("ana@example.com");

    expect(result).toEqual({ ok: true });
    expect(mockRequestPasswordReset).toHaveBeenCalledWith({ email: "ana@example.com" });
    // The absence that matters. `supabase.auth.resetPasswordForEmail` from here
    // would bypass `auth_password_reset_ip` and `auth_password_reset_email`
    // entirely — the ceiling belongs to the ACT, not to the door.
    expect(mockAuth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("reports the server's refusal rather than composing its own", async () => {
    mockRequestPasswordReset.mockResolvedValue({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: null,
    });
    const result = await requestPasswordReset("ana@example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/demasiadas consultas/i);
  });

  it("says nothing about whether the address has an account", async () => {
    // The server answers the same 202 either way and does not itself know. A
    // success arm carrying anything at all would be a place for that to change.
    const result = await requestPasswordReset("nadie@example.com");
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// The redemption half — the ordering
// ---------------------------------------------------------------------------

describe("resetPasswordWithCode — the code is spent last", () => {
  it("refuses a short password WITHOUT spending the code", async () => {
    const result = await resetPasswordWithCode({
      ...REDEMPTION,
      password: "corta",
      confirmPassword: "corta",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/8 caracteres/);
    // THE POINT. `verifyOtp` consumes the code; running it first would burn a
    // single-use credential on a local rule, and the person would be back at a
    // request endpoint that allows their address five mails an hour.
    expect(mockAuth.verifyOtp).not.toHaveBeenCalled();
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a mismatched confirmation WITHOUT spending the code", async () => {
    const result = await resetPasswordWithCode({
      ...REDEMPTION,
      confirmPassword: "otraDistinta",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/no coinciden/);
    expect(mockAuth.verifyOtp).not.toHaveBeenCalled();
  });

  it("reports the LENGTH before the mismatch, as the web does", async () => {
    // A person who typed the same short password twice should be told the
    // length, not that the two boxes disagree — they do not.
    const result = await resetPasswordWithCode({
      ...REDEMPTION,
      password: "corta",
      confirmPassword: "otra",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/8 caracteres/);
  });
});

describe("resetPasswordWithCode — redeeming", () => {
  it("verifies the code as a RECOVERY otp, keyed on the address too", async () => {
    await resetPasswordWithCode(REDEMPTION);
    // The address is not decoration: a six-digit code is not globally unique, so
    // GoTrue needs both to resolve which token this is.
    expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      email: "ana@example.com",
      token: "123456",
      type: "recovery",
    });
  });

  it("sets the new password and revokes every OTHER session", async () => {
    const result = await resetPasswordWithCode(REDEMPTION);

    expect(result).toEqual({ ok: true });
    expect(mockAuth.updateUser).toHaveBeenCalledWith({ password: "unaClaveLarga" });
    // MED-5, on the phone: a reset is the canonical response to a compromised
    // account, so any session an attacker minted before it must die.
    // `scope: "others"` spares the recovery session this device is holding, which
    // is what leaves the person signed in on the phone they just recovered.
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("still succeeds when revoking the other sessions fails", async () => {
    mockAuth.signOut.mockRejectedValue(new Error("network glitch"));
    const result = await resetPasswordWithCode(REDEMPTION);
    // The password is already changed. Reporting a sign-out hiccup as a failed
    // reset would send the person back for a code they no longer need.
    expect(result).toEqual({ ok: true });
  });

  it("resolves the user from /me rather than fabricating one", async () => {
    await resetPasswordWithCode(REDEMPTION);
    // An account that just recovered may still have no profile row, in which case
    // `/me` answers `profilePending: true` and the gate sends the person to
    // identity completion. Guessing here would be this app inventing an answer
    // the server declined to give.
    expect(mockFetchMe).toHaveBeenCalled();
  });
});

describe("resetPasswordWithCode — failures", () => {
  it("collapses every verification failure into ONE sentence", async () => {
    // Four causes, one message. Telling them apart would answer "does this
    // e-mail have an account" — the question the request half refuses.
    const causes = [
      { message: "Token has expired or is invalid" },
      { message: "User not found" },
      { message: "Invalid token" },
      { message: "Token already used" },
    ];
    const messages = new Set<string>();
    for (const error of causes) {
      mockAuth.verifyOtp.mockResolvedValue({ data: {}, error });
      const result = await resetPasswordWithCode(REDEMPTION);
      expect(result.ok).toBe(false);
      if (!result.ok) messages.add(result.message);
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).toMatch(/no es válido o ya venció/i);
  });

  it("catches a THROWN verification failure as well as a returned one", async () => {
    // auth-js rethrows anything that is not an AuthError, and an
    // expo-secure-store write failure is a plain Error. Unwrapped, that rejection
    // propagates into a screen whose submit() has no catch and the button never
    // comes back.
    mockAuth.verifyOtp.mockRejectedValue(new Error("SecureStore: could not write value"));
    const result = await resetPasswordWithCode(REDEMPTION);
    expect(result.ok).toBe(false);
    expect(mockAuth.updateUser).not.toHaveBeenCalled();
  });

  it("drops the session verifyOtp stored when updateUser fails", async () => {
    mockAuth.updateUser.mockResolvedValue({ data: {}, error: { message: "Password is too weak" } });
    const result = await resetPasswordWithCode(REDEMPTION);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/pedí un código nuevo/i);
    // By now `verifyOtp` has stored a live recovery session. Leaving it would
    // give the app a session it never told its store about: the screen shows an
    // error, the person backs out, and the app is signed in while its UI says
    // otherwise.
    expect(mockDropLocalSession).toHaveBeenCalled();
    // And nothing pretends the reset half-worked.
    expect(mockAuth.signOut).not.toHaveBeenCalledWith({ scope: "others" });
  });

  it("catches a THROWN updateUser failure the same way", async () => {
    mockAuth.updateUser.mockRejectedValue(new Error("SecureStore: could not write value"));
    const result = await resetPasswordWithCode(REDEMPTION);
    expect(result.ok).toBe(false);
    expect(mockDropLocalSession).toHaveBeenCalled();
  });
});
