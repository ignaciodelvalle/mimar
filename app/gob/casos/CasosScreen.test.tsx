// @vitest-environment jsdom
//
// CasosScreen — render smoke test (opfilterbar-sweep-2026-07-21, R1).
//
// F6 fusion (2026-07-22): relocated verbatim from the former /gob/casos
// page.test.tsx — the page itself is now the Casos hub (app/gob/casos/
// page.tsx), and this screen is what it renders under ?expediente=casos
// (the default). Same assertions, same mocks; only the import + call site
// changed (CasosScreen takes a plain resolved searchParams object, not a
// Promise — the hub already awaits it once).
//
// THE BUG this was ADDED to catch: /gob/casos and /admin/casos crashed at
// runtime ("Algo salió mal", digest attached) even though `tsc --noEmit` was
// clean and every existing unit test passed. Root cause: `parseCasoEstado`
// was defined and exported from CasoEstadoFilter.tsx, a "use client" module.
// Next's RSC bundler treats EVERY export of a "use client" module as a
// client reference — including a plain, hook-free function — so calling it
// (not rendering it) from this Server Component's data-loading function threw:
// "Attempted to call parseCasoEstado() from the server but parseCasoEstado is
// on the client." That boundary is enforced by Next's actual webpack/turbopack
// build (react-server-dom-webpack), which this project's Vitest config does
// NOT replicate (see vitest.config.ts — plain @vitejs/plugin-react, no
// `react-server` condition) — so calling parseCasoEstado() here does NOT, by
// itself, reproduce the exact throw. This test instead pins the OTHER half
// of the contract: the screen must actually render its real JSX tree (Estado
// control, KIND/Provincia axes, CaseQueue) end to end with realistic props,
// so any FUTURE break in that render path — a thrown exception, a bad prop,
// an undefined access — fails here instead of only on the running server.
// The module-boundary invariant itself (parseCasoEstado must NOT live in a
// "use client" file) is pinned separately in
// components/ui/dashboard/caso-estado.test.ts, and was verified against the
// real Next dev server (the only thing that actually enforces the RSC
// boundary) as part of the same fix.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: vi.fn(async () => ({
    supabase: {},
    user: { id: "user-1", email: "govt@dim.test" },
    profile: { id: "user-1", role: "govt" },
    jurisdictions: [
      { province: "Buenos Aires", locality: "La Plata" },
      { province: "Buenos Aires", locality: "Quilmes" },
    ],
  })),
}));

vi.mock("@/lib/infra/case-queries", () => ({
  listCasesForGovt: vi.fn(async () => []),
  countCasesForGovt: vi.fn(async () => 0),
  listCasesForAdmin: vi.fn(async () => []),
  countCasesForAdmin: vi.fn(async () => 0),
}));

// resolveJurisdictionScope does real catalog I/O (ISO → Province, slug →
// Locality, the ~4000-row locality table). Mocked here exactly as /gob's own
// page test mocks it — what this file pins is the WIRING: that the screen
// forwards the raw URL params to the canonical resolver and then scopes its
// queries by what came back, rather than parsing jurisdiction out of the URL
// on its own terms.
const scopeFixture = {
  filteredJurisdictions: [
    { province: "Buenos Aires", locality: "La Plata" },
    { province: "Buenos Aires", locality: "Quilmes" },
  ] as Array<{ province: string; locality: string }>,
  localities: [] as Array<{ slug: string; name: string }>,
  allowedProvinces: [{ code: "AR-B", name: "Buenos Aires" }],
  adminSelectedProvince: null as string | null,
  adminSelectedLocality: null as string | null,
};

vi.mock("@/lib/analytics/jurisdiction-scope", () => ({
  resolveJurisdictionScope: vi.fn(async () => scopeFixture),
}));

import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { countCasesForAdmin, countCasesForGovt, listCasesForGovt } from "@/lib/infra/case-queries";

import { CasosScreen } from "./CasosScreen";

describe("CasosScreen — render smoke test", () => {
  it("renders the govt viewer's Estado control + queue caption without throwing", async () => {
    const node = await CasosScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Casos");
    expect(html).toContain("Estado");
    expect(html).toContain("Abiertos");
    expect(html).toContain("No hay casos abiertos en tu jurisdicción.");
  });

  // The province fixture here used to read `province: "Buenos Aires"` — a
  // canonical NAME, this screen's old private contract. Every other /gob
  // surface commits `province=<ISO code>`, so the fixture quietly certified
  // the divergence that made a drill-down from the Panel evaporate. It is an
  // ISO code now, like the URL a real switcher writes.
  it("renders with an explicit status + kind + jurisdiction query without throwing", async () => {
    const node = await CasosScreen({
      searchParams: { status: "all", kind: "maltrato", province: "AR-B", locality: "la-plata" },
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Casos");
  });

  // The subtitle's "se trabajan en … Disputas" pointer used to href
  // /gob/disputas, which since the F6 fusion only redirects to
  // /gob/casos?expediente=disputas — back into the hub the reader already has
  // open. Both halves are pinned: the href (the bounce) and the word
  // "expediente" (the promise). The copy has to keep saying the click switches
  // a tab, because that is now the only thing it does.
  it("points at the sibling Disputas expediente, not the /gob/disputas bounce", async () => {
    const node = await CasosScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain('href="/gob/casos?expediente=disputas"');
    expect(html).not.toContain('href="/gob/disputas"');
    expect(html).toContain("se trabajan en el expediente");
  });

  it("renders the admin-universal branch (role=admin viewing /gob/casos) without throwing", async () => {
    const { requireGobReadAccessOrRedirect } = await import("@/lib/infra/auth-guards");
    const adminSession: Awaited<ReturnType<typeof requireGobReadAccessOrRedirect>> = {
      supabase: {} as Awaited<ReturnType<typeof requireGobReadAccessOrRedirect>>["supabase"],
      user: { id: "admin-1", email: "admin@dim.test" },
      profile: { id: "admin-1", role: "admin" },
      jurisdictions: [],
    };
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValueOnce(adminSession);
    const node = await CasosScreen({ searchParams: {} });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Vista universal admin.");
  });
});

// ---------------------------------------------------------------------------
// THE QUEUE FOLLOWS THE JURISDICTION FILTER (demo review 2026-08-01).
//
// Measured on staging: the /gob tile "Casos regulatorios" said 38 for a CABA
// operator and the queue it linked to said "32 casos"; for a 5-locality
// operator, 10 vs 9. With admin filtered to `?province=AR-B` the tile stayed
// frozen at the national 543 while every sibling tile in the same row moved.
// One click, two numbers.
//
// Two causes, both here: this screen parsed `?province=<canonical name>`
// against a hand-built list — so the canonical `province=AR-B` the rest of
// /gob writes resolved to nothing and was silently dropped — and it had no
// locality axis at all, so a barrio-level drill had nowhere to land.
// ---------------------------------------------------------------------------

describe("CasosScreen — jurisdiction narrowing goes through the canonical resolver", () => {
  async function renderGovt(searchParams: Record<string, string | undefined>) {
    vi.clearAllMocks();
    return renderToStaticMarkup(await CasosScreen({ searchParams }));
  }

  it("forwards the RAW ?province/?locality params to the shared resolver", async () => {
    await renderGovt({ province: "AR-B", locality: "la-plata" });
    expect(vi.mocked(resolveJurisdictionScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "govt",
        params: { province: "AR-B", locality: "la-plata" },
      }),
    );
  });

  it("scopes the govt queue by the RESOLVED (narrowed) set, not the raw mandate", async () => {
    const narrowed = [{ province: "Buenos Aires", locality: "La Plata" }];
    const previous = scopeFixture.filteredJurisdictions;
    scopeFixture.filteredJurisdictions = narrowed;
    try {
      await renderGovt({ province: "AR-B", locality: "la-plata" });
      // The session mandate is La Plata + Quilmes; the narrowed view is La
      // Plata alone, and BOTH the rows and the total must say so.
      expect(vi.mocked(listCasesForGovt).mock.calls[0][0]).toEqual(narrowed);
      expect(vi.mocked(countCasesForGovt).mock.calls[0][0]).toEqual(narrowed);
    } finally {
      scopeFixture.filteredJurisdictions = previous;
    }
  });

  it("pushes the admin drill into SQL as province + locality names", async () => {
    const { requireGobReadAccessOrRedirect } = await import("@/lib/infra/auth-guards");
    const previous = {
      province: scopeFixture.adminSelectedProvince,
      locality: scopeFixture.adminSelectedLocality,
    };
    scopeFixture.adminSelectedProvince = "CABA";
    scopeFixture.adminSelectedLocality = "Palermo";
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValueOnce({
      supabase: {} as Awaited<ReturnType<typeof requireGobReadAccessOrRedirect>>["supabase"],
      user: { id: "admin-1", email: "admin@dim.test" },
      profile: { id: "admin-1", role: "admin" },
      jurisdictions: [],
    });
    try {
      await renderGovt({ province: "AR-C", locality: "palermo" });
      // Admin has no assignment set to narrow, so the drill can only arrive as
      // an explicit predicate. Before this it arrived as nothing at all and
      // the "universal" count was the country's.
      expect(vi.mocked(countCasesForAdmin)).toHaveBeenCalledWith(
        expect.objectContaining({ province: "CABA", locality: "Palermo" }),
      );
    } finally {
      scopeFixture.adminSelectedProvince = previous.province;
      scopeFixture.adminSelectedLocality = previous.locality;
    }
  });

  it("keeps the govt queries free of an explicit province predicate — the fence already narrowed", async () => {
    await renderGovt({ province: "AR-B" });
    const filters = vi.mocked(countCasesForGovt).mock.calls[0][1];
    expect(filters).not.toHaveProperty("province");
    expect(filters).not.toHaveProperty("locality");
  });
});
