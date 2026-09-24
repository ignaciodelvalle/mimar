// @vitest-environment jsdom
//
// MapLegends — UX audit 2026-07-26 (finding 5), the blank "Referencias" tab.
//
// Live repro (vista Síntomas, national): both active layers are graduated point
// layers, every in-scope value sits under k=5, so no province ramp, no division
// fill, no resolved graduated scale and no bivariate matrix exist. MapLegends
// answered `return null`, and because the dock renders whatever the pane slot
// gives it, clicking "Referencias" produced a tab whose panel innerText was the
// empty string — measured live:
//
//   {"tab":"Referencias","panel":""}
//
// A named tab that opens onto nothing reads as broken. The section must always
// state what it is and why there is nothing to decode.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MapLegends } from "./MapLegends";

afterEach(cleanup);

describe("MapLegends — the Referencias pane never renders blank", () => {
  it("explains itself when no active layer carries a decodable scale", () => {
    const { container } = render(
      <MapLegends layers={[]} divisionLegend={null} graduatedScale={null} provinceSeqLegend={{}} />,
    );

    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { name: "Referencias" })).toBeInTheDocument();
    expect(screen.getByText(/no hay escalas que decodificar/i)).toBeInTheDocument();
  });
});
