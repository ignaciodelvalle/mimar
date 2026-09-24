// @vitest-environment jsdom
//
// T4.5 (2026-08-01): DetailDrawer's drill links (denuncias/perdidas/vigilancia/
// programa) hardcoded a bare destination href, dropping the clicked unit's
// province/locality — an operator investigating a hot department landed back
// on the UNFILTERED national list instead of that department's slice. The
// destinations already read `province`/`locality` searchParams; the fix
// threads `properties.province`/`properties.locality` (already in scope on
// every aggregated cell) into each href via `withUnitScope`.
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

describe("DetailDrawer FeatureBody — drill links keep the unit filter (T4.5)", () => {
  it("threads province+locality into the AGGREGATED perdidas drill (unit summary)", () => {
    render(
      <FeatureBody
        layerId="perdidas"
        properties={{
          place: "La Plata, Buenos Aires",
          province: "Buenos Aires",
          locality: "La Plata",
          level: "locality",
          count: 12,
          suppressed: false,
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Ver pérdidas →" });
    expect(link).toHaveAttribute("href", "/gob/perdidas?province=Buenos+Aires&locality=La+Plata");
  });

  it("threads province+locality into the AGGREGATED mordeduras drill (vigilancia)", () => {
    render(
      <FeatureBody
        layerId="mordeduras"
        properties={{
          place: "Rosario, Santa Fe",
          province: "Santa Fe",
          locality: "Rosario",
          level: "locality",
          count: 7,
          suppressed: false,
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Ver vigilancia →" });
    expect(link).toHaveAttribute("href", "/gob/vigilancia?province=Santa+Fe&locality=Rosario");
  });

  it("appends the unit scope to denuncias without dropping the existing ?etapa=triage", () => {
    render(
      <FeatureBody
        layerId="denuncias"
        properties={{
          coarse: true,
          province: "CABA",
          locality: "Palermo",
          severity: "high",
          kind: "neglect",
          createdAt: "2026-06-01T00:00:00Z",
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Ver bandeja de denuncias →" });
    expect(link).toHaveAttribute(
      "href",
      "/gob/denuncias?etapa=triage&province=CABA&locality=Palermo",
    );
  });

  it("scopes the sintomas cell drill to vigilancia", () => {
    render(
      <FeatureBody
        layerId="sintomas"
        properties={{
          place: "Mendoza",
          province: "Mendoza",
          locality: null,
          level: "province",
          count: 4,
          suppressed: false,
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Ver vigilancia →" });
    expect(link).toHaveAttribute("href", "/gob/vigilancia?province=Mendoza");
  });

  it("scopes the reunificacion cell drill to perdidas", () => {
    render(
      <FeatureBody
        layerId="reunificacion"
        properties={{
          place: "Salta",
          province: "Salta",
          locality: null,
          level: "province",
          count: 62,
          suppressed: false,
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Ver pérdidas →" });
    expect(link).toHaveAttribute("href", "/gob/perdidas?province=Salta");
  });

  // A department fill carries the display name in `departmentName`, not
  // `locality` (see unitName's fallback in the cobertura case) — `properties.
  // locality` is genuinely null here, so the drill scopes by province only.
  it("scopes a choropleth (cobertura) department cell drill by province only, keeping ?vista=analitica", () => {
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
    const link = screen.getByRole("link", { name: "Ver analítica →" });
    expect(link).toHaveAttribute("href", "/gob/programa?vista=analitica&province=C%C3%B3rdoba");
  });

  // A CABA barrio carries a real `locality` value (unlike a department fill),
  // so this drill scopes by BOTH province and locality.
  it("scopes a choropleth (cobertura) CABA barrio cell drill by province+locality", () => {
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
    const link = screen.getByRole("link", { name: "Ver analítica →" });
    expect(link).toHaveAttribute(
      "href",
      "/gob/programa?vista=analitica&province=CABA&locality=Palermo",
    );
  });

  // Individual points-mode dots (perdidas/mordeduras) deliberately carry NO
  // province — the privacy invariant on LostPointProps/BiteProps. The drill
  // must fall back to the bare destination, never crash on the absent props.
  it("leaves the perdidas drill unscoped for an individual points-mode dot (no province)", () => {
    render(
      <FeatureBody
        layerId="perdidas"
        properties={{
          token: "DIM-PAMP-0001",
          name: "Pampa",
          species: "dog",
          status: "lost",
          lastSeenAt: "2026-06-30T12:00:00Z",
          locationSource: "gps",
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "Ver pérdidas →" });
    expect(link).toHaveAttribute("href", "/gob/perdidas");
  });
});
