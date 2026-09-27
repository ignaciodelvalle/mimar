// @vitest-environment jsdom
//
// The /gob/reglas locality drill-down names a CABA barrio with its comuna
// (localidades-por-id C5). Migration 0267 and the CABA importer fill
// ar_localities.department_name with the comuna for every barrio, and the
// drill-down prints the department next to the name, so a search in CABA reads
// "Palermo · Comuna 14". A row without a department prints the name alone.
// Picking a result still navigates by the locality NAME only (the rules route
// is keyed by names).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const search = vi.fn();
vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode: string; query: string }) => search(input),
}));

import { LocalityRuleDrilldown } from "./LocalityRuleDrilldown";

function barrio(name: string, departmentName: string | null): LocalitySearchResult {
  return {
    id: `id-${name}`,
    indecId: null,
    provinceCode: "AR-C",
    departmentName,
    departmentCode: null,
    localityName: name,
    localitySlug: name.toLowerCase(),
    category: "barrio",
    provinceName: "Ciudad Autónoma de Buenos Aires",
    matchKind: "prefix",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocalityRuleDrilldown in CABA", () => {
  it("prints each barrio with its comuna, and a department-less row with its name alone", async () => {
    search.mockResolvedValue({
      results: [barrio("Palermo", "Comuna 14"), barrio("Parque Patricios", null)],
    });
    render(
      <LocalityRuleDrilldown
        provinceCode="AR-C"
        provinceName="Ciudad Autónoma de Buenos Aires"
        base="/gob"
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Pa" } });

    const palermo = await screen.findByRole("button", { name: /Palermo/ });
    expect(palermo).toHaveTextContent("Palermo· Comuna 14");
    expect(search).toHaveBeenCalledWith({ provinceCode: "AR-C", query: "Pa" });

    const patricios = screen.getByRole("button", { name: /Parque Patricios/ });
    expect(patricios).toHaveTextContent(/^Parque Patricios$/);

    fireEvent.mouseDown(palermo);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const href = String(push.mock.calls[0]?.[0]);
    expect(decodeURIComponent(href)).toContain("Palermo");
    expect(decodeURIComponent(href)).not.toContain("Comuna");
  });
});
