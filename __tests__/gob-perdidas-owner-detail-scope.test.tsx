// gob-perdidas-owner-detail-scope.test.tsx — PO decision 4 ("Pérdidas:
// ubicación legible + scope operativo", 2026-07-23).
//
// Covers:
//  1. isNarrowedToOperativeJurisdiction (lib/ui/view-scope-caption.ts) — the
//     pure boolean C3 ViewScope predicate that decides whether the CURRENT
//     view is narrowed to a single operative jurisdiction (admin province
//     drill, or a govt view whose effective jurisdictions share one
//     province) vs national/multi-province.
//  2. LostPetRow (app/gob/perdidas/_components/LostPetRow.tsx) — the
//     presentation-minimization row: national/multi-province view renders
//     WITHOUT owner-identifying fields (pet + locality + days only); a
//     narrowed view renders the full detail row.
//  3. The legible-location line: raw coordinates never appear as visible
//     row text — only a locality name, or (when there is no locality) a
//     map-affordance link with no coordinate numbers in its label.
//
// Pure component/function tests — react-dom/server, next/link mocked (repo
// convention, mirrors gob-lost-pet-row-tone.test.tsx). No DB.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { LostPetRow } from "@/app/gob/perdidas/_components/LostPetRow";
import { isNarrowedToOperativeJurisdiction } from "@/lib/ui/view-scope-caption";

// ---------------------------------------------------------------------------
// 1. isNarrowedToOperativeJurisdiction
// ---------------------------------------------------------------------------

describe("isNarrowedToOperativeJurisdiction", () => {
  it("admin, national (no province drill) → false", () => {
    expect(isNarrowedToOperativeJurisdiction({ role: "admin", effectiveJurisdictions: [] })).toBe(
      false,
    );
  });

  it("admin, drilled to a province → true", () => {
    expect(
      isNarrowedToOperativeJurisdiction({
        role: "admin",
        effectiveJurisdictions: [],
        adminProvince: "CABA",
      }),
    ).toBe(true);
  });

  it("govt, effective view spans multiple provinces → false", () => {
    expect(
      isNarrowedToOperativeJurisdiction({
        role: "govt",
        effectiveJurisdictions: [
          { province: "Buenos Aires", locality: "La Plata" },
          { province: "CABA", locality: "Palermo" },
        ],
      }),
    ).toBe(false);
  });

  it("govt, effective view is a single province (one or many localities within it) → true", () => {
    expect(
      isNarrowedToOperativeJurisdiction({
        role: "govt",
        effectiveJurisdictions: [
          { province: "Buenos Aires", locality: "La Plata" },
          { province: "Buenos Aires", locality: "Quilmes" },
        ],
      }),
    ).toBe(true);
  });

  it("govt with zero effective jurisdictions (no-scope) → false", () => {
    expect(isNarrowedToOperativeJurisdiction({ role: "govt", effectiveJurisdictions: [] })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. LostPetRow — owner-detail redaction
// ---------------------------------------------------------------------------

const BASE_PET = {
  petId: "pet-1",
  petPublicToken: "DIM-GOBT-0001",
  petName: "Firulais",
  species: "dog",
  petStatus: "lost",
  province: "Buenos Aires",
  locality: "La Plata",
  markedLostAt: new Date("2026-07-01T12:00:00Z"),
  lastSeenLat: -34.9214,
  lastSeenLng: -57.9544,
  ownerDisplayName: "Juana Pérez",
};

describe("LostPetRow — owner-detail scope (PO decision 4b)", () => {
  it("national/multi-province view (showOwnerDetail=false) hides the owner name", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={BASE_PET} caseCode="CAS-0001-0001" showOwnerDetail={false} />,
    );
    expect(html).not.toContain("Juana Pérez");
    expect(html).not.toContain("Dueño");
  });

  it("national/multi-province view hides the case-code link and the credential link", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={BASE_PET} caseCode="CAS-0001-0001" showOwnerDetail={false} />,
    );
    expect(html).not.toContain("CAS-0001-0001");
    expect(html).not.toContain("Ver credencial");
  });

  it("national/multi-province view still shows pet + locality + days", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={BASE_PET} caseCode="CAS-0001-0001" showOwnerDetail={false} />,
    );
    expect(html).toContain("Firulais");
    expect(html).toContain("La Plata");
    expect(html).toContain("Buenos Aires");
  });

  it("narrowed view (showOwnerDetail=true) shows the full detail row", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={BASE_PET} caseCode="CAS-0001-0001" showOwnerDetail={true} />,
    );
    expect(html).toContain("Juana Pérez");
    expect(html).toContain("CAS-0001-0001");
    expect(html).toContain("Ver credencial");
  });
});

// ---------------------------------------------------------------------------
// 3. Legible location — raw coordinates never render as visible text
// ---------------------------------------------------------------------------

describe("LostPetRow — legible location (PO decision 4a)", () => {
  it("never renders the raw decimal coordinates as the link's VISIBLE text (only inside its href)", () => {
    const html = renderToStaticMarkup(<LostPetRow pet={BASE_PET} showOwnerDetail={true} />);
    // The old bug: the coordinate pair rendered as the link's own label text
    // (">-34.9214, -57.9544<"). The coords may still appear inside the map
    // link's href (needed for the pin to work) — only the VISIBLE text must
    // never spell out the raw numbers.
    const oldVisibleFormat = `>${BASE_PET.lastSeenLat.toFixed(4)}, ${BASE_PET.lastSeenLng.toFixed(4)}<`;
    expect(html).not.toContain(oldVisibleFormat);
    expect(html).toContain(`mlat=${BASE_PET.lastSeenLat}`);
  });

  it("renders the legible locality, with a map link alongside (not instead of coordinates)", () => {
    const html = renderToStaticMarkup(<LostPetRow pet={BASE_PET} showOwnerDetail={true} />);
    expect(html).toContain("La Plata");
    expect(html).toContain("openstreetmap.org");
    expect(html).toContain("Ver en el mapa");
  });

  it("with coords but no locality: an 'ubicación aproximada en el mapa' link, not a bare dash", () => {
    const html = renderToStaticMarkup(
      <LostPetRow pet={{ ...BASE_PET, locality: null, province: null }} showOwnerDetail={true} />,
    );
    expect(html).toContain("Ubicación aproximada en el mapa");
    expect(html).not.toContain("—, —");
  });

  it("with neither locality nor coords: an honest 'no registrada' note", () => {
    const html = renderToStaticMarkup(
      <LostPetRow
        pet={{
          ...BASE_PET,
          locality: null,
          province: null,
          lastSeenLat: null,
          lastSeenLng: null,
        }}
        showOwnerDetail={true}
      />,
    );
    expect(html).toContain("Ubicación no registrada");
  });
});
