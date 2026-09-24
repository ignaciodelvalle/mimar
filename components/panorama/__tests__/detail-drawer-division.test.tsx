// @vitest-environment jsdom
//
// Panorama drawer cluster fix (Tanda A, 2026-07-16). Two defects in the
// choropleth-division branch of FeatureBody:
//   1. A department (partido) click carried its name in `departmentName`, which
//      FeatureBody never read — the unit row rendered "—" with no province.
//   2. The `esterilizacion` layer was absent from the combined choropleth case,
//      so its cells fell through to the empty "Sin detalle para esta capa."
//
// FeatureBody is tested in isolation (see detail-drawer-aggregate.test.tsx for
// the rationale — avoids the native <dialog> jsdom gap + unit-history fetch).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeatureBody } from "@/components/panorama/DetailDrawer";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/panorama",
}));

afterEach(cleanup);

describe("DetailDrawer FeatureBody — choropleth division cells", () => {
  it("shows a department name + province from `departmentName` (not '—')", () => {
    render(
      <FeatureBody
        layerId="cobertura"
        properties={{
          departmentName: "Río Cuarto",
          province: "Córdoba",
          locality: null,
          level: "locality",
          value: 340,
          suppressed: false,
        }}
      />,
    );

    expect(screen.getByText("Río Cuarto, Córdoba")).toBeInTheDocument();
    expect(screen.getByText("Departamento/partido")).toBeInTheDocument();
    expect(screen.getByText("340")).toBeInTheDocument();
  });

  it("labels a CABA barrio as 'Barrio' and keeps its province context", () => {
    render(
      <FeatureBody
        layerId="cobertura"
        properties={{
          departmentName: "Palermo",
          province: "CABA",
          locality: "Palermo",
          level: "locality",
          value: 88,
          suppressed: false,
        }}
      />,
    );

    expect(screen.getByText("Palermo, CABA")).toBeInTheDocument();
    expect(screen.getByText("Barrio")).toBeInTheDocument();
  });

  it("renders the esterilizacion cell (was falling through to the empty state)", () => {
    render(
      <FeatureBody
        layerId="esterilizacion"
        properties={{
          departmentName: "General Pueyrredón",
          province: "Buenos Aires",
          locality: null,
          level: "locality",
          value: 512,
          suppressed: false,
        }}
      />,
    );

    expect(screen.getByText("General Pueyrredón, Buenos Aires")).toBeInTheDocument();
    expect(screen.getByText("Mascotas esterilizadas")).toBeInTheDocument();
    expect(screen.getByText("512")).toBeInTheDocument();
    expect(screen.queryByText("Sin detalle para esta capa.")).not.toBeInTheDocument();
  });

  it("honors k-anon suppression on an esterilizacion department cell", () => {
    render(
      <FeatureBody
        layerId="esterilizacion"
        properties={{
          departmentName: "Tafí del Valle",
          province: "Tucumán",
          locality: null,
          level: "locality",
          value: null,
          suppressed: true,
        }}
      />,
    );

    expect(screen.getByText(/Suprimido \(privacidad · k‑anon\)/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
