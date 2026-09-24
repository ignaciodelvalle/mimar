// @vitest-environment jsdom
//
// /gob/casos — the Casos hub. F6 fusion (2026-07-22, PO-approved route
// unification: the "expediente" family, same legal-administrative operator,
// identical case-file grammar of open/parties/resolve): the hub ABSORBS
// Disputas as a TABBED EXPEDIENTE (`?expediente=casos|disputas`) of one
// screen.
//
// The two embedded expediente screens (CasosScreen / DisputasScreen) are
// heavy server components with their own DB/auth-guard/jurisdiction-scope
// dependencies — their own bodies are unit-tested separately (CasosScreen.
// test.tsx, relocated verbatim from the former page-level test; Disputas
// never had one, unchanged by this fusion). This test stubs them out
// entirely so it can focus on what the HUB itself owns: the header, the
// expediente tab switcher, and — critically — that the default expediente is
// "casos" and that ?expediente= actually selects the right embedded screen.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("./CasosScreen", () => ({
  CasosScreen: () => <div data-testid="casos-stub">CASOS EXPEDIENTE CONTENT</div>,
}));

vi.mock("@/app/gob/disputas/DisputasScreen", () => ({
  DisputasScreen: () => <div data-testid="disputas-stub">DISPUTAS EXPEDIENTE CONTENT</div>,
}));

import GobCasosPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return GobCasosPage({ searchParams: Promise.resolve(query) });
}

describe("/gob/casos — the hub (F6 fusion: Disputas as a tabbed expediente)", () => {
  it("renders the hub header", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("¿Qué expediente necesita mi próxima acción?");
  });

  it("renders both expediente tab labels", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Casos");
    expect(html).toContain("Disputas");
  });

  it("defaults to the 'casos' expediente when no ?expediente= is given", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("CASOS EXPEDIENTE CONTENT");
    expect(html).not.toContain("DISPUTAS EXPEDIENTE CONTENT");
  });

  it("?expediente=disputas renders the Disputas expediente instead", async () => {
    const node = await renderHub({ expediente: "disputas" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("DISPUTAS EXPEDIENTE CONTENT");
    expect(html).not.toContain("CASOS EXPEDIENTE CONTENT");
  });

  it("an unrecognized ?expediente= value falls back to the casos default (never crashes, never shows blank)", async () => {
    const node = await renderHub({ expediente: "not-a-real-expediente" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("CASOS EXPEDIENTE CONTENT");
  });

  it("does not link out to the old standalone /gob/disputas route from the hub itself", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    // Regression guard against reintroducing the pre-fusion link — the hub's
    // own chrome must never point at the (now-redirecting) old route.
    expect(html).not.toContain('href="/gob/disputas"');
  });
});
