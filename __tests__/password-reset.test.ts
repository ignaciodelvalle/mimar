// Unit tests for requestPasswordResetAction and updatePasswordAction.
//
// Strategy: mock `@/lib/supabase/server` to avoid real Supabase calls.
// The same pattern is used in auth-actions.test.ts and signup-validation.test.ts.
//
// Covers:
//   requestPasswordResetAction:
//     - missing email → validation error
//     - valid email → generic message (regardless of whether account exists)
//     - Supabase error still returns the same generic message (no leakage)
//   updatePasswordAction:
//     - no session (getUser returns null) → rejects with expiry message
//     - session present + short password → validation error
//     - session present + mismatched passwords → validation error
//     - session present + valid passwords → calls updateUser and returns ok
//     - A04-1: a session WITHOUT a fresh recovery amr (password sign-in, stale
//       recovery, unreadable token) is refused before updateUser
//   changePasswordAction (/cuenta, A04-1):
//     - wrong current password → refused, nothing updated
//     - right current password → update through the throwaway session, others revoked
//
// The web's CODE step is not here any more. It was, while the six-digit code was
// redeemed by a server action; it is now redeemed in the browser so that GoTrue
// keys its per-IP ceiling on the person rather than on our egress, and what the
// step does is pinned in reset-code-step.test.tsx. The `supabase/config.toml`
// fence that used to live here — asserting our deployment-wide ceiling stayed
// under GoTrue's `token_verifications` — went with it and was deliberately NOT
// replaced: that file is LOCAL DEV ONLY and is never pushed to a hosted project
// (dim-interno:docs/ops/env-handling.md), so it never said anything about production.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

// changePasswordAction only: the live-account guard and the throwaway client.
const { mockRequireLiveUser, mockCreateAnonClient } = vi.hoisted(() => ({
  mockRequireLiveUser: vi.fn(),
  mockCreateAnonClient: vi.fn(),
}));
vi.mock("@/lib/infra/live-user", () => ({ requireLiveUser: mockRequireLiveUser }));
vi.mock("@/lib/supabase/anon", () => ({ createAnonClient: mockCreateAnonClient }));

// requestPasswordResetAction now reads request headers (callerIp) for its
// per-IP + per-email rate-limit budgets. Provide a trusted edge IP.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "10.0.0.1" : null),
  })),
}));

// Rate limiter: allow by default, overridable per test. Keep the REAL
// RateLimitError / callerIp / emailRateLimitKey so the action's branch logic
// and key derivation stay honest.
const { mockEnforceRateLimit } = vi.hoisted(() => ({
  mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
  };
});

import { changePasswordAction } from "@/app/actions/change-password";
import { requestPasswordResetAction, updatePasswordAction } from "@/app/actions/password-reset";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { createClient } from "@/lib/supabase/server";
import {
  RECOVERY_PROOF_WINDOW_MS,
  hasFreshRecoveryProof,
} from "@/src/modules/auth/domain/recovery-proof";

beforeEach(() => {
  mockEnforceRateLimit.mockReset();
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// Build a mock Supabase client shaped for requestPasswordResetAction.
function mockResetClient({ error = null }: { error?: unknown } = {}) {
  const resetPasswordForEmail = vi.fn().mockResolvedValue({ error });
  vi.mocked(createClient).mockResolvedValue({
    auth: { resetPasswordForEmail },
  } as never);
  return { resetPasswordForEmail };
}

// An unsigned JWT carrying the given payload — the action only decodes it, and
// only after getUser() has (in production) validated it.
function tokenWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Build a mock Supabase client shaped for updatePasswordAction. By default the
// session is a FRESH recovery session (amr method "recovery", just now) — the
// only shape the action accepts since A04-1.
function mockUpdateClient({
  user = null as { id: string; app_metadata?: Record<string, unknown> } | null,
  userError = null as unknown,
  updateError = null as unknown,
  amr = [{ method: "recovery", timestamp: nowSeconds() }] as unknown,
  accessToken = undefined as string | null | undefined,
} = {}) {
  const updateUser = vi.fn().mockResolvedValue({ error: updateError });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const token = accessToken === undefined ? tokenWith({ amr, aal: "aal1" }) : accessToken;
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: userError }),
      getSession: vi
        .fn()
        .mockResolvedValue({ data: { session: token ? { access_token: token } : null } }),
      updateUser,
      signOut,
    },
  } as never);
  return { updateUser, signOut };
}

// ---------------------------------------------------------------------------
// requestPasswordResetAction
// ---------------------------------------------------------------------------

describe("requestPasswordResetAction", () => {
  it("returns a validation error when email is empty", async () => {
    mockResetClient();
    const result = await requestPasswordResetAction(
      { message: null, error: null },
      makeForm({ email: "" }),
    );
    expect(result.error).toBeTruthy();
    expect(result.message).toBeNull();
  });

  it("returns the generic message for a valid email (account exists path)", async () => {
    mockResetClient({ error: null });
    const result = await requestPasswordResetAction(
      { message: null, error: null },
      makeForm({ email: "user@example.com" }),
    );
    expect(result.error).toBeNull();
    expect(result.message).toBeTruthy();
    // Must contain the generic 'si existe una cuenta' copy — never 'found' / 'not found'.
    expect(result.message).toMatch(/si existe una cuenta/i);
    // The mail carries a code now; the web copy must not promise a link.
    expect(result.message).toMatch(/código/);
    expect(result.message).not.toMatch(/enlace/i);
    // The address is echoed so the code step can send it with the code.
    expect(result.email).toBe("user@example.com");
  });

  it("returns the SAME generic message when Supabase returns an error (no account leakage)", async () => {
    mockResetClient({ error: { message: "User not found" } });
    const result = await requestPasswordResetAction(
      { message: null, error: null },
      makeForm({ email: "nobody@example.com" }),
    );
    // The action intentionally ignores the Supabase error to avoid leaking
    // whether the account exists — the message must be the same generic one.
    expect(result.error).toBeNull();
    expect(result.message).toMatch(/si existe una cuenta/i);
    // Byte-identical to the account-exists path, echo included.
    expect(result.email).toBe("nobody@example.com");
  });

  it("calls resetPasswordForEmail with the provided email", async () => {
    const { resetPasswordForEmail } = mockResetClient();
    await requestPasswordResetAction(
      { message: null, error: null },
      makeForm({ email: "ana@mimar.ar" }),
    );
    expect(resetPasswordForEmail).toHaveBeenCalledOnce();
    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      "ana@mimar.ar",
      expect.objectContaining({ redirectTo: expect.stringContaining("/recuperar/actualizar") }),
    );
  });

  it("enforces a per-IP and a per-email budget before sending a recovery email", async () => {
    const { resetPasswordForEmail } = mockResetClient();
    await requestPasswordResetAction(
      { message: null, error: null },
      makeForm({ email: "ana@mimar.ar" }),
    );
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "auth_password_reset_ip",
      "10.0.0.1",
      expect.any(Object),
    );
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "auth_password_reset_email",
      expect.any(String),
      expect.any(Object),
    );
    expect(resetPasswordForEmail).toHaveBeenCalledOnce();
  });

  it("returns a friendly error and sends NO email when rate-limited", async () => {
    const { resetPasswordForEmail } = mockResetClient();
    mockEnforceRateLimit.mockRejectedValueOnce(
      new RateLimitError(new Date(Date.now() + 60_000), "auth_password_reset_ip"),
    );
    const result = await requestPasswordResetAction(
      { message: null, error: null },
      makeForm({ email: "ana@mimar.ar" }),
    );
    expect(result.error).toMatch(/demasiados intentos/i);
    expect(result.message).toBeNull();
    // Fail closed: no recovery email is dispatched once the budget is spent.
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updatePasswordAction
// ---------------------------------------------------------------------------

describe("updatePasswordAction", () => {
  it("rejects when there is no valid session", async () => {
    mockUpdateClient({ user: null });
    const result = await updatePasswordAction(
      { error: null },
      makeForm({ password: "nuevaPass1!", confirmPassword: "nuevaPass1!" }),
    );
    expect(result.error).toBeTruthy();
    expect(result.ok).toBeFalsy();
  });

  it("rejects when getUser itself returns an error (session tampered)", async () => {
    mockUpdateClient({ user: null, userError: { message: "invalid JWT" } });
    const result = await updatePasswordAction(
      { error: null },
      makeForm({ password: "nuevaPass1!", confirmPassword: "nuevaPass1!" }),
    );
    expect(result.error).toBeTruthy();
    expect(result.ok).toBeFalsy();
  });

  it("rejects when the password is shorter than 8 characters", async () => {
    mockUpdateClient({ user: { id: "user-uuid" } });
    const result = await updatePasswordAction(
      { error: null },
      makeForm({ password: "short", confirmPassword: "short" }),
    );
    expect(result.error).toMatch(/8 caracteres/);
  });

  it("rejects when the passwords do not match", async () => {
    mockUpdateClient({ user: { id: "user-uuid" } });
    const result = await updatePasswordAction(
      { error: null },
      makeForm({ password: "validPassword1!", confirmPassword: "different!" }),
    );
    expect(result.error).toMatch(/no coinciden/);
  });

  it("calls updateUser and returns ok when session is valid and passwords match", async () => {
    const { updateUser } = mockUpdateClient({ user: { id: "user-uuid" } });
    const result = await updatePasswordAction(
      { error: null },
      makeForm({ password: "seguraPass1!", confirmPassword: "seguraPass1!" }),
    );
    expect(updateUser).toHaveBeenCalledWith({ password: "seguraPass1!" });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
  });

  // MED-5: a reset is the canonical response to a compromised account, so any
  // pre-existing attacker session must be revoked. scope:"others" kills every
  // OTHER session while preserving the current recovery session (reset UX).
  it("revokes all OTHER sessions after a successful password update", async () => {
    const { signOut } = mockUpdateClient({ user: { id: "user-uuid" } });
    await updatePasswordAction(
      { error: null },
      makeForm({ password: "seguraPass1!", confirmPassword: "seguraPass1!" }),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("does NOT revoke other sessions when the password update fails", async () => {
    const { signOut } = mockUpdateClient({
      user: { id: "user-uuid" },
      updateError: { message: "Password too weak" },
    });
    await updatePasswordAction(
      { error: null },
      makeForm({ password: "seguraPass1!", confirmPassword: "seguraPass1!" }),
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it("still returns ok when the session revocation itself fails (non-fatal)", async () => {
    const { signOut } = mockUpdateClient({ user: { id: "user-uuid" } });
    signOut.mockRejectedValueOnce(new Error("network glitch"));
    const result = await updatePasswordAction(
      { error: null },
      makeForm({ password: "seguraPass1!", confirmPassword: "seguraPass1!" }),
    );
    // The password was already changed — a sign-out hiccup must not surface as a
    // hard error to the user.
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  // A04-6: every updateUser failure gets the same sentence and never GoTrue's
  // own text, which is account-state-shaped.
  it.each(["Password too weak", "New password should be different from the old password."])(
    "returns one generic sentence when updateUser fails with %j",
    async (message) => {
      mockUpdateClient({
        user: { id: "user-uuid" },
        updateError: { message },
      });
      const result = await updatePasswordAction(
        { error: null },
        makeForm({ password: "validPass1!", confirmPassword: "validPass1!" }),
      );
      expect(result.error).toBe(
        "No se pudo actualizar la contraseña. Probá con otra contraseña o pedí un código nuevo desde la página de recuperación.",
      );
      expect(result.error).not.toContain(message);
      expect(result.ok).toBeFalsy();
    },
  );
});

// ---------------------------------------------------------------------------
// A04-1 — the recovery form requires a recovery session
// ---------------------------------------------------------------------------

describe("updatePasswordAction — recovery proof (A04-1)", () => {
  const form = () => makeForm({ password: "seguraPass1!", confirmPassword: "seguraPass1!" });
  const EXPIRED = /sesión de recuperación expiró/;

  it("refuses an ordinary password session and never calls updateUser", async () => {
    const { updateUser, signOut } = mockUpdateClient({
      user: { id: "user-uuid" },
      amr: [{ method: "password", timestamp: nowSeconds() }],
    });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.error).toMatch(EXPIRED);
    expect(result.ok).toBeFalsy();
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("accepts a session minted by the recovery code or token-hash (amr otp)", async () => {
    const { updateUser } = mockUpdateClient({
      user: { id: "user-uuid" },
      amr: [{ method: "otp", timestamp: nowSeconds() }],
    });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.ok).toBe(true);
    expect(updateUser).toHaveBeenCalledOnce();
  });

  // LOW-7 (2026-09-18): a first-access LINK session is amr `otp` too. An account
  // that still owes its first password must pay it at /primer-acceso, where the
  // arming stamp decides which session may — never here.
  it("refuses an account whose first-access password is still pending, before updateUser", async () => {
    const { updateUser } = mockUpdateClient({
      user: { id: "user-uuid", app_metadata: { password_setup_pending: true } },
      amr: [{ method: "otp", timestamp: nowSeconds() }],
    });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.error).toMatch(/primera contraseña/);
    expect(result.ok).toBeFalsy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  // LOW-6 (2026-09-18): GoTrue refuses to set a password from an aal1 session of
  // an account with a verified factor (measured on local v2.188.1). The code was
  // right; the person must be told where the way out is, not to retry.
  it("points an account with a second factor at the admin reset when GoTrue demands aal2", async () => {
    mockUpdateClient({
      user: { id: "user-uuid" },
      updateError: {
        status: 401,
        code: "insufficient_aal",
        message: "AAL2 session is required to update email or password when MFA is enabled.",
      },
    });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.error).toMatch(/verificación en dos pasos/);
    expect(result.error).toMatch(/restablezca tus credenciales/);
  });

  it("refuses a recovery session older than the window", async () => {
    const stale = nowSeconds() - RECOVERY_PROOF_WINDOW_MS / 1000 - 60;
    const { updateUser } = mockUpdateClient({
      user: { id: "user-uuid" },
      amr: [{ method: "recovery", timestamp: stale }],
    });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.error).toMatch(EXPIRED);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the session token cannot be read", async () => {
    const { updateUser } = mockUpdateClient({ user: { id: "user-uuid" }, accessToken: null });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.error).toMatch(EXPIRED);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses an amr in RFC-8176 string form (method known, instant unknown)", async () => {
    const { updateUser } = mockUpdateClient({ user: { id: "user-uuid" }, amr: ["recovery"] });
    const result = await updatePasswordAction({ error: null }, form());
    expect(result.error).toMatch(EXPIRED);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("pins the window boundary: exactly at the edge passes, one second past fails", () => {
    const now = new Date("2026-09-18T12:00:00Z");
    const at = (msAgo: number) => [
      { method: "recovery", timestamp: (now.getTime() - msAgo) / 1000 },
    ];
    expect(hasFreshRecoveryProof(at(RECOVERY_PROOF_WINDOW_MS), now)).toBe(true);
    expect(hasFreshRecoveryProof(at(RECOVERY_PROOF_WINDOW_MS + 1000), now)).toBe(false);
    expect(RECOVERY_PROOF_WINDOW_MS).toBe(30 * 60 * 1000);
    const justNow = now.getTime() / 1000;
    expect(hasFreshRecoveryProof([{ method: "magiclink", timestamp: justNow }], now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// changePasswordAction — /cuenta, current password required (A04-1)
// ---------------------------------------------------------------------------

describe("changePasswordAction (A04-1)", () => {
  function mockLive(ok = true) {
    const mainSignOut = vi.fn().mockResolvedValue({ error: null });
    mockRequireLiveUser.mockResolvedValue(
      ok
        ? {
            ok: true,
            supabase: { auth: { signOut: mainSignOut } },
            user: { id: "user-uuid", email: "ana@mimar.ar", emailConfirmed: true },
            profile: null,
            sessionStartedAt: null,
          }
        : {
            ok: false,
            reason: "NO_SESSION",
            error: "Sesión expirada.",
            supabase: null,
            user: null,
          },
    );
    return { mainSignOut };
  }

  function mockThrowaway({
    signInError = null as unknown,
    signedInId = "user-uuid",
    updateError = null as unknown,
  } = {}) {
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: { user: signInError ? null : { id: signedInId } },
      error: signInError,
    });
    const updateUser = vi.fn().mockResolvedValue({ error: updateError });
    const signOut = vi.fn().mockResolvedValue({ error: null });
    mockCreateAnonClient.mockReturnValue({ auth: { signInWithPassword, updateUser, signOut } });
    return { signInWithPassword, updateUser, signOut };
  }

  const form = (current = "viejaPass1!") =>
    makeForm({ currentPassword: current, password: "nuevaPass1!", confirmPassword: "nuevaPass1!" });

  it("refuses a caller that is not live, before touching GoTrue", async () => {
    mockLive(false);
    const { signInWithPassword } = mockThrowaway();
    const result = await changePasswordAction({ error: null }, form());
    expect(result.error).toBe("Sesión expirada.");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("refuses a missing current password", async () => {
    mockLive();
    const { signInWithPassword } = mockThrowaway();
    const result = await changePasswordAction({ error: null }, form(""));
    expect(result.error).toMatch(/contraseña actual/);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password and changes nothing", async () => {
    const { mainSignOut } = mockLive();
    const { updateUser } = mockThrowaway({ signInError: { message: "Invalid login credentials" } });
    const result = await changePasswordAction({ error: null }, form());
    expect(result.error).toBe("La contraseña actual no es correcta.");
    expect(updateUser).not.toHaveBeenCalled();
    expect(mainSignOut).not.toHaveBeenCalled();
  });

  it("refuses a proof that names a different account", async () => {
    mockLive();
    const { updateUser } = mockThrowaway({ signedInId: "someone-else" });
    const result = await changePasswordAction({ error: null }, form());
    expect(result.error).toBe("La contraseña actual no es correcta.");
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("proves the password against the account's OWN address, then updates through the proof session", async () => {
    const { mainSignOut } = mockLive();
    const { signInWithPassword, updateUser } = mockThrowaway();
    const result = await changePasswordAction({ error: null }, form());
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "ana@mimar.ar",
      password: "viejaPass1!",
    });
    expect(updateUser).toHaveBeenCalledWith({ password: "nuevaPass1!" });
    expect(mainSignOut).toHaveBeenCalledWith({ scope: "others" });
    expect(result).toEqual({ error: null, ok: true });
  });

  it("spends the login's per-account budget and refuses when it is spent", async () => {
    mockLive();
    const { signInWithPassword } = mockThrowaway();
    mockEnforceRateLimit.mockRejectedValueOnce(
      new RateLimitError(new Date(Date.now() + 60_000), "auth_login_email"),
    );
    const result = await changePasswordAction({ error: null }, form());
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "auth_login_email",
      expect.any(String),
      expect.any(Object),
    );
    expect(result.error).toMatch(/demasiados intentos/i);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("an account with a second factor is pointed at the admin reset, not at 'another password'", async () => {
    const { mainSignOut } = mockLive();
    const { signOut } = mockThrowaway({
      updateError: {
        code: "insufficient_aal",
        message: "AAL2 session is required to update email or password when MFA is enabled.",
      },
    });
    const result = await changePasswordAction({ error: null }, form());
    expect(result.error).toMatch(/restablezca tus credenciales/);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mainSignOut).not.toHaveBeenCalled();
  });

  it("returns one generic sentence when the update fails, never GoTrue's text", async () => {
    const { mainSignOut } = mockLive();
    mockThrowaway({
      updateError: { message: "New password should be different from the old password." },
    });
    const result = await changePasswordAction({ error: null }, form());
    expect(result.error).toBe(
      "No se pudo cambiar la contraseña. Probá con otra contraseña distinta de la actual.",
    );
    expect(mainSignOut).not.toHaveBeenCalled();
  });
});
