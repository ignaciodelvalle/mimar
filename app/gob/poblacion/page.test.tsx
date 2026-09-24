// @vitest-environment jsdom
//
// /gob/poblacion — F8 fusion (2026-07-22): this route now only redirects
// into the Padrón hub's "poblacion" vista, preserving every query param.
// Regression guard: a bookmarked/shared old-route URL must land on the exact
// same slice of data under /gob/padron.
//
// The former render-level assertions moved to ./PoblacionScreen.tsx (no
// dedicated test existed before this fusion — the page-level render
// coverage is now in ../padron/page.test.tsx, no coverage was lost).

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobPoblacionRedirectPage from "./page";

describe("/gob/poblacion — redirects into the Padrón hub (F8 fusion)", () => {
  it("redirects to /gob/padron?vista=poblacion with no other params", async () => {
    await GobPoblacionRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/padron?vista=poblacion");
  });

  it("preserves period/province/locality/species and sets vista=poblacion", async () => {
    await GobPoblacionRedirectPage({
      searchParams: Promise.resolve({
        period: "trailing12m",
        province: "Santa Fe",
        locality: "Rosario",
        species: "dog",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/padron");
    expect(url.searchParams.get("period")).toBe("trailing12m");
    expect(url.searchParams.get("province")).toBe("Santa Fe");
    expect(url.searchParams.get("locality")).toBe("Rosario");
    expect(url.searchParams.get("species")).toBe("dog");
    expect(url.searchParams.get("vista")).toBe("poblacion");
  });
});
