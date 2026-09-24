// @vitest-environment jsdom
//
// UsuariosScreen (rendered under /gob/directorio?registro=usuarios and
// /admin/directorio?registro=usuarios) — render smoke test
// (opfilterbar-sweep2-2026-07-21, item 1).
//
// F3+F7 fusion (2026-07-22): relocated verbatim from the former
// /gob/usuarios page-level test — the route itself now only redirects (see
// ./page.test.tsx), so this test targets the extracted screen component
// directly, preserving every original assertion.
//
// Pins the item-1 fix: the "Validez ISO de chips" KPI (a pets/microchip
// compliance metric) must NOT render on this USERS roster page anymore — it
// was out of place here (confirmed chip-ISO-scoped, not user-scoped) and has
// been removed, along with the now-degenerate 1-item KPI row wrapper. The
// chip-fraud OpBreach signal (a distinct, out-of-scope-for-this-round concern)
// and the OpFilterBar (Rol axis + Buscar search) must still render correctly.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: vi.fn(async () => ({
    user: { id: "govt-1", email: "govt@dim.test" },
    profile: { id: "govt-1", role: "govt" },
    jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
  })),
}));

vi.mock("@/lib/infra/admin-search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/infra/admin-search")>(
    "@/lib/infra/admin-search",
  );
  return {
    ...actual,
    searchUsers: vi.fn(async () => []),
  };
});

vi.mock("@/lib/infra/test-accounts", () => ({
  isTestAccount: vi.fn(() => false),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({})),
  buildAuthEmailMap: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/analytics/compliance-metrics", () => ({
  fetchChipReplacementSignal: vi.fn(async () => ({
    flaggedForReview: 0,
    total: 0,
    byReason: {},
  })),
}));

vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

vi.mock("@/src/modules/organizations/application/admin-proposals/log-pii-query", () => ({
  logPiiReadSafely: vi.fn(async () => {}),
}));

vi.mock("@/lib/ui/portal-base", () => ({
  portalBase: vi.fn(async () => "/gob"),
}));

import { UsuariosScreen } from "./UsuariosScreen";

describe("UsuariosScreen — render smoke test", () => {
  it("renders without the ISO-validity chip KPI (item 1 removal)", async () => {
    const node = await UsuariosScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Usuarios");
    // The removed KPI's exact copy must be gone.
    expect(html).not.toContain("Validez ISO de chips");
    expect(html).not.toContain("Registro y cumplimiento");
  });

  it("still renders the OpFilterBar (Rol axis + Buscar) and the chip-fraud OpBreach path", async () => {
    const { fetchChipReplacementSignal } = await import("@/lib/analytics/compliance-metrics");
    vi.mocked(fetchChipReplacementSignal).mockResolvedValueOnce({
      flaggedForReview: 2,
      total: 5,
      byReason: { fraud_detected: 1, duplicate_detected: 1 },
    });
    const node = await UsuariosScreen({ searchParams: { role: "vet" } });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Rol");
    expect(html).toContain("Buscar");
    expect(html).toContain("marcado");
  });

  // The Rol dropdown offers EVERY role the enum has.
  //
  // Asserting the presence of the word "Rol" is what let a real gap through a
  // green gate: migration 0214 added `national`, the label map grew because the
  // compiler demanded it, and the option array — a literal cast to the union —
  // silently did not. The roster could name the role and not offer it.
  //
  // The oracle is the LABEL of the role added last, not a count: a count would
  // pass again the next time somebody adds a role and forgets the option.
  it("offers every role of the enum in the Rol filter, national included", async () => {
    const node = await UsuariosScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Lectura nacional");
    expect(html).toContain("Veterinario/a");
    expect(html).toContain("Administrador/a");
  });
});
