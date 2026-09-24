// @vitest-environment jsdom
//
// /gob/usuarios — F3+F7 fusion (2026-07-22): this route now only redirects
// into the Directorio hub's "usuarios" register, preserving every query
// param. Regression guard: a bookmarked/shared old-route URL must land on
// the exact same slice of data under /gob/directorio.
//
// The former render-level assertions (OpFilterBar Rol axis, chip-fraud
// OpBreach, ISO-KPI removal) moved to ./UsuariosScreen.test.tsx, which now
// targets the extracted screen component directly — no coverage was lost.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobUsuariosRedirectPage from "./page";

describe("/gob/usuarios — redirects into the Directorio hub (F3+F7 fusion)", () => {
  it("redirects to /gob/directorio?registro=usuarios with no other params", async () => {
    await GobUsuariosRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/directorio?registro=usuarios");
  });

  it("preserves q/test/role and sets registro=usuarios", async () => {
    await GobUsuariosRedirectPage({
      searchParams: Promise.resolve({ q: "juan", test: "1", role: "vet" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/directorio");
    expect(url.searchParams.get("q")).toBe("juan");
    expect(url.searchParams.get("test")).toBe("1");
    expect(url.searchParams.get("role")).toBe("vet");
    expect(url.searchParams.get("registro")).toBe("usuarios");
  });
});
