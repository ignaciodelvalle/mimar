// @vitest-environment jsdom
//
// /admin/servicios — F3+F7 fusion (2026-07-22): this route now redirects
// into the ADMIN Directorio hub's "servicios" register (portal-follows-
// viewer: never bounces into /gob/directorio), preserving every query
// param. Previously a thin re-export of the /gob page; that wrapper is gone
// now that /gob/servicios is itself a redirect.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import AdminServiciosRedirectPage from "./page";

describe("/admin/servicios — redirects into the admin Directorio hub, never gob (F3+F7 fusion)", () => {
  it("redirects to /admin/directorio?registro=servicios with no other params", async () => {
    await AdminServiciosRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/admin/directorio?registro=servicios");
  });

  it("preserves the status filter, sets registro=servicios, and stays under /admin", async () => {
    await AdminServiciosRedirectPage({
      searchParams: Promise.resolve({ status: "approved" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/admin/directorio");
    expect(url.searchParams.get("status")).toBe("approved");
    expect(url.searchParams.get("registro")).toBe("servicios");
  });
});
