// @vitest-environment jsdom
//
// /gob/padron — the Padrón hub. F8 fusion (2026-07-22, PO-approved route
// unification: both are registry-derived Programa surfaces the registry
// manager reads together): the hub ABSORBS Población + Censo as TABBED
// VISTAS (`?vista=poblacion|censo`) of one screen.
//
// The two embedded vista screens (PoblacionScreen / CensoScreen) are heavy
// server components with their own DB/auth-guard/jurisdiction-scope
// dependencies — their own bodies are unit-tested nowhere at the full-page
// level, same as before this fusion (neither /gob/poblacion nor /gob/censo
// ever had a page-level test). This test stubs them out entirely so it can
// focus on what the HUB itself owns: the header, the vista tab switcher, and
// — critically — that the default vista is "poblacion" and that ?vista=
// actually selects the right embedded screen.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/app/gob/poblacion/PoblacionScreen", () => ({
  PoblacionScreen: () => <div data-testid="poblacion-stub">POBLACION VISTA CONTENT</div>,
}));

vi.mock("@/app/gob/censo/CensoScreen", () => ({
  CensoScreen: () => <div data-testid="censo-stub">CENSO VISTA CONTENT</div>,
}));

import GobPadronPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return GobPadronPage({ searchParams: Promise.resolve(query) });
}

describe("/gob/padron — the hub (F8 fusion: Población + Censo as tabbed vistas)", () => {
  it("renders the hub header", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("¿Crece sano el padrón y contenemos la población?");
  });

  it("renders both vista tab labels", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Población");
    expect(html).toContain("Censo");
  });

  it("defaults to the 'poblacion' vista when no ?vista= is given", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("POBLACION VISTA CONTENT");
    expect(html).not.toContain("CENSO VISTA CONTENT");
  });

  it("?vista=censo renders the Censo vista instead", async () => {
    const node = await renderHub({ vista: "censo" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("CENSO VISTA CONTENT");
    expect(html).not.toContain("POBLACION VISTA CONTENT");
  });

  it("an unrecognized ?vista= value falls back to the poblacion default (never crashes, never shows blank)", async () => {
    const node = await renderHub({ vista: "not-a-real-vista" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("POBLACION VISTA CONTENT");
  });

  it("does not link out to the old standalone /gob/poblacion or /gob/censo routes from the hub itself", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain('href="/gob/poblacion"');
    expect(html).not.toContain('href="/gob/censo"');
  });
});
