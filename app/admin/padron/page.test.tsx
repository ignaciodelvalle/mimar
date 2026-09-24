// @vitest-environment jsdom
//
// /admin/padron — the admin Padrón hub. F8 fusion (2026-07-22): admin's OWN
// hub (NOT a thin re-export — see app/admin/padron/page.tsx's header comment
// for why) rendering AdminPoblacionScreen / AdminCensoScreen as tabbed vistas
// (`?vista=poblacion|censo`).
//
// The two embedded vista screens are heavy server components with their own
// DB/auth-guard dependencies — stubbed out entirely so this test can focus
// on what the HUB itself owns: the header, the vista tab switcher, and the
// default/selection behavior.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/app/admin/poblacion/AdminPoblacionScreen", () => ({
  AdminPoblacionScreen: () => (
    <div data-testid="admin-poblacion-stub">ADMIN POBLACION VISTA CONTENT</div>
  ),
}));

vi.mock("@/app/admin/censo/AdminCensoScreen", () => ({
  AdminCensoScreen: () => <div data-testid="admin-censo-stub">ADMIN CENSO VISTA CONTENT</div>,
}));

import AdminPadronPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return AdminPadronPage({ searchParams: Promise.resolve(query) });
}

describe("/admin/padron — the admin hub (F8 fusion: own hub, not a thin re-export)", () => {
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
    expect(html).toContain("ADMIN POBLACION VISTA CONTENT");
    expect(html).not.toContain("ADMIN CENSO VISTA CONTENT");
  });

  it("?vista=censo renders the admin Censo vista instead", async () => {
    const node = await renderHub({ vista: "censo" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("ADMIN CENSO VISTA CONTENT");
    expect(html).not.toContain("ADMIN POBLACION VISTA CONTENT");
  });

  it("does not link out to the old standalone /admin/poblacion or /admin/censo routes", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain('href="/admin/poblacion"');
    expect(html).not.toContain('href="/admin/censo"');
  });
});
