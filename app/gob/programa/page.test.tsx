// @vitest-environment jsdom
//
// /gob/programa — the Programa hub. F9 fusion (2026-08-01, PO decision on an
// external-QA navigation gate): the hub ABSORBS Analítica as TABBED VISTAS
// (`?vista=resumen|analitica`).
//
// The two embedded vista screens (ProgramaResumenScreen / AnalyticsScreen) are
// heavy server components with their own DB/auth-guard/jurisdiction-scope
// dependencies; each keeps its own suite (./ProgramaResumenScreen.test.tsx and
// the source-level pins in lib/metrics/province-disclosure.test.ts). This test
// stubs them out entirely so it can focus on what the HUB itself owns: the
// header, the vista tab switcher, and — critically — that the default vista is
// "resumen" and that ?vista= actually selects the right embedded screen.
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/app/gob/programa/ProgramaResumenScreen", () => ({
  ProgramaResumenScreen: () => <div data-testid="resumen-stub">RESUMEN VISTA CONTENT</div>,
}));

vi.mock("@/app/gob/analytics/AnalyticsScreen", () => ({
  AnalyticsScreen: () => <div data-testid="analitica-stub">ANALITICA VISTA CONTENT</div>,
}));

import GobProgramaPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return GobProgramaPage({ searchParams: Promise.resolve(query) });
}

describe("/gob/programa — the hub (F9 fusion: Resumen + Analítica as tabbed vistas)", () => {
  it("renders the hub header", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("¿Estamos cumpliendo el programa en tu jurisdicción?");
  });

  it("renders both vista tab labels", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Resumen");
    expect(html).toContain("Analítica");
  });

  it("defaults to the 'resumen' vista when no ?vista= is given", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("RESUMEN VISTA CONTENT");
    expect(html).not.toContain("ANALITICA VISTA CONTENT");
  });

  it("?vista=analitica renders the Analítica vista instead", async () => {
    const node = await renderHub({ vista: "analitica" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("ANALITICA VISTA CONTENT");
    expect(html).not.toContain("RESUMEN VISTA CONTENT");
  });

  it("an unrecognized ?vista= value falls back to the resumen default (never crashes, never shows blank)", async () => {
    const node = await renderHub({ vista: "not-a-real-vista" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("RESUMEN VISTA CONTENT");
  });

  it("does not link out to the old standalone /gob/analytics route from the hub itself", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain('href="/gob/analytics"');
  });
});

// ---------------------------------------------------------------------------
// The F9 CONTENT RULE, pinned.
//
// "Si un número ya está en el resumen, la vista lo linkea, no lo repite" (PO,
// 2026-08-01). This is the rule that made the fold worth doing rather than
// merely tidy: before it, /gob/programa and /gob/analytics both published the
// padrón total over a verified-identical predicate, and the duplication was
// invisible because the two screens were a nav click apart. As tabs of ONE
// screen it is one keystroke apart, and a funcionario reading "Total
// registradas 12.345" then "Mascotas totales 12.345" learns the dashboard
// double-counts. It doesn't — but that is not the impression that survives.
//
// A rendering test cannot see this: both vistas are heavy async server
// components and each tile's value comes from a live fetcher. What IS
// mechanically checkable is the SHARED VOCABULARY — every OpKpi carries a
// `descriptorId` naming its catalog entry, so two vistas publishing the same
// metric necessarily name the same descriptor. Comments are stripped first, so
// a descriptorId merely DISCUSSED in a rationale (this file's own history is
// full of them) never counts as a render.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..", "..");

function renderedDescriptorIds(relPath: string): Set<string> {
  const src = readFileSync(join(REPO_ROOT, relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  return new Set([...src.matchAll(/descriptorId="([a-z0-9_]+)"/g)].map((m) => m[1] as string));
}

describe("F9 content rule — the two vistas never publish the same KPI twice", () => {
  it("Resumen and Analítica share no descriptorId", () => {
    const resumen = renderedDescriptorIds("app/gob/programa/ProgramaResumenScreen.tsx");
    const analitica = renderedDescriptorIds("app/gob/analytics/AnalyticsScreen.tsx");

    // Guard the guard: an empty set on either side would make the assertion
    // below vacuously true (a renamed prop, a moved file, a bad regex).
    expect(resumen.size).toBeGreaterThan(3);
    expect(analitica.size).toBeGreaterThan(1);

    const shared = [...resumen].filter((id) => analitica.has(id));
    expect(shared).toEqual([]);
  });

  it("registry_total_pets is published by Resumen and only by Resumen", () => {
    // The specific duplicate F9 removed, named so a future re-add fails loudly
    // rather than merging into the generic assertion above.
    expect(renderedDescriptorIds("app/gob/programa/ProgramaResumenScreen.tsx")).toContain(
      "registry_total_pets",
    );
    expect(renderedDescriptorIds("app/gob/analytics/AnalyticsScreen.tsx")).not.toContain(
      "registry_total_pets",
    );
  });

  it("Analítica links to the vista that owns the padrón total instead of restating it", () => {
    const src = readFileSync(
      join(REPO_ROOT, "app/gob/analytics/AnalyticsScreen.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toContain('href="/gob/programa?vista=resumen"');
  });
});
