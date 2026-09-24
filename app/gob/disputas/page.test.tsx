// @vitest-environment jsdom
//
// /gob/disputas — F6 fusion (2026-07-22): this route now only redirects into
// the Casos hub's "disputas" expediente, preserving every query param.
// Regression guard: a bookmarked/shared old-route URL must land on the exact
// same slice of data under /gob/casos.
//
// The former render-level assertions (custody-dispute queue rendering) moved
// to ./DisputasScreen.tsx (no dedicated test existed before this fusion — the
// page-level render coverage is now in ../casos/page.test.tsx's "?expediente=
// disputas renders the Disputas expediente" case, no coverage was lost).

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobDisputasRedirectPage from "./page";

describe("/gob/disputas — redirects into the Casos hub (F6 fusion)", () => {
  it("redirects to /gob/casos?expediente=disputas with no other params", async () => {
    await GobDisputasRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/casos?expediente=disputas");
  });

  it("preserves the status param and sets expediente=disputas", async () => {
    await GobDisputasRedirectPage({
      searchParams: Promise.resolve({ status: "closed" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/casos");
    expect(url.searchParams.get("status")).toBe("closed");
    expect(url.searchParams.get("expediente")).toBe("disputas");
  });
});
