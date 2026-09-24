// @vitest-environment jsdom
//
// /admin/organizaciones — F3+F7 fusion (2026-07-22): this route now
// redirects into the ADMIN Directorio hub's "organizaciones" register
// (portal-follows-viewer: never bounces into /gob/directorio), preserving
// every query param. Previously a thin re-export of the /gob page; that
// wrapper is gone now that /gob/organizaciones is itself a redirect.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import AdminOrganizacionesRedirectPage from "./page";

describe("/admin/organizaciones — redirects into the admin Directorio hub, never gob (F3+F7 fusion)", () => {
  it("redirects to /admin/directorio?registro=organizaciones with no other params", async () => {
    await AdminOrganizacionesRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/admin/directorio?registro=organizaciones");
  });

  it("preserves q/verified/orgType, sets registro=organizaciones, and stays under /admin", async () => {
    await AdminOrganizacionesRedirectPage({
      searchParams: Promise.resolve({ q: "sur", verified: "verified", orgType: "shelter" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/admin/directorio");
    expect(url.searchParams.get("q")).toBe("sur");
    expect(url.searchParams.get("verified")).toBe("verified");
    expect(url.searchParams.get("orgType")).toBe("shelter");
    expect(url.searchParams.get("registro")).toBe("organizaciones");
  });
});
