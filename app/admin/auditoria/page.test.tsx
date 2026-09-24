// @vitest-environment jsdom
//
// /admin/auditoria — the Auditoría hub (audit-trail fusion, 2026-08-02: the
// hub ABSORBS /admin/historial as the "Actividad" vista of one screen —
// both admin surfaces queried the same audit_log at the same universal
// admin scope).
//
// The two embedded vista screens (AuditoriaScreen / ActividadScreen) are
// heavy server components with their own DB/auth-guard dependencies — the
// bounded-fetch-group contract (T3.3) is pinned in AuditoriaScreen.test.tsx.
// This test stubs both screens out so it can focus on what the HUB itself
// owns: the streamed-shell contract, the header, the vista tab switcher,
// and — critically — that the default vista is "sensibles" and that
// ?vista= actually selects the right embedded screen.
import "@testing-library/jest-dom/vitest";

import { Suspense, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("./AuditoriaScreen", () => ({
  AuditoriaScreen: () => <div data-testid="sensibles-stub">SENSIBLES VISTA CONTENT</div>,
}));

vi.mock("@/app/admin/historial/ActividadScreen", () => ({
  ActividadScreen: () => <div data-testid="actividad-stub">ACTIVIDAD VISTA CONTENT</div>,
}));

import AdminAuditoriaPage from "./page";

async function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  const el = AdminAuditoriaPage({ searchParams: Promise.resolve(query) });
  // The hub body mounts behind the page's Suspense boundary (T3.3 shell).
  const body = el.props.children;
  return await body.type(body.props);
}

describe("/admin/auditoria — streamed shell (T3.3, preserved through the fusion)", () => {
  it("default export is synchronous and returns a Suspense boundary", () => {
    expect(AdminAuditoriaPage.constructor.name).not.toBe("AsyncFunction");
    const el = AdminAuditoriaPage({ searchParams: Promise.resolve({}) });
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe(Suspense);
  });

  it("the Suspense fallback is the dashboard skeleton (aria-busy)", () => {
    const el = AdminAuditoriaPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(el.props.fallback);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando…");
  });
});

describe("/admin/auditoria — the hub (fusion: historial as the Actividad vista)", () => {
  it("renders the hub header", async () => {
    const html = renderToStaticMarkup(await renderHub());
    expect(html).toContain("¿Quién hizo qué, y necesito investigarlo?");
  });

  it("renders both vista tab labels", async () => {
    const html = renderToStaticMarkup(await renderHub());
    expect(html).toContain("Cambios sensibles");
    expect(html).toContain("Actividad");
  });

  it("defaults to the 'sensibles' vista when no ?vista= is given", async () => {
    const html = renderToStaticMarkup(await renderHub());
    expect(html).toContain("SENSIBLES VISTA CONTENT");
    expect(html).not.toContain("ACTIVIDAD VISTA CONTENT");
  });

  it("?vista=actividad renders the Actividad vista instead", async () => {
    const html = renderToStaticMarkup(await renderHub({ vista: "actividad" }));
    expect(html).toContain("ACTIVIDAD VISTA CONTENT");
    expect(html).not.toContain("SENSIBLES VISTA CONTENT");
  });

  it("an unrecognized ?vista= value falls back to the sensibles default (never crashes, never shows blank)", async () => {
    const html = renderToStaticMarkup(await renderHub({ vista: "not-a-real-vista" }));
    expect(html).toContain("SENSIBLES VISTA CONTENT");
  });

  it("does not link out to the old standalone /admin/historial route from the hub itself", async () => {
    const html = renderToStaticMarkup(await renderHub());
    // Regression guard against reintroducing the pre-fusion link — the hub's
    // own chrome must never point at the (now-redirecting) old route.
    expect(html).not.toContain('href="/admin/historial"');
  });
});
