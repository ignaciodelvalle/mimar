// @vitest-environment jsdom
//
// /gob/mascotas/[token] — render smoke test (opfilterbar-sweep2-2026-07-21,
// item 5a). Pins the shell fix: this was wrapped in
// `<main className="px-6 py-8"><div className="max-w-3xl mx-auto space-y-6">`
// instead of the canonical operator shell `<div className="space-y-6">`.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: vi.fn(async () => ({
    user: { id: "govt-1", email: "govt@dim.test" },
    profile: { id: "govt-1", role: "govt" },
    jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
  })),
}));

vi.mock("@/lib/infra/gob-pet-subview", () => ({
  loadOperatorPetSubView: vi.fn(async () => ({
    publicToken: "DIM-TEST-0001",
    name: "Firulais",
    species: "dog",
    sex: "male",
    status: "active",
    breed: null,
    color: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    microchipCode: null,
    ownerOfRecord: null,
    openCases: [],
  })),
}));

import GobMascotaPage from "./page";

describe("/gob/mascotas/[token] — render smoke test", () => {
  it("uses the canonical space-y-6 shell, not a centered <main>/mx-auto wrapper", async () => {
    const node = await GobMascotaPage({ params: Promise.resolve({ token: "DIM-TEST-0001" }) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Firulais");
    expect(html).not.toContain("<main");
    expect(html).not.toContain("mx-auto");
  });
});
