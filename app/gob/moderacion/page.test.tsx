// @vitest-environment jsdom
//
// /gob/moderacion — F1 fusion (2026-07-22): this route now only redirects
// into the Denuncias hub's "moderacion" stage, preserving every query param.
// Regression guard: a bookmarked/shared old-route URL must land on the exact
// same slice of data under /gob/denuncias.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobModeracionRedirectPage from "./page";

describe("/gob/moderacion — redirects into the Denuncias hub (F1 fusion)", () => {
  it("redirects to /gob/denuncias?etapa=moderacion with no other params", async () => {
    await GobModeracionRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/denuncias?etapa=moderacion");
  });

  it("preserves status/kind/severity/cursor and sets etapa=moderacion", async () => {
    await GobModeracionRedirectPage({
      searchParams: Promise.resolve({
        status: "resolved",
        kind: "abandono",
        severity: "high",
        cursor: "abc123",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/denuncias");
    expect(url.searchParams.get("status")).toBe("resolved");
    expect(url.searchParams.get("kind")).toBe("abandono");
    expect(url.searchParams.get("severity")).toBe("high");
    expect(url.searchParams.get("cursor")).toBe("abc123");
    expect(url.searchParams.get("etapa")).toBe("moderacion");
  });
});
