// @vitest-environment jsdom
//
// /gob/operativos — the Operativos hub. F2 fusion (2026-07-22, PO-approved
// route unification): the hub ABSORBS Campañas + Alcance comunitario as
// TABBED VIEWS (`?vista=campanas|alcance`) of one screen.
//
// The two embedded view screens (CampanasScreen / AlcanceScreen) are heavy
// server components with their own DB/auth-guard/jurisdiction-scope
// dependencies — this test stubs them out entirely so the hub test can focus
// on what the HUB itself owns: the header, the vista tab switcher, and —
// critically — that the default vista is "alcance" and that ?vista= actually
// selects the right embedded screen.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/app/gob/campanas/CampanasScreen", () => ({
  CampanasScreen: () => <div data-testid="campanas-stub">CAMPANAS TAB CONTENT</div>,
}));

vi.mock("@/app/gob/outreach/AlcanceScreen", () => ({
  AlcanceScreen: () => <div data-testid="alcance-stub">ALCANCE TAB CONTENT</div>,
}));

import GobOperativosPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return GobOperativosPage({ searchParams: Promise.resolve(query) });
}

describe("/gob/operativos — the hub (F2 fusion: Campañas + Alcance comunitario as tabbed views)", () => {
  it("renders the header explainer", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("¿Dónde y cómo intervengo esta semana?");
  });

  it("renders both vista tab labels", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Alcance comunitario");
    expect(html).toContain("Campañas");
  });

  it("defaults to the 'alcance' vista when no ?vista= is given (the action pipeline, not the conversion readout)", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("ALCANCE TAB CONTENT");
    expect(html).not.toContain("CAMPANAS TAB CONTENT");
  });

  it("?vista=campanas renders the Campañas view instead", async () => {
    const node = await renderHub({ vista: "campanas" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("CAMPANAS TAB CONTENT");
    expect(html).not.toContain("ALCANCE TAB CONTENT");
  });

  it("an unrecognized ?vista= value falls back to the alcance default (never crashes, never shows blank)", async () => {
    const node = await renderHub({ vista: "not-a-real-vista" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("ALCANCE TAB CONTENT");
  });

  it("does not link out to the old standalone /gob/campanas or /gob/outreach routes from the hub itself", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain('href="/gob/campanas"');
    expect(html).not.toContain('href="/gob/outreach"');
  });
});
