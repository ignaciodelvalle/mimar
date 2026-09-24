// loadOrgShellAccess — the org layout's three shell reads under one deadline
// (T1-L18). Each case states its expected values independently: a session
// object, a display name and a capability set built here, never derived from
// the module's own constants.

import { notFound } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

import { loadOrgShellAccess } from "./org-shell-access";

vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn() }));

type Session = { user: { id: string }; membership: { id: string; role: string } };

const SESSION: Session = { user: { id: "u-1" }, membership: { id: "m-1", role: "member" } };

const never = <T>() => new Promise<T>(() => {});
const resolveAfter = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("loadOrgShellAccess", () => {
  it("returns the session, the name and the capabilities when all three answer", async () => {
    const load = await loadOrgShellAccess<Session, string>(
      "DIM-ORG1",
      {
        requireAccess: async () => SESSION,
        getProfile: async () => ({ displayName: "Refugio Norte" }),
        getGranted: async () => new Set(["pet.read_held"]),
      },
      1_000,
    );

    expect(load).toEqual({
      ok: true,
      value: {
        session: SESSION,
        displayName: "Refugio Norte",
        granted: new Set(["pet.read_held"]),
        navDegraded: false,
      },
    });
  });

  it("passes the org token to the membership check and the session to the capabilities read", async () => {
    const requireAccess = vi.fn(async () => SESSION);
    const getProfile = vi.fn(async () => null);
    const getGranted = vi.fn(async () => new Set<string>());

    await loadOrgShellAccess("DIM-ORG1", { requireAccess, getProfile, getGranted }, 1_000);

    expect(requireAccess).toHaveBeenCalledWith("DIM-ORG1");
    expect(getProfile).toHaveBeenCalledWith("u-1");
    expect(getGranted).toHaveBeenCalledWith(SESSION);
  });

  // The defect: a hung membership read used to hang the whole portal.
  it("degrades — instead of hanging — when the membership check never answers", async () => {
    const load = await loadOrgShellAccess<Session, string>(
      "DIM-ORG1",
      {
        requireAccess: () => never<Session>(),
        getProfile: async () => ({ displayName: "x" }),
        getGranted: async () => new Set<string>(),
      },
      20,
    );

    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.reason).toBe("timeout");
  });

  // A non-member must still get the branded 404, not a degraded panel: the
  // deadline may not swallow Next's control flow.
  it("lets notFound() from the membership check through", async () => {
    await expect(
      loadOrgShellAccess<Session, string>(
        "DIM-ORG1",
        {
          requireAccess: async () => notFound(),
          getProfile: async () => null,
          getGranted: async () => new Set<string>(),
        },
        1_000,
      ),
    ).rejects.toThrow();
  });

  it("keeps the portal and hides the gated nav when the capabilities read hangs", async () => {
    const load = await loadOrgShellAccess<Session, string>(
      "DIM-ORG1",
      {
        requireAccess: async () => SESSION,
        getProfile: async () => ({ displayName: "Refugio Norte" }),
        getGranted: () => never<Set<string>>(),
      },
      20,
    );

    expect(load).toEqual({
      ok: true,
      value: { session: SESSION, displayName: "", granted: new Set(), navDegraded: true },
    });
  });

  // ONE budget, not one per read. The clock says the membership check already
  // spent the whole budget, so the profile read — which would answer in 5 ms —
  // gets nothing left and the nav degrades. A fresh budget per read would let
  // it through, and three sequential reads could then take three budgets.
  it("gives the second group only what is left of the same budget", async () => {
    const ticks = [0, 1_000];
    const load = await loadOrgShellAccess<Session, string>(
      "DIM-ORG1",
      {
        requireAccess: async () => SESSION,
        getProfile: () => resolveAfter(5, { displayName: "Refugio Norte" }),
        getGranted: () => resolveAfter(5, new Set(["pet.read_held"])),
        now: () => ticks.shift() ?? 1_000,
      },
      1_000,
    );

    expect(load.ok && load.value.navDegraded).toBe(true);
  });
});
