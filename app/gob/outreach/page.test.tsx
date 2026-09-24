// @vitest-environment jsdom
//
// /gob/outreach — F2 fusion (2026-07-22): this route now only redirects into
// the Operativos hub's "alcance" tab, preserving every query param.
// Regression guard: a bookmarked/shared old-route URL must land on the exact
// same slice of data under /gob/operativos.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobOutreachRedirectPage from "./page";

describe("/gob/outreach — redirects into the Operativos hub (F2 fusion)", () => {
  it("redirects to /gob/operativos?vista=alcance with no other params", async () => {
    await GobOutreachRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/operativos?vista=alcance");
  });

  it("preserves arbitrary forwarded params and sets vista=alcance", async () => {
    await GobOutreachRedirectPage({
      searchParams: Promise.resolve({ foo: "bar" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/operativos");
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("vista")).toBe("alcance");
  });
});
