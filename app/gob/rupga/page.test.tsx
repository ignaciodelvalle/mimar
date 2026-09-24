// @vitest-environment jsdom
//
// /gob/rupga — F3+F7 fusion (2026-07-22): this route now only redirects into
// the Directorio hub's "credenciales" register, preserving every query
// param. Regression guard: a bookmarked/shared old-route URL must land on
// the exact same slice of data under /gob/directorio.
//
// The former render-level assertions (OpFilterBar Buscar, Estado tabs,
// credential rendering) moved to ./CredencialesScreen.test.tsx, which now
// targets the extracted screen component directly — no coverage was lost.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobRupgaRedirectPage from "./page";

describe("/gob/rupga — redirects into the Directorio hub (F3+F7 fusion)", () => {
  it("redirects to /gob/directorio?registro=credenciales with no other params", async () => {
    await GobRupgaRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/directorio?registro=credenciales");
  });

  it("preserves q/status and sets registro=credenciales", async () => {
    await GobRupgaRedirectPage({
      searchParams: Promise.resolve({ q: "duque", status: "vigente" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/directorio");
    expect(url.searchParams.get("q")).toBe("duque");
    expect(url.searchParams.get("status")).toBe("vigente");
    expect(url.searchParams.get("registro")).toBe("credenciales");
  });
});
