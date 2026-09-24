// @vitest-environment jsdom
//
// /admin/poblacion — F8 fusion (2026-07-22): this route now only redirects
// into the admin Padrón hub's "poblacion" vista, preserving every query
// param. Regression guard: a bookmarked/shared old-route URL must land on
// the exact same slice of data under /admin/padron — and portal-follows-
// viewer: it must never bounce into /gob/padron.
//
// The former render-level assertions (species axis wiring) moved to
// ./AdminPoblacionScreen.test.tsx, which now targets the extracted screen
// component directly — no coverage was lost.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import AdminPoblacionRedirectPage from "./page";

describe("/admin/poblacion — redirects into the admin Padrón hub (F8 fusion)", () => {
  it("redirects to /admin/padron?vista=poblacion with no other params", async () => {
    await AdminPoblacionRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/admin/padron?vista=poblacion");
  });

  it("preserves period/species and sets vista=poblacion, never bouncing into /gob", async () => {
    await AdminPoblacionRedirectPage({
      searchParams: Promise.resolve({ period: "trailing12m", species: "dog" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/admin/padron");
    expect(url.searchParams.get("period")).toBe("trailing12m");
    expect(url.searchParams.get("species")).toBe("dog");
    expect(url.searchParams.get("vista")).toBe("poblacion");
  });
});
