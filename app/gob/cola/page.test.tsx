// @vitest-environment jsdom
//
// /gob/cola — render smoke test (opfilterbar-sweep2-2026-07-21, item 4).
//
// Pins the item-4 shell fix: this screen used to wrap its content in
// `<main className="px-6 py-8"><div className="max-w-5xl mx-auto space-y-6">`
// instead of the canonical operator shell `<div className="space-y-6">` (the
// operator layout already renders its own <main> landmark). This test renders
// the real page and asserts the canonical shell markup, plus that the queue
// still renders without throwing.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: vi.fn(async () => ({
    user: { id: "govt-1", email: "govt@dim.test" },
    profile: { id: "govt-1", role: "govt" },
    jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
  })),
}));

vi.mock("@/lib/infra/approval-scope", () => ({
  fetchVisiblePendingRequests: vi.fn(async () => []),
}));

const recordSurfaceVisit = vi.fn();
vi.mock("@/lib/infra/surface-visits", () => ({
  recordSurfaceVisit: (...args: unknown[]) => recordSurfaceVisit(...args),
}));

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    },
  };
});

vi.mock("@/lib/ui/portal-base", () => ({
  portalBase: vi.fn(async () => "/gob"),
}));

import ColaPage from "./page";

describe("/gob/cola — render smoke test", () => {
  it("uses the canonical space-y-6 shell, not a centered <main>/mx-auto wrapper", async () => {
    const node = await ColaPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Aprobaciones");
    expect(html).not.toContain("<main");
    expect(html).not.toContain("mx-auto");
    expect(html).not.toContain("max-w-5xl");
  });

  it("renders the type filter chips without throwing", async () => {
    const node = await ColaPage({ searchParams: Promise.resolve({ type: "role_upgrade_vet" }) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Matrículas veterinarias");
  });
});

// T4-O3 (gob-onboarding-checklist, "approvals" step) — the checklist step
// added 2026-09-23 that sends operators here reads this exact surface key.
describe("/gob/cola — records the onboarding surface visit", () => {
  it("records a visit to the 'cola' surface for the acting user", async () => {
    recordSurfaceVisit.mockClear();
    await ColaPage({ searchParams: Promise.resolve({}) });
    expect(recordSurfaceVisit).toHaveBeenCalledWith("govt-1", "cola");
  });
});
