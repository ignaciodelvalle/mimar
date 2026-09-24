// Regression tests — qa-triage-2026-07-23 finding #13: a session-expiry bounce
// on /gob or /admin used to redirect the operator to bare /iniciar-sesion, losing the
// exact deep link they were on (e.g. /gob/denuncias?etapa=triage&queue=mine).
// requireAdminOrGovtOrRedirect / requireAdminOrRedirect now forward the
// current request's full path (middleware.ts's `x-full-path` header) as
// `returnTo` into requireUserOrRedirect, so /iniciar-sesion can restore it after a
// successful re-login (LoginPage already supports returnTo — see
// app/(auth)/iniciar-sesion/page.tsx's safeReturnTo handling; that half was already
// correct, this fixes the half that discarded the URL before ever reaching it).

import { describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const getUserMock = vi.fn(async () => ({ data: { user: null } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock } }),
}));

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async () => null),
  getJurisdictionsCached: vi.fn(async () => []),
  getOrgMembershipCached: vi.fn(async () => null),
}));

import { requireAdminOrGovtOrRedirect, requireAdminOrRedirect } from "./auth-guards";

describe("requireAdminOrGovtOrRedirect — returnTo preservation (finding #13)", () => {
  it("an unauthenticated /gob/* request redirects to /iniciar-sesion carrying the full attempted URL (path + query)", async () => {
    headersMock.mockReturnValue({
      get: (name: string) =>
        name === "x-full-path" ? "/gob/denuncias?etapa=triage&queue=mine" : null,
    });

    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(/^REDIRECT:/);

    expect(redirectMock).toHaveBeenCalledTimes(1);
    const [url] = redirectMock.mock.calls[0] as [string];
    expect(url).toBe(
      `/iniciar-sesion?returnTo=${encodeURIComponent("/gob/denuncias?etapa=triage&queue=mine")}`,
    );
  });

  it("falls back to bare /iniciar-sesion when the x-full-path header is absent (never throws)", async () => {
    redirectMock.mockClear();
    headersMock.mockReturnValue({ get: () => null });

    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(/^REDIRECT:/);

    expect(redirectMock).toHaveBeenCalledWith("/iniciar-sesion");
  });

  it("falls back to bare /iniciar-sesion when headers() itself throws (e.g. no request context)", async () => {
    redirectMock.mockClear();
    headersMock.mockImplementation(() => {
      throw new Error("no request context");
    });

    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(/^REDIRECT:/);

    expect(redirectMock).toHaveBeenCalledWith("/iniciar-sesion");
  });
});

describe("requireAdminOrRedirect — returnTo preservation (finding #13)", () => {
  it("an unauthenticated /admin/* request also carries the full attempted URL", async () => {
    redirectMock.mockClear();
    headersMock.mockReturnValue({
      get: (name: string) => (name === "x-full-path" ? "/admin/programa?province=AR-C" : null),
    });

    await expect(requireAdminOrRedirect()).rejects.toThrow(/^REDIRECT:/);

    expect(redirectMock).toHaveBeenCalledWith(
      `/iniciar-sesion?returnTo=${encodeURIComponent("/admin/programa?province=AR-C")}`,
    );
  });
});
