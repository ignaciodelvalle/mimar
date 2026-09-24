// @vitest-environment jsdom
//
// /gob/servicios — F3+F7 fusion (2026-07-22): this route now only redirects
// into the Directorio hub's "servicios" register, preserving every query
// param. Regression guard: a bookmarked/shared old-route URL must land on
// the exact same slice of data under /gob/directorio.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobServiciosRedirectPage from "./page";

describe("/gob/servicios — redirects into the Directorio hub (F3+F7 fusion)", () => {
  it("redirects to /gob/directorio?registro=servicios with no other params", async () => {
    await GobServiciosRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/directorio?registro=servicios");
  });

  it("preserves the status filter and sets registro=servicios", async () => {
    await GobServiciosRedirectPage({
      searchParams: Promise.resolve({ status: "approved" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/directorio");
    expect(url.searchParams.get("status")).toBe("approved");
    expect(url.searchParams.get("registro")).toBe("servicios");
  });
});
