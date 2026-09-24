// @vitest-environment jsdom
//
// Inline-close convergence (2026-08-02): the /admin/observaciones list hosts
// the professional close form in a slide-over inspector (?cerrar=<token>,
// shallow history) instead of forcing a full navigation to the
// [publicToken] detail route — which stays as the deep-link fallback.
//
// Covers:
//   1. observation-inspector-nav — push-vs-replace-vs-close history
//      semantics (the maltrato inspector-nav contract, minus the pet drill).
//   2. ObservationCloseInspector — renders nothing without ?cerrar=; renders
//      the summary + CloseObservationForm for a known in-progress token
//      (with the full-page escape hatch); renders the honest fallback (link
//      to the detail route) for an unknown token.
//   3. ObservationCloseTrigger — keeps the real detail href (deep-link
//      fallback for modifier clicks / no-JS).
//
// These tests fail against the old code: there was no inspector at all —
// the row action was a plain <Link> to the detail page.

import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  usePathname: () => "/admin/observaciones",
}));

import { ObservationCloseInspector, type ObservationCloseRow } from "../ObservationCloseInspector";
import { ObservationCloseTrigger } from "../ObservationCloseTrigger";
import {
  __resetObservationInspectorNavForTests,
  closeObservationInspector,
  selectObservacion,
  syncDepthAfterPop,
} from "../observation-inspector-nav";

const ROW: ObservationCloseRow = {
  publicToken: "DIM-AAAA-BBBB",
  petName: "Firulais",
  speciesLabel: "Perro",
  locality: "La Plata",
  province: "Buenos Aires",
  ownerName: "Ana Pérez",
  startedLabel: "hace 3 días",
  deadlineLabel: "12/08/2026",
  closeAction: async () => ({ error: null }),
};

function renderInspector(query: Record<string, string>, rows: ObservationCloseRow[] = [ROW]) {
  mockSearch = new URLSearchParams(query);
  return renderToStaticMarkup(<ObservationCloseInspector rows={rows} />);
}

describe("ObservationCloseInspector — selection-driven slide-over", () => {
  it("renders nothing when the URL carries no ?cerrar=", () => {
    expect(renderInspector({})).toBe("");
  });

  it("renders the close form inline for a known in-progress token", () => {
    const html = renderInspector({ cerrar: "DIM-AAAA-BBBB" });
    // Panel identity + the row summary the list card already showed.
    expect(html).toContain("Cierre profesional — Firulais");
    expect(html).toContain("Perro");
    expect(html).toContain("La Plata");
    expect(html).toContain("Ana Pérez");
    expect(html).toContain("hace 3 días");
    expect(html).toContain("12/08/2026");
    // The actual CloseObservationForm (outcome select + submit).
    expect(html).toContain("Elegí un resultado");
    expect(html).toContain("Cerrar observación");
  });

  it("keeps the detail route as the full-page escape hatch", () => {
    const html = renderInspector({ cerrar: "DIM-AAAA-BBBB" });
    expect(html).toContain('href="/admin/observaciones/DIM-AAAA-BBBB"');
    expect(html).toContain("Abrir en página completa");
  });

  it("renders the honest fallback (detail-route link, no form) for an unknown token", () => {
    const html = renderInspector({ cerrar: "DIM-XXXX-YYYY" });
    expect(html).toContain("no está en curso en la vista actual");
    expect(html).toContain('href="/admin/observaciones/DIM-XXXX-YYYY"');
    expect(html).not.toContain("Elegí un resultado");
  });
});

describe("ObservationCloseTrigger — deep-link fallback preserved", () => {
  it("is a real anchor to the detail route (modifier clicks / no-JS land on the full page)", () => {
    mockSearch = new URLSearchParams();
    const html = renderToStaticMarkup(<ObservationCloseTrigger publicToken="DIM-AAAA-BBBB" />);
    expect(html).toContain('href="/admin/observaciones/DIM-AAAA-BBBB"');
    expect(html).toContain("Cerrar profesionalmente →");
    expect(html).toContain('data-observacion-row="DIM-AAAA-BBBB"');
  });
});

describe("observation-inspector-nav — shallow-history semantics", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let goSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetObservationInspectorNavForTests();
    pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("FIRST selection (no ?cerrar yet) pushes one history entry", () => {
    selectObservacion("/admin/observaciones?cerrar=abc", false);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(null, "", "/admin/observaciones?cerrar=abc");
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("SUBSEQUENT selection (browsing) replaces in place — no history growth", () => {
    selectObservacion("/admin/observaciones?cerrar=abc", false);
    selectObservacion("/admin/observaciones?cerrar=def", true);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/admin/observaciones?cerrar=def");
  });

  it("close after a single open Back-closes with go(-1)", () => {
    selectObservacion("/admin/observaciones?cerrar=abc", false);
    closeObservationInspector("/admin/observaciones");
    expect(goSpy).toHaveBeenCalledWith(-1);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("close on a deep-loaded ?cerrar= (nothing pushed) strips in place", () => {
    closeObservationInspector("/admin/observaciones?status=in_progress");
    expect(goSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/admin/observaciones?status=in_progress");
  });

  it("a browser Back that removed ?cerrar= resets the depth (next close strips, never over-pops)", () => {
    selectObservacion("/admin/observaciones?cerrar=abc", false); // depth 1
    syncDepthAfterPop(false); // browser Back closed it
    closeObservationInspector("/admin/observaciones");
    expect(goSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/admin/observaciones");
  });
});
