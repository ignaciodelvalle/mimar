// @vitest-environment jsdom
//
// /gob/organizaciones — F3+F7 fusion (2026-07-22): this route now only
// redirects into the Directorio hub's "organizaciones" register, preserving
// every query param. Regression guard: a bookmarked/shared old-route URL
// must land on the exact same slice of data under /gob/directorio.
//
// The former render-level assertions (OpFilterBar axes, search result
// rendering) moved to ./OrganizacionesScreen.test.tsx, which now targets the
// extracted screen component directly — no coverage was lost.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobOrganizacionesRedirectPage from "./page";

describe("/gob/organizaciones — redirects into the Directorio hub (F3+F7 fusion)", () => {
  it("redirects to /gob/directorio?registro=organizaciones with no other params", async () => {
    await GobOrganizacionesRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/directorio?registro=organizaciones");
  });

  it("preserves q/verified/orgType and sets registro=organizaciones", async () => {
    await GobOrganizacionesRedirectPage({
      searchParams: Promise.resolve({ q: "sur", verified: "verified", orgType: "shelter" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/directorio");
    expect(url.searchParams.get("q")).toBe("sur");
    expect(url.searchParams.get("verified")).toBe("verified");
    expect(url.searchParams.get("orgType")).toBe("shelter");
    expect(url.searchParams.get("registro")).toBe("organizaciones");
  });
});
