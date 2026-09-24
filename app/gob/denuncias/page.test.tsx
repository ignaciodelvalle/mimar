// @vitest-environment jsdom
//
// /gob/denuncias — the Denuncias hub. F1 fusion (2026-07-22, PO-approved
// route unification): the hub ABSORBS Moderación + Maltrato as TABBED STAGES
// (`?etapa=moderacion|triage`) of one screen, superseding the earlier C6a
// additive-hub design (3 stage cards linking out to separate routes). Casos
// stays a link-out (its own screen, different decision family).
//
// The two embedded stage screens (ModeracionQueueScreen / MaltratoQueueScreen)
// are heavy server components with their own DB/auth-guard/jurisdiction-scope
// dependencies — this test stubs them out entirely (their own byte-identical
// bodies are unit-tested nowhere at the full-page level, same as before this
// fusion: neither /gob/moderacion nor /gob/maltrato ever had a page-level
// test) so the hub test can focus on what the HUB itself owns: the pipeline
// header, the Casos link-out, the etapa tab switcher (labels + badge counts),
// and — critically — that the default stage is "triage" and that ?etapa=
// actually selects the right embedded stage.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let mockSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: vi.fn(async () => ({
    user: { id: "govt-1", email: "govt@dim.test" },
    profile: { id: "govt-1", role: "govt" },
    jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
  })),
}));

vi.mock("@/lib/infra/case-queries", () => ({
  countCasesForAdmin: vi.fn(async () => 7),
  countCasesForGovt: vi.fn(async () => 7),
}));

vi.mock("@/lib/analytics/govt-home-kpis", () => ({
  fetchOpenWelfareReportsCount: vi.fn(async () => ({ count: 12 })),
}));

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: async () => [{ n: 3 }],
        }),
      }),
    },
  };
});

vi.mock("@/app/gob/moderacion/ModeracionQueueScreen", () => ({
  ModeracionQueueScreen: () => <div data-testid="moderacion-stub">MODERACION STAGE CONTENT</div>,
}));

vi.mock("@/app/gob/maltrato/MaltratoQueueScreen", () => ({
  MaltratoQueueScreen: () => <div data-testid="maltrato-stub">TRIAGE STAGE CONTENT</div>,
}));

import GobDenunciasPage from "./page";

function renderHub(query: Record<string, string> = {}) {
  mockSearch = new URLSearchParams(query);
  return GobDenunciasPage({ searchParams: Promise.resolve(query) });
}

describe("/gob/denuncias — the hub (F1 fusion: Moderación + Maltrato as tabbed stages)", () => {
  it("renders the pipeline explainer header", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("El recorrido de una denuncia");
    expect(html).toContain("moderación");
    expect(html).toContain("Ley 14.346");
  });

  it("renders the Casos link-out with its live count (Casos stays its own screen — not absorbed)", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("/gob/casos");
    expect(html).toContain("Ver casos");
    expect(html).toContain("7"); // casosCount mock
  });

  // The mock above returns 7 for ANY arguments, so the test that reads "7" off
  // the page cannot tell a kind-filtered count from an unfiltered one. That gap
  // is what shipped: the stage titled "Denuncias escaladas a un caso
  // regulatorio" counted EVERY open case in scope, and live review 2026-07-28
  // read "ABIERTOS 28" while `kind=welfare_denuncia` had zero rows at every
  // status — the 28 were custody disputes.
  //
  // Assert the ARGUMENTS, not just the rendered number.
  it("counts only escalated denuncias — the kind the stage is titled after", async () => {
    const { countCasesForGovt } = await import("@/lib/infra/case-queries");
    vi.mocked(countCasesForGovt).mockClear();

    await renderHub();

    expect(countCasesForGovt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "open", kind: "welfare_denuncia" }),
    );
  });

  it("renders both etapa tab labels with their live queue-depth badges", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Moderación");
    // Tab label is just "Triage" (PO 2026-07-22): the hub subtitle + stage
    // header already name Ley 14.346 — but the LAW must still be named ON the
    // page (the honesty part), so assert both.
    expect(html).toContain(">Triage<");
    expect(html).toContain("Ley 14.346");
    expect(html).toContain("3"); // moderationCount mock (db count() → n:3)
    expect(html).toContain("12"); // triage.count mock
  });

  it("defaults to the 'triage' stage when no ?etapa= is given (Maltrato is the daily heavy-traffic queue)", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("TRIAGE STAGE CONTENT");
    expect(html).not.toContain("MODERACION STAGE CONTENT");
  });

  it("?etapa=moderacion renders the Moderación stage instead", async () => {
    const node = await renderHub({ etapa: "moderacion" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("MODERACION STAGE CONTENT");
    expect(html).not.toContain("TRIAGE STAGE CONTENT");
  });

  it("an unrecognized ?etapa= value falls back to the triage default (never crashes, never shows blank)", async () => {
    const node = await renderHub({ etapa: "not-a-real-stage" });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("TRIAGE STAGE CONTENT");
  });

  it("does not link out to the old standalone /gob/moderacion or /gob/maltrato routes from the hub itself", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    // The hub's own CTAs must point at etapa= tabs, not the (now-redirecting)
    // old routes — regression guard against reintroducing the pre-fusion links.
    expect(html).not.toContain('href="/gob/moderacion"');
    expect(html).not.toContain('href="/gob/maltrato"');
  });

  // Regression (qa-triage-2026-07-23, finding #5): the Caso link-out used to sit
  // ABOVE the etapa tabs, so with Triage active the single biggest header on
  // the page read the Caso header instead of the active stage's own content —
  // the funcionario couldn't tell which step they were on. The active stage's
  // content must now appear BEFORE the Caso link-out in DOM order (both stay
  // present — this only re-orders them).
  it("renders the active stage's content ABOVE the Caso link-out card (active stage dominates the fold)", async () => {
    const node = await renderHub();
    const html = renderToStaticMarkup(node);
    const stageIndex = html.indexOf("TRIAGE STAGE CONTENT");
    const casoIndex = html.indexOf("Casos regulatorios");
    expect(stageIndex).toBeGreaterThan(-1);
    expect(casoIndex).toBeGreaterThan(-1);
    expect(stageIndex).toBeLessThan(casoIndex);
  });
});
