// Unit tests for the panorama API institutional gate (HIGH-2 + CRITICAL-1 exfil).
//
// The three /api/panorama/* routes used to gate ONLY on
//   profile.role === 'admin' | 'govt'
// which skipped the account_type / deactivation / erasure invariants that the
// PAGE guard (loadActiveInstitutionalProfile) enforces. resolveInstitutional-
// PanoramaActor closes that gap: a personal-account 'admin', a deactivated
// operator, and an erased operator must get 401/403, never data. A legit ACTIVE
// institutional admin/govt is admitted.
//
// Pure mock-based — no DB, no Supabase instance (mirrors __tests__/auth-guards.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted before the module-under-test import)
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
// getSession answers the SHIFT question (B9) — see app/api/gob/__tests__/
// gob-gate.test.ts for why a fake client without it can never see the shift.
const mockGetSession = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

const mockReportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

const mockGetProfileCached = vi.fn();
const mockGetJurisdictionsCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
  getJurisdictionsCached: (...args: unknown[]) => mockGetJurisdictionsCached(...args),
}));

// Mock the DB-backed rate limiter so the guard's per-operator cap (MED-2) does
// not hit Postgres in this pure unit test. Provide a faithful RateLimitError so
// the guard's `instanceof` check matches when we simulate a breach.
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

const mockGetPanoramaKpis = vi.fn();
vi.mock("@/src/modules/panorama/application/get-panorama-kpis", () => ({
  getPanoramaKpis: (...args: unknown[]) => mockGetPanoramaKpis(...args),
  // The route imports degradedPanoramaKpis for its degraded/503 envelope — keep a
  // faithful stand-in so mocking the module doesn't strip it.
  degradedPanoramaKpis: () => ({
    kpis: [],
    recalculatedFor:
      "No pudimos cargar los indicadores en este momento. Reintentá en unos segundos.",
    dataAsOf: null,
  }),
}));

import { amrToken } from "@/__tests__/helpers/amr-token";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { resolveInstitutionalPanoramaActor } from "../_guard";
import { GET as kpisGET } from "../kpis/route";

/** Pin the SSR client's session to a token authenticated `hoursAgo` hours ago. */
function sessionStartedHoursAgo(hoursAgo: number) {
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: amrToken(hoursAgo) } },
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The liveness set this gate reached NONE of until 2026-08-25
// ---------------------------------------------------------------------------
//
// All six panorama routes are GETs. That is not an exemption: this surface
// answers with NATIONAL aggregate analytics, and the exposure a shared
// municipal desk creates is a console left populated on it overnight, not a
// write.

describe("resolveInstitutionalPanoramaActor — the 8-hour shift (B9)", () => {
  it("401 session_shift_expired past 8 hours", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    sessionStartedHoursAgo(9);

    const r = await resolveInstitutionalPanoramaActor();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      await expect(r.response.json()).resolves.toEqual({ error: "session_shift_expired" });
    }
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it("admits the same operator inside the 8 hours", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    sessionStartedHoursAgo(7);

    const r = await resolveInstitutionalPanoramaActor();

    expect(r.ok).toBe(true);
  });

  // END TO END THROUGH A REAL ROUTE, so this is not only a claim about the
  // helper: the KPI endpoint must not answer national analytics to a session
  // whose workday ended.
  it("keeps national KPIs away from a shift-expired console", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    sessionStartedHoursAgo(9);

    const res = await kpisGET(new Request("http://localhost/api/panorama/kpis"));

    expect(res.status).toBe(401);
    expect(mockGetPanoramaKpis).not.toHaveBeenCalled();
  });

  it("fails OPEN when the token carries no usable amr claim, and reports", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const r = await resolveInstitutionalPanoramaActor();

    expect(r.ok).toBe(true);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });
});

describe("resolveInstitutionalPanoramaActor — maintenance kill-switch", () => {
  it("503 with Retry-After during a maintenance window, before any query", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "true");
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));

    const r = await resolveInstitutionalPanoramaActor();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      expect(r.response.headers.get("Retry-After")).toBe("30");
      await expect(r.response.json()).resolves.toEqual({ error: "maintenance" });
    }
    expect(mockGetUser).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// resolveInstitutionalPanoramaActor — the single gate all three routes share
// ---------------------------------------------------------------------------

describe("resolveInstitutionalPanoramaActor — rejections", () => {
  it("401 when there is no session", async () => {
    mockGetUser.mockResolvedValue(noSession());
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("401 when the profile row is missing", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(null);
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("401 when the account has been erased (deletedAt set)", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ deletedAt: new Date("2026-07-01") }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  // CRITICAL-1 exfil half: a personal-account row that somehow carries role=admin
  // must NOT read panorama data through the API.
  it("403 when role=admin but accountType is personal", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ accountType: "personal" }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
    // No scope lookup for a rejected caller.
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("403 when an institutional admin is deactivated", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ deactivatedAt: new Date("2026-01-01") }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("403 when an institutional govt is deactivated", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(
      profile({ role: "govt", deactivatedAt: new Date("2026-01-01") }),
    );
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("403 for role=owner", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ role: "owner", accountType: "personal" }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("403 for role=vet", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ role: "vet", accountType: "personal" }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
});

describe("resolveInstitutionalPanoramaActor — admits legit operators", () => {
  it("admits an active institutional admin with empty jurisdictions", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.role).toBe("admin");
      expect(r.actor.jurisdictions).toEqual([]);
    }
    // Admin has universal scope — no jurisdictions read.
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("admits an active institutional govt and returns its jurisdiction tuples", async () => {
    mockGetUser.mockResolvedValue(session("govt-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "govt-ok", role: "govt" }));
    mockGetJurisdictionsCached.mockResolvedValue([
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.role).toBe("govt");
      expect(r.actor.jurisdictions).toEqual([{ province: "Buenos Aires", locality: "La Plata" }]);
    }
    expect(mockGetJurisdictionsCached).toHaveBeenCalledWith("govt-ok");
  });

  // Read-only national role (migration 0214): the panorama routes are
  // READ-ONLY, so the gate admits it like admin — universal scope, no
  // jurisdiction fan-out. Writers keep refusing it (auth-guards.test.ts).
  it("admits an active institutional national with empty jurisdictions (read-only role)", async () => {
    mockGetUser.mockResolvedValue(session("national-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "national-ok", role: "national" }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.role).toBe("national");
      expect(r.actor.jurisdictions).toEqual([]);
    }
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MED-2 — per-operator aggregate request cap on /api/panorama/*
// ---------------------------------------------------------------------------

describe("resolveInstitutionalPanoramaActor — per-operator rate cap (MED-2)", () => {
  it("enforces the panorama_api limit keyed on profile id, after auth resolves", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(true);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("panorama_api", "admin-ok", {
      maxPerMinute: 120,
    });
  });

  it("429s (Retry-After) when the operator exceeds the aggregate cap", async () => {
    mockGetUser.mockResolvedValue(session("admin-ok"));
    mockGetProfileCached.mockResolvedValue(profile({ id: "admin-ok", role: "admin" }));
    mockEnforceRateLimit.mockRejectedValueOnce(
      new RateLimitError(new Date(Date.now() + 60_000), "panorama_api breach"),
    );
    const r = await resolveInstitutionalPanoramaActor();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(429);
      expect(r.response.headers.get("Retry-After")).toBe("60");
    }
    // Rejected before any scope lookup.
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through a real route handler (/api/panorama/kpis) to prove the
// route wires the gate and never reaches the use-case for a rejected caller.
// ---------------------------------------------------------------------------

describe("GET /api/panorama/kpis wires the institutional gate", () => {
  const req = () => new Request("http://localhost/api/panorama/kpis");

  it("403s a personal-account admin and never calls the KPI use-case", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ accountType: "personal" }));
    const res = await kpisGET(req());
    expect(res.status).toBe(403);
    expect(mockGetPanoramaKpis).not.toHaveBeenCalled();
  });

  it("401s an erased operator", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ deletedAt: new Date("2026-07-01") }));
    const res = await kpisGET(req());
    expect(res.status).toBe(401);
    expect(mockGetPanoramaKpis).not.toHaveBeenCalled();
  });

  it("200s a legit active institutional admin and delegates to the use-case", async () => {
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ role: "admin" }));
    mockGetPanoramaKpis.mockResolvedValue({ kpis: [] });
    const res = await kpisGET(req());
    expect(res.status).toBe(200);
    expect(mockGetPanoramaKpis).toHaveBeenCalledTimes(1);
  });

  // NEVER-CRASH (task #74): a rejected fan-out must yield a 503 JSON envelope,
  // never a thrown error that crashes the lambda.
  it("503s with a JSON error envelope when the KPI use-case rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetUser.mockResolvedValue(session());
    mockGetProfileCached.mockResolvedValue(profile({ role: "admin" }));
    mockGetPanoramaKpis.mockRejectedValue(new Error("pooler degraded"));

    const res = await kpisGET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("panorama_kpis_unavailable");
    // Carries the degraded strip so a caller can still render an honest state.
    expect(body.kpis).toEqual([]);
    expect(body.dataAsOf).toBeNull();
  });
});
