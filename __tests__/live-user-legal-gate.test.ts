// The legal re-acceptance gate inside `requireLiveUser` (2026-10-07; security
// review of textos-legales-v14, findings 1-3).
//
// The re-acceptance screens are not the boundary. Every server action (web,
// cookie path) and every /api/v1 route (bearer path) resolves the caller
// through `requireLiveUser`, so the gate lives there:
//   · cookie path (web pages and server actions) — always refused;
//   · bearer path WITH `x-app-version` (v14+) — refused (403);
//   · bearer path WITHOUT it (v13) — let through until LEGAL_V13_SUNSET, then
//     CLIENT_UPGRADE_REQUIRED (426);
//   · the surfaces that opt out (`allowPendingLegal`) — let through;
//   · institutional accounts, a signup still on step 2, an account on the
//     current version — never gated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};
const mockHeaders = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mockSupabaseClient }));
vi.mock("next/headers", () => ({ headers: async () => mockHeaders() }));

const mockGetProfileCached = vi.fn();
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
}));

import { liveUserMessage, requireLiveUser } from "@/lib/infra/live-user";

const OWES = {
  id: "user-001",
  role: "owner",
  displayName: "Ana Pérez",
  accountType: "personal",
  deactivatedAt: null,
  deletedAt: null,
  tosAcceptedAt: new Date("2026-09-25T12:00:00Z"),
  tosVersion: "2026-09-24",
};

function withHeader(version: string | null) {
  mockHeaders.mockReturnValue(new Headers(version === null ? {} : { "x-app-version": version }));
}

const BEARER = { supabase: mockSupabaseClient as never, accessToken: "token" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "0");
  vi.stubEnv("LEGAL_V13_SUNSET", "");
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-001", email: "ana@dim-test.local" } },
    error: null,
  });
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetProfileCached.mockResolvedValue(OWES);
  withHeader(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the cookie path (web pages and server actions)", () => {
  it("refuses an account that owes the acceptance, with es-AR copy", async () => {
    const live = await requireLiveUser();
    expect(live.ok).toBe(false);
    if (live.ok) return;
    expect(live.reason).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect(live.error).toBe(liveUserMessage("LEGAL_ACCEPTANCE_REQUIRED"));
    expect(live.user).toEqual({ id: "user-001", email: "ana@dim-test.local" });
  });

  it("refuses an account with NO acceptance recorded too", async () => {
    mockGetProfileCached.mockResolvedValue({ ...OWES, tosAcceptedAt: null, tosVersion: null });
    const live = await requireLiveUser();
    expect(live.ok === false && live.reason).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("is not opened by a missing app-version header — that exemption is native-only", async () => {
    withHeader(null);
    const live = await requireLiveUser();
    expect(live.ok === false && live.reason).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("lets the exempt surfaces through (allowPendingLegal)", async () => {
    const live = await requireLiveUser({ allowPendingLegal: true });
    expect(live.ok).toBe(true);
  });
});

describe("who is never gated", () => {
  it("an account on the current version", async () => {
    mockGetProfileCached.mockResolvedValue({ ...OWES, tosVersion: "2026-10-07" });
    expect((await requireLiveUser()).ok).toBe(true);
  });

  it("an institutional account (it may be refused for other reasons, never this one)", async () => {
    mockGetProfileCached.mockResolvedValue({ ...OWES, role: "govt", accountType: "institutional" });
    const live = await requireLiveUser();
    expect(live.ok === false && live.reason).not.toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("a signup still on step 2 (provisional name = email local part)", async () => {
    mockGetProfileCached.mockResolvedValue({ ...OWES, displayName: "ana", tosVersion: null });
    expect((await requireLiveUser()).ok).toBe(true);
  });

  it("a test double that did not load the consent columns", async () => {
    const { tosAcceptedAt: _a, tosVersion: _v, ...withoutColumns } = OWES;
    mockGetProfileCached.mockResolvedValue(withoutColumns);
    expect((await requireLiveUser()).ok).toBe(true);
  });
});

describe("the bearer path (/api/v1)", () => {
  it("refuses v14 and later (they send x-app-version)", async () => {
    withHeader("1.4.0");
    const live = await requireLiveUser(BEARER);
    expect(live.ok === false && live.reason).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("lets v13 (no header) through while no sunset is configured", async () => {
    withHeader(null);
    expect((await requireLiveUser(BEARER)).ok).toBe(true);
  });

  it("lets v13 through BEFORE the sunset", async () => {
    vi.stubEnv("LEGAL_V13_SUNSET", "2999-01-01");
    withHeader(null);
    expect((await requireLiveUser(BEARER)).ok).toBe(true);
  });

  it("tells v13 to update AFTER the sunset", async () => {
    vi.stubEnv("LEGAL_V13_SUNSET", "2026-01-01");
    withHeader(null);
    const live = await requireLiveUser(BEARER);
    expect(live.ok === false && live.reason).toBe("CLIENT_UPGRADE_REQUIRED");
    expect(live.ok === false && live.error).toBe(
      "Actualizá la app desde Google Play para seguir usando miMAR.",
    );
  });

  it("reads an unparseable sunset as 'no sunset yet' (the safe default for v13 users)", async () => {
    vi.stubEnv("LEGAL_V13_SUNSET", "cuando salga v14");
    withHeader(null);
    expect((await requireLiveUser(BEARER)).ok).toBe(true);
  });

  it("lets the exempt routes through even for v14", async () => {
    withHeader("1.4.0");
    expect((await requireLiveUser({ ...BEARER, allowPendingLegal: true })).ok).toBe(true);
  });
});
