// @vitest-environment jsdom
//
// v+1 map review finding #1 (honesty) — clicking a k-anon-suppressed division
// must open the DetailDrawer with the PROTECTED copy, never a bogus "0".
//
// Before the fix, SituationalMap's division click handler passed
// `suppressed: false` unconditionally, so a hatched (protected) barrio rendered
// `String(value ?? 0)` === "0" — indistinguishable from a genuine zero and a
// privacy-honesty regression. The handler now forwards the REAL suppressed state
// (the same set the hatch layer + hover popup read); this test guards the drawer
// end of that contract: given a suppressed division payload, the body shows the
// "Suprimido (privacidad · k‑anon)" branch and never "0".
//
// Testing FeatureBody in isolation (not the full DetailDrawer) avoids the native
// <dialog>.showModal() jsdom gap and the unit-history fetch (which only fires
// when the payload carries a `province` — division clicks never do).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeatureBody } from "@/components/panorama/DetailDrawer";
import { buildChoroplethDetailProps } from "@/components/panorama/map-popup";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/panorama",
}));

afterEach(cleanup);

// The exact shape the (fixed) SituationalMap division click handler emits for a
// suppressed division: locality name, no value, level "locality", suppressed true.
const suppressedDivisionPayload = {
  locality: "Palermo",
  departmentName: "Palermo",
  value: null,
  level: "locality",
  suppressed: true,
} as const;

describe("DetailDrawer FeatureBody — suppressed division (finding #1)", () => {
  it("renders the k-anon protected copy, never '0', for a suppressed cobertura cell", () => {
    render(<FeatureBody layerId="cobertura" properties={{ ...suppressedDivisionPayload }} />);

    // Honest privacy copy — mirrors the suppressed-point drawer branch.
    expect(screen.getByText(/Suprimido \(privacidad · k‑anon\)/)).toBeInTheDocument();
    // The regression sentinel: a suppressed cell must NEVER surface a count.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("still shows the real value for a NON-suppressed division (no over-suppression)", () => {
    render(
      <FeatureBody
        layerId="cobertura"
        properties={{
          locality: "Palermo",
          departmentName: "Palermo",
          value: 42,
          level: "locality",
          suppressed: false,
        }}
      />,
    );

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText(/Suprimido/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RA-7 F1 — the PROVINCE payload, which no test rendered until now.
//
// The suite above fixtures the DIVISION payload, and the division handler was
// the one the #40b fix taught to forward the flag. The province handler kept
// sending `value: cellFor(code).value` and dropped the `.suppressed` the SAME
// lookup returns, so the drawer's guard was dead code on that path: green
// tests, hatched map, "0" in the drawer. These cases fixture what
// `wireProvinceChoroplethInteractions` actually emits.
// ---------------------------------------------------------------------------

/** The province payload SituationalMap emits for a k-anon-protected cell.
 *  Built through the REAL builder the click handler calls, not hand-written:
 *  a literal fixture is exactly how the original defect stayed green — the
 *  suite described a payload the map did not emit. */
const suppressedProvincePayload = buildChoroplethDetailProps({
  level: "province",
  provinceCode: "AR-Z",
  province: "Santa Cruz",
  cell: { value: null, suppressed: true },
});

describe("DetailDrawer FeatureBody — suppressed PROVINCE cell (RA-7 F1)", () => {
  it("renders the protected copy for mortalidad, never a confident '0'", () => {
    render(<FeatureBody layerId="mortalidad" properties={{ ...suppressedProvincePayload }} />);

    expect(screen.getByText(/Suprimido \(privacidad · k‑anon\)/)).toBeInTheDocument();
    // The exact regression: "Mascotas fallecidas: 0" under a hatched province,
    // one click after the popup said "Dato protegido por privacidad".
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText("Santa Cruz")).toBeInTheDocument();
  });

  it("renders the protected copy for cobertura too (any choropleth layer)", () => {
    render(<FeatureBody layerId="cobertura" properties={{ ...suppressedProvincePayload }} />);

    expect(screen.getByText(/Suprimido \(privacidad · k‑anon\)/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("still publishes a real province value (no over-suppression)", () => {
    render(
      <FeatureBody
        layerId="mortalidad"
        properties={buildChoroplethDetailProps({
          level: "province",
          provinceCode: "AR-B",
          province: "Buenos Aires",
          cell: { value: 137, suppressed: false },
        })}
      />,
    );

    expect(screen.getByText("137")).toBeInTheDocument();
    expect(screen.queryByText(/Suprimido/)).not.toBeInTheDocument();
  });

  it("says «Sin datos» — not '0' — for a province the layer carries no cell for", () => {
    // provinceCellAt returns { value: null, suppressed: false } for an absent
    // province; the map stipples it "Sin datos". The drawer used to print "0".
    render(
      <FeatureBody
        layerId="mortalidad"
        properties={buildChoroplethDetailProps({
          level: "province",
          provinceCode: "AR-X",
          province: "Córdoba",
          cell: { value: null, suppressed: false },
        })}
      />,
    );

    expect(screen.getByText("Sin datos")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
