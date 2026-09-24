// Unit tests for the /api/gob/* institutional gate (task #12). Mirrors the
// panorama gate test: a personal-account 'admin', a deactivated operator, an
// erased operator, and non-institutional roles must get 401/403 — never data —
// and the aggregate per-operator cap answers 429. A legit ACTIVE institutional
// admin/govt is admitted with its jurisdiction tuples.
//
// Pure mock-based — no DB, no Supabase instance.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
// getSession answers the SHIFT question (B9): requireLiveUser reads the access
// token back off the SSR client to find when this session authenticated. A
// client without it makes the shift unresolvable, which fails OPEN — so a gate
// test whose fake client omits getSession is a gate test that can never see the
// shift, whether or not the guard applies it.
const mockGetSession = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

const mockGetProfileCached = vi.fn();
const mockGetJurisdictionsCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
  getJurisdictionsCached: (...args: unknown[]) => mockGetJurisdictionsCached(...args),
}));

const mockReportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/infra/rate-limit", () => {
  class RateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return {
    RateLimitError,
    enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
  };
});

import { amrToken } from "@/__tests__/helpers/amr-token";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { resolveInstitutionalGobActor } from "../_guard";

/** Pin the SSR client's session to a token authenticated `hoursAgo` hours ago. */
function sessionStartedHoursAgo(hoursAgo: number) {
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: amrToken(hoursAgo) } },
    error: null,
  });
}

function session(id = "user-1") {
  return { data: { user: { id, email: `${id}@dim-test.local` } }, error: null };
}
function noSession() {
  return { data: { user: null }, error: null };
}

type ProfileOverrides = Partial<{
  id: string;
  role: "owner" | "vet" | "govt" | "admin" | "national";
  displayName: string;
  accountType: "personal" | "institutional";
  deactivatedAt: Date | null;
  deletedAt: Date | null;
}>;

function profile(o: ProfileOverrides = {}) {
  return {
    id: "user-1",
    role: "admin",
    displayName: "Test",
    accountType: "institutional",
    deactivatedAt: null,
    deletedAt: null,
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue(noSession());
  // Fresh by default, so the shift never interferes with a test about something
  // else — and so the shift tests below have to say so explicitly.
  sessionStartedHoursAgo(1);
});

describe("resolveInstitutionalGobActor — rejections", () => {
  it("401 when there is no session", async () => {
    mockGetUser.mockResolvedValue(noSession());
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("401 when the profile row is missing", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(null);
    const r = await resolveInstitutionalGobActor();
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("401 when the account has been erased (deletedAt set)", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ deletedAt: new Date("2026-07-01") }));
    const r = await resolveInstitutionalGobActor();
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("403 when role=admin but accountType is personal", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ accountType: "personal" }));
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("403 when an institutional govt is deactivated", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({ role: "govt", deactivatedAt: new Date("2026-01-01") }),
    );
    const r = await resolveInstitutionalGobActor();
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("403 for role=owner", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ role: "owner", accountType: "personal" }));
    const r = await resolveInstitutionalGobActor();
    if (!r.ok) expect(r.response.status).toBe(403);
  });
});

describe("resolveInstitutionalGobActor — admits legit operators", () => {
  it("admits an active institutional admin with empty jurisdictions", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.role).toBe("admin");
      expect(r.actor.jurisdictions).toEqual([]);
    }
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("admits an active institutional govt and returns its jurisdiction tuples", async () => {
    mockGetUser.mockResolvedValue(session("govt-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "govt-ok", role: "govt" }));
    mockGetJurisdictionsCached.mockResolvedValue([{ province: "CABA", locality: "Palermo" }]);
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.role).toBe("govt");
      expect(r.actor.jurisdictions).toEqual([{ province: "CABA", locality: "Palermo" }]);
    }
    expect(mockGetJurisdictionsCached).toHaveBeenCalledWith("govt-ok");
  });

  // Read-only national role (migration 0214): these routes are READ-ONLY, so
  // the gate admits it exactly like admin — universal scope, no jurisdiction
  // fan-out. The write-side guard (requireAdminOrGovtOrRedirect) still refuses
  // it; see __tests__/auth-guards.test.ts.
  it("admits an active institutional national with empty jurisdictions (read-only role)", async () => {
    mockGetUser.mockResolvedValue(session("national-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "national-ok", role: "national" }));
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.role).toBe("national");
      expect(r.actor.jurisdictions).toEqual([]);
    }
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("403 for a national on a PERSONAL account type (institutional invariant holds for it too)", async () => {
    mockGetUser.mockResolvedValue(session("national-personal"));
    mockGetProfileCached.mockResolvedValue(
      profile({ id: "national-personal", role: "national", accountType: "personal" }),
    );
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The liveness set this gate reached NONE of until 2026-08-25 (B9 + the
// maintenance kill-switch)
// ---------------------------------------------------------------------------
//
// The gate opened with a bare `auth.getUser()` plus a profile read. All seven
// routes behind it are GETs, and that looked like a reason to leave them: it is
// the opposite. The resolver's own doctrine put the shift on org READS because
// "leaving org reads open would leave the console populated on the shared
// desk". An inspector console showing national case and pet detail on a
// municipal machine nobody signed out of IS that exposure.

describe("resolveInstitutionalGobActor — the 8-hour shift (B9)", () => {
  it("401 session_shift_expired past 8 hours, and answers a CODE not a redirect", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    sessionStartedHoursAgo(9);

    const r = await resolveInstitutionalGobActor();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      // NOT "unauthorized". The token is still valid — the WORKDAY ended — so a
      // client told "auth_expired" would refresh successfully and be refused
      // again, forever. That is the native form of the 2026-07-04 redirect loop.
      await expect(r.response.json()).resolves.toEqual({ error: "session_shift_expired" });
    }
    // Refused before the jurisdiction fan-out and before the rate-limit write.
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it("admits the same operator inside the 8 hours", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    sessionStartedHoursAgo(7);

    const r = await resolveInstitutionalGobActor();

    expect(r.ok).toBe(true);
  });

  it("fails OPEN when the token carries no usable amr claim, and reports", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const r = await resolveInstitutionalGobActor();

    // Direction is deliberate: a GoTrue claim-shape change must not lock every
    // operator in the country out of every console at once, over a REFINEMENT
    // of a bound GoTrue still enforces. It reports so somebody looks.
    expect(r.ok).toBe(true);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });
});

describe("resolveInstitutionalGobActor — maintenance kill-switch", () => {
  it("503 with Retry-After during a maintenance window, before any query", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "true");
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));

    const r = await resolveInstitutionalGobActor();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      expect(r.response.headers.get("Retry-After")).toBe("30");
      await expect(r.response.json()).resolves.toEqual({ error: "maintenance" });
    }
    // The kill-switch is an env read evaluated before any client is built,
    // because the database may be the thing under repair.
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockGetProfileCached).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("resolveInstitutionalGobActor — per-operator rate cap", () => {
  it("enforces the gob_api limit keyed on profile id, after auth resolves", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    await resolveInstitutionalGobActor();
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("gob_api", "admin-ok", {
      maxPerMinute: 120,
    });
  });

  it("429s (Retry-After) when the operator exceeds the aggregate cap", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    mockEnforceRateLimit.mockRejectedValueOnce(
      new RateLimitError(new Date(Date.now() + 60_000), "gob_api breach"),
    );
    const r = await resolveInstitutionalGobActor();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(429);
      expect(r.response.headers.get("Retry-After")).toBe("60");
    }
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });
});
