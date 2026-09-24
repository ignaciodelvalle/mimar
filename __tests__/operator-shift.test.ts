// B9 — the 8-hour operator shift, both sides of the boundary.
//
// The PO decision: citizen sessions become LONG (weeks), institutional operators
// (govt / admin / org staff) keep the one-workday boundary. GoTrue's
// `[auth.sessions] timebox` is GLOBAL and cannot discriminate by role, so the
// split is enforced in the app — and these tests are what say it actually is.
//
// What is pinned here, in the order it matters:
//   1. the pure arithmetic (lib/infra/operator-shift.ts), including the two
//      fail-open cases and the claim shape the real GoTrue emits;
//   2. requireLiveUser refusing an INSTITUTIONAL principal past 8h and NOT
//      refusing a citizen at the same age — the actual split;
//   3. the org capability path, whose operators frequently hold a PERSONAL
//      profile and so are invisible to (2).
//
// The claim shape in `amrToken()` is not invented: it was measured against a
// local GoTrue v2.188.1 (`amr: [{ method: "password", timestamp: <unix s> }]`,
// stable across refresh). See the header of lib/infra/operator-shift.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — no DB, no Supabase instance. Mirrors __tests__/live-user-guard.test.ts.
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockCreateClient = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

const mockGetProfileCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
}));

// The fail-open path REPORTS. Silenced here so the suite output stays readable,
// but asserted on below — a fail-open that stopped reporting would be the
// dangerous version of this behaviour.
const mockReportError = vi.fn();

vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import { requireLiveUser } from "@/lib/infra/live-user";
import {
  OPERATOR_SHIFT_MS,
  isOperatorShiftExpired,
  sessionStartFromClaims,
  verifiedSessionStart,
} from "@/lib/infra/operator-shift";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-25T18:00:00.000Z");

/** A JWT whose payload carries the given `amr`. Header/signature are inert. */
function tokenWithClaims(claims: Record<string, unknown>): string {
  const b64url = (value: string) =>
    Buffer.from(value, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}.not-a-real-signature`;
}

/** A token that says the session authenticated `hoursAgo` hours before NOW. */
function amrToken(hoursAgo: number): string {
  const seconds = Math.floor((NOW.getTime() - hoursAgo * 60 * 60 * 1000) / 1000);
  return tokenWithClaims({
    sub: "user-001",
    session_id: "session-001",
    amr: [{ method: "password", timestamp: seconds }],
  });
}

function session(id = "user-001", email = "user@dim-test.local") {
  return { data: { user: { id, email } }, error: null };
}

function profile(overrides: Record<string, unknown> = {}) {
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

/** Puts `token` where the COOKIE path reads it from. */
function cookieSessionToken(token: string) {
  mockGetSession.mockResolvedValue({ data: { session: { access_token: token } }, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "0");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockCreateClient.mockResolvedValue(mockSupabaseClient);
  mockGetUser.mockResolvedValue(session());
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetProfileCached.mockResolvedValue(profile());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. The arithmetic
// ---------------------------------------------------------------------------

describe("operator-shift — reading the session start", () => {
  it("reads the GoTrue amr timestamp shape measured against a real server", () => {
    const started = verifiedSessionStart(amrToken(3));
    expect(started).toEqual(new Date(NOW.getTime() - 3 * 60 * 60 * 1000));
  });

  it("takes the EARLIEST amr entry, so an MFA step-up cannot extend the workday", () => {
    const base = Math.floor(NOW.getTime() / 1000);
    const started = sessionStartFromClaims({
      amr: [
        { method: "otp", timestamp: base - 60 },
        { method: "password", timestamp: base - 7200 },
      ],
    });
    expect(started).toEqual(new Date((base - 7200) * 1000));
  });

  it("returns null for RFC-8176 string amr, which carries no timestamps", () => {
    expect(sessionStartFromClaims({ amr: ["password", "otp"] })).toBeNull();
  });

  it("returns null rather than throwing on a malformed or absent token", () => {
    expect(verifiedSessionStart(undefined)).toBeNull();
    expect(verifiedSessionStart("")).toBeNull();
    expect(verifiedSessionStart("not.a.jwt")).toBeNull();
    expect(verifiedSessionStart("only-one-segment")).toBeNull();
    expect(sessionStartFromClaims({})).toBeNull();
    expect(sessionStartFromClaims({ amr: [{ method: "password" }] })).toBeNull();
  });
});

describe("operator-shift — the boundary", () => {
  it("allows a session younger than 8 hours and refuses one older", () => {
    const at = (hoursAgo: number) =>
      isOperatorShiftExpired({
        sessionStartedAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000),
        now: NOW,
      });
    expect(at(7.9)).toBe(false);
    expect(at(8.1)).toBe(true);
  });

  it("refuses EXACTLY at 8 hours — the boundary is inclusive", () => {
    expect(
      isOperatorShiftExpired({
        sessionStartedAt: new Date(NOW.getTime() - OPERATOR_SHIFT_MS),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("fails OPEN and REPORTS when the session start is unknown", () => {
    expect(isOperatorShiftExpired({ sessionStartedAt: null, now: NOW })).toBe(false);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it("does not treat clock skew (a future auth time) as an expired shift", () => {
    expect(
      isOperatorShiftExpired({
        sessionStartedAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      }),
    ).toBe(false);
    expect(mockReportError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The split — this is the B9 decision itself
// ---------------------------------------------------------------------------

describe("requireLiveUser — the citizen/operator split", () => {
  const institutionalProfiles = [
    ["a govt account", { role: "govt", accountType: "institutional" }],
    ["a platform admin", { role: "admin", accountType: "institutional" }],
    // The two columns are not constrained to agree: the DB CHECK was added in
    // migration 0015 and dropped in 0016. Either half alone must still bind.
    ["a govt row still marked personal", { role: "govt", accountType: "personal" }],
    ["an institutional row still marked owner", { role: "owner", accountType: "institutional" }],
  ] as const;

  for (const [label, overrides] of institutionalProfiles) {
    it(`refuses ${label} with SHIFT_EXPIRED after 8 hours`, async () => {
      mockGetProfileCached.mockResolvedValue(profile(overrides));
      cookieSessionToken(amrToken(9));

      const live = await requireLiveUser();

      expect(live.ok).toBe(false);
      if (live.ok) throw new Error("unreachable");
      expect(live.reason).toBe("SHIFT_EXPIRED");
      // The refusal carries an identity: whoever translates it has to sign the
      // operator out, and you cannot sign out an anonymous session.
      expect(live.user?.id).toBe("user-001");
      // Says what happened AND what to do — "Sesión expirada." would be a lie.
      expect(live.error).toMatch(/turno de trabajo/i);
    });

    it(`still admits ${label} inside the 8 hours`, async () => {
      mockGetProfileCached.mockResolvedValue(profile(overrides));
      cookieSessionToken(amrToken(7));

      const live = await requireLiveUser();

      expect(live.ok).toBe(true);
    });
  }

  it("does NOT refuse a CITIZEN at the same age — this is the whole point of B9", async () => {
    mockGetProfileCached.mockResolvedValue(profile({ role: "owner", accountType: "personal" }));
    cookieSessionToken(amrToken(24 * 20)); // twenty days into a thirty-day session

    const live = await requireLiveUser();

    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error("unreachable");
    expect(live.sessionStartedAt).toEqual(new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000));
  });

  it("does not refuse a caller mid-signup, who has no profile row yet", async () => {
    mockGetProfileCached.mockResolvedValue(null);
    cookieSessionToken(amrToken(100));

    const live = await requireLiveUser();

    expect(live.ok).toBe(true);
  });

  it("adds no friction when the token carries no usable claim (fails open, reports)", async () => {
    mockGetProfileCached.mockResolvedValue(profile({ role: "govt", accountType: "institutional" }));
    cookieSessionToken(tokenWithClaims({ sub: "user-001" }));

    const live = await requireLiveUser();

    expect(live.ok).toBe(true);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it("dates a BEARER session from the token it was handed, never from getSession", async () => {
    mockGetProfileCached.mockResolvedValue(profile({ role: "govt", accountType: "institutional" }));
    // If the guard consulted the cookie path it would see a fresh session and let
    // the request through — so this asserts the bearer token is what decides.
    cookieSessionToken(amrToken(1));

    const live = await requireLiveUser({
      supabase: mockSupabaseClient as never,
      accessToken: amrToken(9),
    });

    expect(live.ok).toBe(false);
    if (live.ok) throw new Error("unreachable");
    expect(live.reason).toBe("SHIFT_EXPIRED");
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("refuses ERASURE and DEACTIVATION ahead of the shift — the mildest refusal is last", async () => {
    mockGetProfileCached.mockResolvedValue(
      profile({ role: "govt", accountType: "institutional", deletedAt: new Date() }),
    );
    cookieSessionToken(amrToken(9));

    const live = await requireLiveUser();

    expect(live.ok).toBe(false);
    if (live.ok) throw new Error("unreachable");
    // Telling an erased account "your shift ended" invites it to sign in again,
    // forever, against an account that will never work.
    expect(live.reason).toBe("ACCOUNT_ERASED");
  });

  it("survives a client whose getSession throws, without failing the request", async () => {
    mockGetProfileCached.mockResolvedValue(profile({ role: "govt", accountType: "institutional" }));
    mockGetSession.mockRejectedValue(new Error("SDK shape changed"));

    const live = await requireLiveUser();

    // Degraded to GoTrue's own global timebox, reported, but not an outage.
    expect(live.ok).toBe(true);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });
});
