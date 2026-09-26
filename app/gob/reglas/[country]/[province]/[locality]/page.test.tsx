// @vitest-environment jsdom
//
// JurisdictionReglasPage — cascade-mask indicator (E5, 2026-07-21 facades
// harvest). Before this pass, "Tipos sin excepción" always displayed the
// hardcoded system default for any rule type not configured AT THIS EXACT
// level — even when a country/province override above it actually governed.
// This pins that the resolved cascade `source` (from resolveBusinessRule,
// the SAME helper the govt read-only lens uses) drives the label, so a
// province-level override shows "Override provincia" instead of a false
// "Default nacional".

import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// No rows configured at this exact (country, province, locality) level —
// every rule type falls into "Tipos sin excepción".
const { chain, rowsState } = vi.hoisted(() => {
  const rowsState: { rows: unknown[] } = { rows: [] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve(rowsState.rows),
  };
  return { chain, rowsState };
});

const placeLabelsMock = vi.fn();
vi.mock("@/lib/infra/rule-place-labels", async () => {
  const actual = await vi.importActual<typeof import("@/lib/infra/rule-place-labels")>(
    "@/lib/infra/rule-place-labels",
  );
  return { ...actual, loadRulePlaceLabels: (...a: unknown[]) => placeLabelsMock(...a) };
});

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return {
    ...actual,
    db: chain,
  };
});

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@dim.test" },
    profile: { id: "admin-1", role: "admin" },
  })),
}));

vi.mock("@/lib/ui/portal-base", () => ({
  portalBase: async () => "/gob",
}));

const resolveBusinessRuleMock = vi.fn();
vi.mock("@/lib/infra/business-rules-resolver", () => ({
  resolveBusinessRule: (...args: unknown[]) => resolveBusinessRuleMock(...args),
}));

import JurisdictionReglasPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  rowsState.rows = [];
  placeLabelsMock.mockResolvedValue({ labelOf: () => null, distinctPlaces: [] });
  resolveBusinessRuleMock.mockImplementation(async (ruleType: string) => {
    // Every type resolves to the genuine hardcoded default EXCEPT
    // microchip_required, which a PROVINCE-level override governs instead —
    // the exact masking scenario the audit flagged.
    if (ruleType === "microchip_required") {
      return {
        payload: { required: false },
        source: "province",
        matchedRow: { id: "rule-mc-prov", country: "AR", province: "Chaco", locality: null },
      };
    }
    return { payload: {}, source: "default", matchedRow: null };
  });
});

describe("JurisdictionReglasPage — cascade-mask indicator", () => {
  it("shows the REAL resolved source for a type overridden at a higher level, not a blind default", async () => {
    const el = await JurisdictionReglasPage({
      params: Promise.resolve({ country: "AR", province: "Chaco", locality: "Resistencia" }),
    });
    const html = renderToStaticMarkup(el);

    // The province override must be visible and labeled honestly...
    expect(html).toContain("Override provincia");
    // ...and must NOT be mislabeled as the untouched national default.
    const microchipSection = html.slice(html.indexOf("Microchip obligatorio"));
    expect(microchipSection.slice(0, 200)).not.toContain("Default nacional");
  });

  it("still labels genuinely-unconfigured types as the national default", async () => {
    const el = await JurisdictionReglasPage({
      params: Promise.resolve({ country: "AR", province: "Chaco", locality: "Resistencia" }),
    });
    const html = renderToStaticMarkup(el);

    expect(html).toContain("Default nacional");
  });

  it("labels the active-rules list with the exact jurisdiction level it's scoped to", async () => {
    const el = await JurisdictionReglasPage({
      params: Promise.resolve({ country: "AR", province: "Chaco", locality: "Resistencia" }),
    });
    const html = renderToStaticMarkup(el);

    expect(html).toContain("Configuradas exactamente en");
  });

  // localidades-por-id D4: two homonyms, each with its own rule, never share
  // one page — the name lists the places, each addressed by its row.
  it("a name that covers two keyed places lists them to choose from, by id", async () => {
    rowsState.rows = [
      { rule: { id: "r1", ruleType: "microchip_required" }, updatedBy: null },
      { rule: { id: "r2", ruleType: "microchip_required" }, updatedBy: null },
    ];
    placeLabelsMock.mockResolvedValue({
      labelOf: () => null,
      distinctPlaces: [
        {
          key: { kind: "locality", id: "aaaaaaaa-0000-4000-8000-000000000001" },
          label: "Mechita (Alberti)",
        },
        {
          key: { kind: "locality", id: "aaaaaaaa-0000-4000-8000-000000000002" },
          label: "Mechita (Bragado)",
        },
      ],
    });
    const el = await JurisdictionReglasPage({
      params: Promise.resolve({ country: "AR", province: "Buenos Aires", locality: "Mechita" }),
    });
    const html = renderToStaticMarkup(el);
    expect(html).toContain("Mechita (Alberti)");
    expect(html).toContain("Mechita (Bragado)");
    expect(html).toContain("?lugar=aaaaaaaa-0000-4000-8000-000000000002");
    expect(html).not.toContain("Reglas activas");
  });
});
