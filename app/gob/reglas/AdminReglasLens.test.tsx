// @vitest-environment jsdom
//
// AdminReglasLens — customized-jurisdictions-only IA (PO redesign 2026-07-23).
// The previous IA opened with all 24 provincias regardless of whether they
// had any override ("se ve inconexa... muchísimas cajitas para buscar
// localidad" — PO verdict). This pins the new contract:
//   - a jurisdiction with NO custom rules never renders at all (no more
//     scroll-and-scan grid of every province);
//   - a jurisdiction WITH custom rules renders as its own card, naming the
//     rule kind(s), a value summary, and its provenance (país/provincia/
//     localidad level);
//   - the honest empty state when NOTHING anywhere has an override;
//   - the `kind` filter narrows the list to jurisdictions overriding that
//     exact rule type.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Chainable @/db mock — AdminReglasLens issues ONE flat select().from().orderBy()
// over every govt_business_rules row (grouped client-side by jurisdiction).
const { chain, dbState } = vi.hoisted(() => {
  const dbState = { rows: [] as unknown[] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    orderBy: () => Promise.resolve(dbState.rows),
  };
  return { chain, dbState };
});

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return { ...actual, db: chain };
});

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@dim.test" },
    profile: { id: "admin-1", role: "admin" },
  })),
}));

// OpFilterBar (rendered when >1 rule kind is present) calls useSearchParams()
// unconditionally — same mock CredencialesScreen.test.tsx uses for the same reason.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminReglasLens } from "./AdminReglasLens";

function queueRows(rows: unknown[]) {
  dbState.rows = rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = [];
});

describe("AdminReglasLens — customized-jurisdictions-only list", () => {
  it("honest empty state when NO jurisdiction anywhere has a custom rule", async () => {
    queueRows([]);
    const node = await AdminReglasLens({ base: "/admin" });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("Ninguna jurisdicción tiene reglas personalizadas");
    expect(html).toContain("Rigen los defaults nacionales");
    expect(html).toContain("Crear regla");
    // The old grid scanned every province regardless of overrides — none of
    // that should survive even as leftover markup.
    expect(html).not.toContain("Córdoba");
  });

  it("renders a card for a jurisdiction WITH a rule; a jurisdiction with none never appears", async () => {
    queueRows([
      {
        country: "AR",
        province: "Chaco",
        locality: null,
        ruleType: "ppp_breed_list",
        rulePayload: { breeds: ["Pitbull"] },
      },
    ]);
    const node = await AdminReglasLens({ base: "/admin" });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("Chaco");
    expect(html).toContain("Lista de razas PPP");
    expect(html).toContain("Pitbull");
    // Provenance: this row is a PROVINCE-level override (locality is null).
    expect(html).toContain("Override provincia");
    // Córdoba has no rule row at all — must not appear as a phantom card.
    expect(html).not.toContain("Córdoba");
  });

  it("keeps a province-wide row and a locality row as two SEPARATE cards, each with its own provenance", async () => {
    queueRows([
      {
        country: "AR",
        province: "Buenos Aires",
        locality: null,
        ruleType: "microchip_required",
        rulePayload: { required: false },
      },
      {
        country: "AR",
        province: "Buenos Aires",
        locality: "San Isidro",
        ruleType: "ppp_weight_threshold",
        rulePayload: { kg: 25, appliesIfBreedNotPPP: false },
      },
    ]);
    const node = await AdminReglasLens({ base: "/admin" });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("San Isidro");
    expect(html).toContain("Override localidad");
    expect(html).toContain("Override provincia");
    expect(html).toContain("Microchip obligatorio");
    expect(html).toContain("Umbral de peso PPP");
  });

  it("the `kind` filter narrows the list to jurisdictions overriding that exact rule type", async () => {
    queueRows([
      {
        country: "AR",
        province: "Buenos Aires",
        locality: null,
        ruleType: "microchip_required",
        rulePayload: { required: false },
      },
      {
        country: "AR",
        province: "Chaco",
        locality: null,
        ruleType: "ppp_weight_threshold",
        rulePayload: { kg: 25, appliesIfBreedNotPPP: false },
      },
    ]);
    const node = await AdminReglasLens({ base: "/admin", kind: "microchip_required" });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("Buenos Aires");
    expect(html).not.toContain("Chaco");
  });

  it("shows a 'no results for this filter' state (NOT the fully-empty message) when the kind filter matches nothing", async () => {
    queueRows([
      {
        country: "AR",
        province: "Chaco",
        locality: null,
        ruleType: "ppp_weight_threshold",
        rulePayload: { kg: 25, appliesIfBreedNotPPP: false },
      },
    ]);
    const node = await AdminReglasLens({ base: "/admin", kind: "mpf_export_format" });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("Sin resultados para este filtro");
    expect(html).not.toContain("Ninguna jurisdicción tiene reglas personalizadas");
  });

  it("always surfaces the national-defaults reference, even with an empty list", async () => {
    queueRows([]);
    const node = await AdminReglasLens({ base: "/admin" });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("Defaults nacionales");
  });
});
