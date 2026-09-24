// @vitest-environment jsdom
//
// /admin/usuarios — F3+F7 fusion (2026-07-22): this route now redirects into
// the ADMIN Directorio hub's "usuarios" register (portal-follows-viewer:
// never bounces into /gob/directorio), preserving every query param.
// Previously a thin re-export of the /gob page; that wrapper is gone now
// that /gob/usuarios is itself a redirect.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import AdminUsuariosRedirectPage from "./page";

describe("/admin/usuarios — redirects into the admin Directorio hub, never gob (F3+F7 fusion)", () => {
  it("redirects to /admin/directorio?registro=usuarios with no other params", async () => {
    await AdminUsuariosRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/admin/directorio?registro=usuarios");
  });

  it("preserves q/test/role, sets registro=usuarios, and stays under /admin", async () => {
    await AdminUsuariosRedirectPage({
      searchParams: Promise.resolve({ q: "juan", test: "1", role: "vet" }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/admin/directorio");
    expect(url.searchParams.get("q")).toBe("juan");
    expect(url.searchParams.get("test")).toBe("1");
    expect(url.searchParams.get("role")).toBe("vet");
    expect(url.searchParams.get("registro")).toBe("usuarios");
  });
});
