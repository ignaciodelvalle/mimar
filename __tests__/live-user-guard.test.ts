// Unit tests for requireLiveUser() — the ONE result-shaped liveness guard
// (lib/infra/live-user.ts).
//
// "Live" means all four of: the platform is accepting writes, a session exists,
// the account was not erased (Ley 25.326 art. 16), and the account was not
// deactivated. Before this guard those four checks were scattered — maintenance
// in four layouts, erasure in two guards plus five hand-copied inline snippets,
// deactivation only inside loadActiveInstitutionalProfile — so a maintenance
// window never stopped an in-flight server action and 19 write boundaries had
// no erasure check at all.
//
// Strategy mirrors __tests__/auth-guards.test.ts: mock @/lib/supabase/server and
// @/lib/infra/request-cache; no DB, no Supabase instance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockCreateClient = vi.fn();
// getSession is part of the shape because requireLiveUser reads the access token
// back from it on the cookie path to date the session (B9, lib/infra/operator-shift.ts).
// A mock without it would pass only because the guard swallows the failure — which
// is a real safety net, but not something these tests should be silently exercising.
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/request-cache
// ---------------------------------------------------------------------------

const mockGetProfileCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
}));

import {
  DEACTIVATED_MESSAGE_INSTITUTIONAL,
  DEACTIVATED_MESSAGE_PERSONAL,
  type LiveUserFailureReason,
  PASSWORD_SETUP_PENDING_MESSAGE,
  liveUserMessage,
  requireLiveUser,
  resolveOptionalLiveUser,
} from "@/lib/infra/live-user";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function session(id = "user-001", email = "user@dim-test.local") {
  return { data: { user: { id, email } }, error: null };
}

// A session whose address GoTrue has stamped as read. `email_confirmed_at` is
// the only server-side record that anyone opened that mailbox, and it is the
// bit the transfer/caretaker addressee rules read through `user.emailConfirmed`
// (A09-1). The plain `session()` above leaves it unset on purpose, so the two
// helpers between them cover both states of the derivation.
function confirmedSession(id = "user-001", email = "user@dim-test.local") {
  return {
    data: { user: { id, email, email_confirmed_at: "2026-09-01T12:00:00.000Z" } },
    error: null,
  };
}

function noSession() {
  return { data: { user: null }, error: null };
}

function profile(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-001",
    role: "owner",
    displayName: "Test",
    accountType: "personal",
    deactivatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "0");
  mockCreateClient.mockResolvedValue(mockSupabaseClient);
  mockGetUser.mockResolvedValue(noSession());
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetProfileCached.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Precedence — maintenance is the kill switch and runs FIRST
// ---------------------------------------------------------------------------

describe("requireLiveUser() — maintenance", () => {
  it("refuses with MAINTENANCE when the kill-switch is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "1");
    mockGetUser.mockResolvedValue(session());

    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("MAINTENANCE");
  });

  // The four portal layouts short-circuit on maintenance BEFORE any auth or data
  // fetch, precisely so the screen still renders when the database is the thing
  // being maintained. The guard has to keep that property or it would turn a
  // maintenance window into a 500.
  it("does not touch auth or the database when maintenance is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "true");

    await requireLiveUser();

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockGetProfileCached).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session / erasure / deactivation
// ---------------------------------------------------------------------------

describe("requireLiveUser() — session and account state", () => {
  it("refuses with NO_SESSION when there is no user", async () => {
    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("NO_SESSION");
    expect(result.user).toBeNull();
  });

  it("refuses with ACCOUNT_ERASED when profiles.deleted_at is set", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ deletedAt: new Date("2026-01-01") }));

    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ACCOUNT_ERASED");
    expect(result.user).toEqual({ id: "user-001" });
  });

  it("refuses with DEACTIVATED for a deactivated INSTITUTIONAL account", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "institutional", role: "govt", deactivatedAt: new Date() }),
    );

    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("DEACTIVATED");
  });

  // THE DEFECT THIS CLOSES, and the test that used to assert it.
  //
  // This case previously read "admits a deactivated PERSONAL account (matches
  // isDeactivatedInstitutional)" and passed, because the predicate was
  // institutional-only. That made DeactivateAccountDialog a lie: it told a
  // person "esta acción es irreversible desde el panel" and then charged them
  // nothing — `deactivated_at` was written and no boundary ever read it.
  //
  // Refusing is only half the fix; the other half is that /cuenta now carries a
  // reactivation card and the citizen shell carries a standing banner, so the
  // refusal has somewhere to point WITHOUT a redirect (see the guard's comment
  // on why a redirect is the one thing DEACTIVATED must never do).
  it("refuses with DEACTIVATED for a deactivated PERSONAL account", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "personal", deactivatedAt: new Date() }),
    );

    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("DEACTIVATED");
  });

  // NON-VACUITY for the widening: an ACTIVE personal account is still live. A
  // predicate mutated to `true` would pass every test above this one.
  it("admits a personal account whose deactivated_at is null", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "personal", deactivatedAt: null }),
    );

    const result = await requireLiveUser();

    expect(result.ok).toBe(true);
  });

  // The two refusals carry DIFFERENT copy, because the two remedies are
  // different acts by different people. One reason, one wire code, two strings.
  it("tells a personal account it can come back, and an institutional one who to ask", async () => {
    mockGetUser.mockResolvedValue(session());

    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "personal", deactivatedAt: new Date() }),
    );
    const personal = await requireLiveUser();

    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "institutional", role: "govt", deactivatedAt: new Date() }),
    );
    const institutional = await requireLiveUser();

    if (personal.ok || institutional.ok) throw new Error("unreachable");
    expect(personal.error).toBe(DEACTIVATED_MESSAGE_PERSONAL);
    expect(institutional.error).toBe(DEACTIVATED_MESSAGE_INSTITUTIONAL);
    expect(personal.error).not.toBe(institutional.error);
    // The personal copy must not send somebody to ask a stranger for permission
    // to undo their own decision — that was the dead end the widening would
    // have created on its own.
    expect(personal.error).not.toMatch(/contact/i);
    // And the reason-only copy must not name an account type it never looked at.
    expect(liveUserMessage("DEACTIVATED")).not.toMatch(/institucional/i);
  });

  it("erasure outranks deactivation when both are set", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({
        accountType: "institutional",
        deactivatedAt: new Date(),
        deletedAt: new Date(),
      }),
    );

    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ACCOUNT_ERASED");
  });

  it("admits a healthy session and returns the user plus the resolved profile", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile());

    const result = await requireLiveUser();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user).toEqual({
      id: "user-001",
      email: "user@dim-test.local",
      emailConfirmed: false,
    });
    expect(result.profile?.role).toBe("owner");
  });

  // `emailConfirmed` is a boolean derived from a nullable GoTrue column, and an
  // e-mail-addressed transfer or caretaker grant reads it to decide whether an
  // address match proves the invitation is yours. A derivation exercised in one
  // state only is not covered, so this pins the other one — and, because the
  // assertion is exact, it also pins that the GoTrue user is spread through
  // rather than narrowed: a later narrowing turns this red on purpose.
  it("reports a stamped email_confirmed_at as a confirmed address", async () => {
    mockGetUser.mockResolvedValue(confirmedSession());
    mockGetProfileCached.mockResolvedValue(profile());

    const result = await requireLiveUser();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user).toEqual({
      id: "user-001",
      email: "user@dim-test.local",
      email_confirmed_at: "2026-09-01T12:00:00.000Z",
      emailConfirmed: true,
    });
  });

  // First access (pilot T1-P3, security review item 4). Page loads were already
  // sent to /primer-acceso; every server action and /api/v1 route resolves the
  // caller here, and used to let the unfinished session act.
  it("refuses a session that still owes its first password, as NO_SESSION with its own copy", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: "user-001",
          email: "invitado@dim-test.local",
          app_metadata: { password_setup_pending: true },
        },
      },
      error: null,
    });
    mockGetProfileCached.mockResolvedValue(profile({ accountType: "institutional", role: "govt" }));

    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("NO_SESSION");
    expect(result.passwordSetupPending).toBe(true);
    expect(result.error).toBe(
      "Antes de seguir tenés que elegir tu contraseña. Abrí el link de acceso que te llegó por mail.",
    );
    expect(result.error).toBe(PASSWORD_SETUP_PENDING_MESSAGE);
    expect(result.user).toEqual({ id: "user-001", email: "invitado@dim-test.local" });
  });

  it("admits the same account once the flag is false, and ignores a non-boolean flag", async () => {
    mockGetProfileCached.mockResolvedValue(profile({ accountType: "institutional", role: "govt" }));
    for (const flag of [false, "true", undefined]) {
      mockGetUser.mockResolvedValue({
        data: { user: { id: "user-001", app_metadata: { password_setup_pending: flag } } },
        error: null,
      });
      const result = await requireLiveUser();
      expect(result.ok).toBe(true);
    }
  });

  it("a deactivated account that also owes its password is refused as DEACTIVATED", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-001", app_metadata: { password_setup_pending: true } } },
      error: null,
    });
    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "institutional", role: "govt", deactivatedAt: new Date() }),
    );

    const result = await requireLiveUser();

    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("DEACTIVATED");
    expect(result.passwordSetupPending).toBeUndefined();
  });

  // Signup writes auth.users before the profile row exists; the pre-existing
  // guards all used `profile?.deletedAt != null`, i.e. a missing row passed.
  it("admits a session whose profile row does not exist yet (mid-signup)", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(null);

    const result = await requireLiveUser();

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Injected client — the bearer entry point (T1.2 item 4 / Track 2)
// ---------------------------------------------------------------------------

describe("requireLiveUser() — injected client", () => {
  it("uses the supplied client and never builds a cookie client", async () => {
    const bearerGetUser = vi.fn().mockResolvedValue(session("bearer-user"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "bearer-user" }));

    const result = await requireLiveUser({
      supabase: { auth: { getUser: bearerGetUser } } as never,
    });

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(bearerGetUser).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  // The load-bearing invariant: authorization is 100% DB-resolved. A bearer
  // caller must be subject to the SAME profile lookup as a cookie caller — the
  // token says who, the database says what they may do.
  it("resolves the profile from the database for a bearer caller too", async () => {
    const bearerGetUser = vi.fn().mockResolvedValue(session("bearer-user"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "bearer-user", deletedAt: new Date() }));

    const result = await requireLiveUser({
      supabase: { auth: { getUser: bearerGetUser } } as never,
    });

    expect(mockGetProfileCached).toHaveBeenCalledWith("bearer-user");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ACCOUNT_ERASED");
  });
});

// ---------------------------------------------------------------------------
// resolveOptionalLiveUser — the anonymous-allowed write boundaries
// ---------------------------------------------------------------------------
//
// Three writes accept an anonymous caller BY DESIGN: the anonymous denuncia
// (createWelfareReportAction) and the two adoption-application actions, which
// pass `applicant: user ? {…} : null` into the use-case. requireLiveUser is the
// wrong shape for them — it refuses NO_SESSION — but "anonymous is allowed"
// never meant "erased, deactivated and mid-maintenance are allowed too", which
// is what a bare getUser() gave them.

describe("resolveOptionalLiveUser()", () => {
  it("admits an anonymous caller with user: null", async () => {
    const result = await resolveOptionalLiveUser();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user).toBeNull();
  });

  it("admits a healthy authenticated caller", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile());

    const result = await resolveOptionalLiveUser();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user?.id).toBe("user-001");
  });

  it("refuses during maintenance — anonymous or not, the platform is not writing", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "1");

    const result = await resolveOptionalLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("MAINTENANCE");
  });

  // The hole this closes: an erased account keeps a valid JWT, so a bare
  // getUser() handed the use-case a live `applicant.userId` for a subject whose
  // PII has already been hashed. Falling back to "anonymous" would be worse
  // still — it would silently launder the submission.
  it("refuses an erased account rather than downgrading it to anonymous", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ deletedAt: new Date() }));

    const result = await resolveOptionalLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ACCOUNT_ERASED");
  });

  // An unfinished first access is somebody holding an institutional account's
  // access link — not an anonymous citizen. Refused, never laundered.
  it("refuses a session that still owes its first password rather than treating it as anonymous", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-001", app_metadata: { password_setup_pending: true } } },
      error: null,
    });
    mockGetProfileCached.mockResolvedValue(profile({ accountType: "institutional", role: "govt" }));

    const result = await resolveOptionalLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe(PASSWORD_SETUP_PENDING_MESSAGE);
  });

  it("refuses a deactivated institutional account", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "institutional", deactivatedAt: new Date() }),
    );

    const result = await resolveOptionalLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("DEACTIVATED");
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("liveUserMessage()", () => {
  const reasons: LiveUserFailureReason[] = [
    "NO_SESSION",
    "ACCOUNT_ERASED",
    "MAINTENANCE",
    "DEACTIVATED",
  ];

  it("returns a distinct, non-empty es-AR message for every reason", () => {
    const messages = reasons.map(liveUserMessage);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
  });

  // These two strings are already on screen today, hand-copied across ~24 write
  // boundaries. Keeping them byte-identical means the migration is invisible to
  // users and to the copy tests that assert on them.
  it("keeps the existing wording for the two pre-existing refusals", () => {
    expect(liveUserMessage("NO_SESSION")).toBe("Sesión expirada.");
    expect(liveUserMessage("ACCOUNT_ERASED")).toBe("Tu cuenta fue eliminada.");
  });
});

// ---------------------------------------------------------------------------
// Second factor (T2-S6) — institutional sessions must reach aal2
// ---------------------------------------------------------------------------

describe("requireLiveUser() — second factor for institutional accounts (T2-S6)", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (claims: Record<string, unknown>) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
  const now = () => Math.floor(Date.now() / 1000);
  const verified = [{ id: "f-1", factor_type: "totp", status: "verified" }];

  function operator(factors: unknown[] | undefined, claims: Record<string, unknown> | null) {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-001", email: "op@dim-test.local", factors } },
      error: null,
    });
    mockGetSession.mockResolvedValue({
      data: { session: claims ? { access_token: token(claims) } : null },
      error: null,
    });
    mockGetProfileCached.mockResolvedValue(profile({ role: "govt", accountType: "institutional" }));
  }

  it("refuses an operator without a verified factor as NO_SESSION + mfaPending enrol", async () => {
    operator(undefined, { aal: "aal1", amr: [{ method: "password", timestamp: now() }] });
    const result = await requireLiveUser();
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("NO_SESSION");
    expect(result.mfaPending).toBe("enrol");
    expect(result.error).toMatch(/segundo factor/);
  });

  it("refuses an aal1 session of an operator WITH a factor as mfaPending challenge", async () => {
    operator(verified, { aal: "aal1", amr: [{ method: "password", timestamp: now() }] });
    const result = await requireLiveUser();
    if (result.ok) throw new Error("expected a refusal");
    expect(result.mfaPending).toBe("challenge");
    expect(result.error).toMatch(/código de verificación/);
  });

  it("admits the same operator at aal2", async () => {
    operator(verified, { aal: "aal2", amr: [{ method: "totp", timestamp: now() }] });
    expect((await requireLiveUser()).ok).toBe(true);
  });

  it("never asks a personal account, whatever the session", async () => {
    operator(undefined, { aal: "aal1", amr: [{ method: "password", timestamp: now() }] });
    mockGetProfileCached.mockResolvedValue(profile());
    expect((await requireLiveUser()).ok).toBe(true);
  });

  it("fails OPEN when the aal claim cannot be read (mfa-policy.ts states why)", async () => {
    operator(undefined, null);
    expect((await requireLiveUser()).ok).toBe(true);
  });

  it("puts the second factor BEFORE the shift: an unpassed factor is not a finished shift", async () => {
    const tenHoursAgo = now() - 10 * 60 * 60;
    operator(verified, { aal: "aal1", amr: [{ method: "password", timestamp: tenHoursAgo }] });
    const result = await requireLiveUser();
    if (result.ok) throw new Error("expected a refusal");
    expect(result.mfaPending).toBe("challenge");
  });

  it("resolveOptionalLiveUser does not launder an unpassed operator into an anonymous caller", async () => {
    operator(verified, { aal: "aal1", amr: [{ method: "password", timestamp: now() }] });
    const result = await resolveOptionalLiveUser();
    expect(result.ok).toBe(false);
  });
});
