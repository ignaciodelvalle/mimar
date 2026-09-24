// @vitest-environment jsdom
//
// CredencialesScreen (rendered under /gob/directorio?registro=credenciales)
// — render smoke test (opfilterbar-sweep2-2026-07-21, item 5b).
//
// F3+F7 fusion (2026-07-22): relocated verbatim from the former /gob/rupga
// page-level test — the route itself now only redirects (see
// ./page.test.tsx), so this test targets the extracted screen component
// directly, preserving every original assertion.
//
// Pins the migration off the bespoke GET <form> (free-text search) onto the
// shared OpFilterBar + SearchFilterField. The Estado control (UrlTabs) is
// deliberately UNCHANGED — its real default is "vigente", not "show all", the
// same default-trap an OpFilterBar axis's own implicit blank "Todas" option
// would reintroduce (see CasoEstadoFilter precedent).
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
    searchServiceDogCredentials: vi.fn(async () => ({ items: [], truncated: false })),
  };
});

import { CredencialesScreen } from "./CredencialesScreen";

describe("CredencialesScreen — render smoke test", () => {
  it("renders the OpFilterBar (Buscar) without the old bespoke <form>, and the Estado tabs", async () => {
    const node = await CredencialesScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Credenciales RUPGA");
    expect(html).toContain("Buscar");
    expect(html).toContain("Vigentes");
  });

  it("renders with an explicit q + status query without throwing", async () => {
    const { searchServiceDogCredentials } = await import("@/lib/infra/admin-search");
    vi.mocked(searchServiceDogCredentials).mockResolvedValueOnce({
      items: [
        {
          petId: "pet-1",
          petPublicToken: "DIM-TEST-0001",
          petName: "Duque",
          serviceType: "guia",
          credentialStatus: "vigente",
          rupgaCredential: "RUPGA-123",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "La Plata",
        },
      ],
      truncated: false,
    });
    const node = await CredencialesScreen({
      searchParams: { q: "duque", status: "vigente" },
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Duque");
  });
});
