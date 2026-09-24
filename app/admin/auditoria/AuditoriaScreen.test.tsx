// @vitest-environment jsdom
//
// AuditoriaScreen — the "Cambios sensibles" vista of the Auditoría hub.
// Relocated body of the former /admin/auditoria page (audit-trail fusion,
// 2026-08-02); these tests are the former page-level T3.3 pins, retargeted
// at the screen (the hub page keeps the streamed shell — see page.test.tsx):
//   1. The fetch group is bounded: when loadAuditData hangs past 8 s the body
//      resolves into the honest AnalyticsLoadFallback whose retry link KEEPS
//      the active filters AND the hub's vista param — never a blank hang.
//   2. The happy path still renders the audit log from the loader's data.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/admin/auditoria",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({
    profile: { id: "admin-1", role: "admin" },
  })),
}));

const mocks = vi.hoisted(() => ({
  loadAuditData: vi.fn(),
}));

vi.mock("./_lib/load-audit-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_lib/load-audit-data")>();
  return { ...actual, loadAuditData: mocks.loadAuditData };
});

import { AuditoriaScreen } from "./AuditoriaScreen";
import type { AuditData } from "./_lib/load-audit-data";

const AUDIT_DATA: AuditData = {
  entries: [
    {
      id: "3f0e8f7a-1111-4222-8333-444455556666",
      actorUserId: "9a0e8f7a-1111-4222-8333-444455556666",
      action: "request_approved",
      approvalRequestId: null,
      targetUserId: null,
      performedAt: new Date("2026-07-30T12:00:00Z"),
      payload: null,
    },
  ],
  hasMore: false,
  namesById: new Map([["9a0e8f7a-1111-4222-8333-444455556666", "Operadora Demo"]]),
  targetsById: new Map(),
  actorOptions: [{ id: "9a0e8f7a-1111-4222-8333-444455556666", name: "Operadora Demo" }],
};

afterEach(() => {
  vi.useRealTimers();
  mocks.loadAuditData.mockReset();
});

describe("AuditoriaScreen — bounded fetch group (T3.3)", () => {
  it("renders the audit log when the loader resolves in time", async () => {
    mocks.loadAuditData.mockResolvedValue(AUDIT_DATA);
    const html = renderToStaticMarkup(await AuditoriaScreen({ searchParams: {}, underHub: true }));
    expect(html).toContain("Registro de auditoría");
    expect(html).toContain("Operadora Demo");
    expect(html).not.toContain("Reintentar");
  });

  it("a hanging loader degrades into the honest fallback after 8 s — retry keeps filters AND vista", async () => {
    vi.useFakeTimers();
    mocks.loadAuditData.mockReturnValue(new Promise(() => {}));
    const pending = AuditoriaScreen({
      searchParams: { vista: "sensibles", action: "request_approved", from: "2026-01-01" },
      underHub: true,
    });
    await vi.advanceTimersByTimeAsync(8_001);
    const node = await pending;
    vi.useRealTimers();

    const html = renderToStaticMarkup(node);
    expect(html).toContain("tardando más de lo normal");
    expect(html).toContain("Reintentar");
    // The retry href preserves the operator's active filters and the hub tab.
    expect(html).toContain("action=request_approved");
    expect(html).toContain("from=2026-01-01");
    expect(html).toContain("vista=sensibles");
    // Degraded state never fabricates an entries list (no "N entradas" card).
    expect(html).not.toContain("entradas");
    expect(html).not.toContain("Operadora Demo");
  });
});
