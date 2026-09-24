// @vitest-environment jsdom
//
// OrganizacionesScreen (rendered under /gob/directorio?registro=organizaciones
// and /admin/directorio?registro=organizaciones) — render smoke test
// (opfilterbar-sweep2-2026-07-21, item 2).
//
// F3+F7 fusion (2026-07-22): relocated verbatim from the former
// /gob/organizaciones page-level test — the route itself now only redirects
// (see ./page.test.tsx), so this test targets the extracted screen component
// directly, preserving every original assertion.
//
// Pins the item-2 migration off the bespoke GET <form>/<select> filter row
// onto the shared OpFilterBar (Verificación + Tipo axes, Buscar search child)
// — same query param contract (q, verified, orgType) as before.
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
    searchOrganizations: vi.fn(async () => ({ items: [], truncated: false })),
  };
});

vi.mock("@/src/modules/organizations/application/admin-proposals/log-pii-query", () => ({
  logPiiReadSafely: vi.fn(async () => {}),
}));

vi.mock("@/lib/ui/portal-base", () => ({
  portalBase: vi.fn(async () => "/gob"),
}));

import { OrganizacionesScreen } from "./OrganizacionesScreen";

describe("OrganizacionesScreen — render smoke test", () => {
  it("renders the OpFilterBar (Verificación + Tipo axes, Buscar) without the old bespoke <form>", async () => {
    const node = await OrganizacionesScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Organizaciones");
    expect(html).toContain("Verificación");
    expect(html).toContain("Tipo");
    expect(html).toContain("Buscar");
  });

  it("renders with explicit verified/orgType/q query params without throwing", async () => {
    const { searchOrganizations } = await import("@/lib/infra/admin-search");
    vi.mocked(searchOrganizations).mockResolvedValueOnce({
      items: [
        {
          id: "org-1",
          displayName: "Refugio Sur",
          legalName: "Refugio Sur SRL",
          orgType: "shelter",
          cuit: null,
          verified: true,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "La Plata",
        },
      ],
      truncated: false,
    });
    const node = await OrganizacionesScreen({
      searchParams: { q: "sur", verified: "verified", orgType: "shelter" },
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Refugio Sur");
  });
});
