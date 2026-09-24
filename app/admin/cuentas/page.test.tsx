// @vitest-environment jsdom
//
// /admin/cuentas — the Cuentas privilegiadas hub (privileged-accounts
// fusion, 2026-08-02: the hub ABSORBS /admin/govts + /admin/admins as
// tabbed registers `?registro=govts|admins` of one screen, mirroring the F3
// Directorio hub shape).
//
// The two embedded register screens (GovtsScreen / AdminsScreen) are heavy
// server components with their own DB/auth-guard/supabase-admin dependencies
// — this test stubs them out entirely so it can focus on what the HUB itself
// owns: the header, the register tab switcher, and — critically — that the
// default register is "govts" and that ?registro= actually selects the
// right embedded screen (the two panels are DISTINCT rosters, never a
// merged query, so rendering the wrong one is a real defect).
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/app/admin/govts/GovtsScreen", () => ({
  GovtsScreen: () => <div data-testid="govts-stub">GOVTS REGISTER CONTENT</div>,
}));

vi.mock("@/app/admin/admins/AdminsScreen", () => ({
  AdminsScreen: () => <div data-testid="admins-stub">ADMINS REGISTER CONTENT</div>,
}));

import CuentasPage from "./page";

async function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return CuentasPage({ searchParams: Promise.resolve(query) });
}

describe("/admin/cuentas — the hub (fusion: govts + admins as tabbed registers)", () => {
  it("renders the hub header", async () => {
    const html = renderToStaticMarkup(await renderHub());
    expect(html).toContain("¿Quién puede operar con privilegios, y con qué alcance?");
  });

  it("renders both register tab labels", async () => {
    const html = renderToStaticMarkup(await renderHub());
    expect(html).toContain("Cuentas gobierno");
    expect(html).toContain("Administradores");
  });

  it("defaults to the 'govts' register when no ?registro= is given", async () => {
    const html = renderToStaticMarkup(await renderHub());
    expect(html).toContain("GOVTS REGISTER CONTENT");
    expect(html).not.toContain("ADMINS REGISTER CONTENT");
  });

  it("?registro=admins renders the Administradores register instead", async () => {
    const html = renderToStaticMarkup(await renderHub({ registro: "admins" }));
    expect(html).toContain("ADMINS REGISTER CONTENT");
    expect(html).not.toContain("GOVTS REGISTER CONTENT");
  });

  it("an unrecognized ?registro= value falls back to the govts default (never crashes, never shows blank)", async () => {
    const html = renderToStaticMarkup(await renderHub({ registro: "not-a-register" }));
    expect(html).toContain("GOVTS REGISTER CONTENT");
  });

  it("does not link out to the old standalone routes from the hub's own chrome", async () => {
    const html = renderToStaticMarkup(await renderHub());
    // Regression guard against reintroducing the pre-fusion links. The
    // register SCREENS may still link to their nested detail/form routes
    // (/admin/govts/new etc. — unchanged), but the hub chrome must not point
    // at the (now-redirecting) old list routes.
    expect(html).not.toContain('href="/admin/govts"');
    expect(html).not.toContain('href="/admin/admins"');
  });
});
