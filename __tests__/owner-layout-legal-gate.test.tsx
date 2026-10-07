// @vitest-environment jsdom
//
// The owner-portal layout's re-acceptance gate (2026-10-07; security review of
// textos-legales-v14, finding 7). A personal account that owes an acceptance
// of the current legal version is sent to /aceptar-condiciones from every
// owner page — EXCEPT /cuenta/privacidad, where somebody who does not accept
// can still export their data and delete the account (Ley 25.326 arts. 14,
// 16). A signup still on step 2 is not sent there: its version is recorded at
// step 2.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/mis-mascotas",
  profile: null as unknown,
  redirects: [] as string[],
  guardOptions: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirects.push(url);
    throw new Error(`REDIRECT:${url}`);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith("REDIRECT:")) throw err;
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-pathname": state.pathname }),
}));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: async (_returnTo?: string, options?: unknown) => {
    state.guardOptions.push(options);
    return { supabase: {}, user: { id: "user-001", email: "ana@dim-test.local" } };
  },
}));
vi.mock("@/lib/infra/live-user", () => ({ isPlatformInMaintenance: () => false }));
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: async () => state.profile,
  getUnreadCountCached: async () => 0,
  getOrgMembershipsCached: async () => [],
  getOwnedPetsCountCached: async () => 0,
}));

import AuthenticatedLayout from "@/app/(app)/layout";

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

beforeEach(() => {
  state.pathname = "/mis-mascotas";
  state.profile = OWES;
  state.redirects = [];
  state.guardOptions = [];
});

describe("(app) layout — the re-acceptance gate", () => {
  it("sends an account that owes it to /aceptar-condiciones, carrying the page", async () => {
    await expect(AuthenticatedLayout({ children: null })).rejects.toThrow(/^REDIRECT:/);
    expect(state.redirects).toEqual(["/aceptar-condiciones?returnTo=%2Fmis-mascotas"]);
  });

  it("asks the guard to let it decide (the layout knows the exempt path)", async () => {
    await expect(AuthenticatedLayout({ children: null })).rejects.toThrow();
    expect(state.guardOptions).toEqual([{ allowPendingLegal: true }]);
  });

  it("lets /cuenta/privacidad through, so the person can export or delete instead", async () => {
    state.pathname = "/cuenta/privacidad";
    await expect(AuthenticatedLayout({ children: null })).resolves.toBeTruthy();
    expect(state.redirects).toEqual([]);
  });

  it("does not gate an account on the current version", async () => {
    state.profile = { ...OWES, tosVersion: "2026-10-07" };
    await expect(AuthenticatedLayout({ children: null })).resolves.toBeTruthy();
    expect(state.redirects).toEqual([]);
  });

  it("does not gate a signup still on step 2 (provisional name)", async () => {
    state.profile = { ...OWES, displayName: "ana", tosAcceptedAt: null, tosVersion: null };
    await expect(AuthenticatedLayout({ children: null })).resolves.toBeTruthy();
    expect(state.redirects).toEqual([]);
  });
});
