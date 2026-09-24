// Unit tests for portalBase() (portal-follows-viewer, 2026-07-02) — the
// server util the shared work surfaces (cola/usuarios/organizaciones/reglas/
// servicios) use to read the `x-portal-base` header the middleware stamps on
// every request, so their internal links stay inside whichever portal
// (/admin or /gob) the viewer is browsing.

import { describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

const { portalBase } = await import("./portal-base");

function headersWith(value: string | null) {
  return {
    get: (name: string) => (name === "x-portal-base" ? value : null),
  };
}

describe("portalBase", () => {
  it('returns "/admin" when the header is exactly "/admin"', async () => {
    headersMock.mockResolvedValue(headersWith("/admin"));
    expect(await portalBase()).toBe("/admin");
  });

  it('returns "/gob" when the header is exactly "/gob"', async () => {
    headersMock.mockResolvedValue(headersWith("/gob"));
    expect(await portalBase()).toBe("/gob");
  });

  it('defaults to "/gob" when the header is absent (null)', async () => {
    headersMock.mockResolvedValue(headersWith(null));
    expect(await portalBase()).toBe("/gob");
  });

  it('defaults to "/gob" on an unexpected header value — never throws', async () => {
    headersMock.mockResolvedValue(headersWith("/org"));
    expect(await portalBase()).toBe("/gob");
  });
});
