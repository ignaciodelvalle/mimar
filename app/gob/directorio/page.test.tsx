// @vitest-environment jsdom
//
// /gob/directorio — the Directorio hub. F3+F7 fusion (2026-07-22, PO-approved
// route unification): the hub ABSORBS Organizaciones + Usuarios + Servicios +
// RUPGA credentials as TABBED REGISTERS
// (`?registro=organizaciones|usuarios|servicios|credenciales`) of one screen.
//
// The four embedded register screens are heavy server components with their
// own DB/auth-guard/jurisdiction-scope dependencies — this test stubs them
// out entirely so the hub test can focus on what the HUB itself owns: the
// header, the registro tab switcher, and — critically — that the default
// register is "organizaciones" and that ?registro= actually selects the
// right embedded screen.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/app/gob/organizaciones/OrganizacionesScreen", () => ({
  OrganizacionesScreen: () => (
    <div data-testid="organizaciones-stub">ORGANIZACIONES REGISTER CONTENT</div>
  ),
}));

vi.mock("@/app/gob/usuarios/UsuariosScreen", () => ({
  UsuariosScreen: () => <div data-testid="usuarios-stub">USUARIOS REGISTER CONTENT</div>,
}));

vi.mock("@/app/gob/servicios/ServiciosScreen", () => ({
  ServiciosScreen: () => <div data-testid="servicios-stub">SERVICIOS REGISTER CONTENT</div>,
}));

vi.mock("@/app/gob/rupga/CredencialesScreen", () => ({
  CredencialesScreen: () => (
    <div data-testid="credenciales-stub">CREDENCIALES REGISTER CONTENT</div>
  ),
}));

import GobDirectorioPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return GobDirectorioPage({ searchParams: Promise.resolve(query) });
}

describe("/gob/directorio — the hub (F3+F7 fusion: Organizaciones + Usuarios + Servicios + Credenciales as tabbed registers)", () => {
  it("renders the header explainer", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("¿Esta entidad es legítima y está bien registrada?");
  });

  it("renders all four registro tab labels", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Organizaciones");
    expect(html).toContain("Usuarios");
    expect(html).toContain("Servicios");
    expect(html).toContain("Credenciales");
  });

  it("defaults to the 'organizaciones' register when no ?registro= is given (highest daily traffic)", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("ORGANIZACIONES REGISTER CONTENT");
    expect(html).not.toContain("USUARIOS REGISTER CONTENT");
    expect(html).not.toContain("SERVICIOS REGISTER CONTENT");
    expect(html).not.toContain("CREDENCIALES REGISTER CONTENT");
  });

  it("?registro=usuarios renders the Usuarios register instead", async () => {
    const node = await renderHub({ registro: "usuarios" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("USUARIOS REGISTER CONTENT");
    expect(html).not.toContain("ORGANIZACIONES REGISTER CONTENT");
  });

  it("?registro=servicios renders the Servicios register instead", async () => {
    const node = await renderHub({ registro: "servicios" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("SERVICIOS REGISTER CONTENT");
  });

  it("?registro=credenciales renders the Credenciales register instead", async () => {
    const node = await renderHub({ registro: "credenciales" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("CREDENCIALES REGISTER CONTENT");
  });

  it("an unrecognized ?registro= value falls back to the organizaciones default (never crashes, never shows blank)", async () => {
    const node = await renderHub({ registro: "not-a-real-registro" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("ORGANIZACIONES REGISTER CONTENT");
  });

  it("does not link out to the old standalone routes from the hub itself", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain('href="/gob/organizaciones"');
    expect(html).not.toContain('href="/gob/usuarios"');
    expect(html).not.toContain('href="/gob/servicios"');
    expect(html).not.toContain('href="/gob/rupga"');
  });
});
