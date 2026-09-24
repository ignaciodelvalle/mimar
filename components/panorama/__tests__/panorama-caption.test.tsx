// @vitest-environment jsdom
//
// PanoramaCaption — the plain-language per-view caption line (panorama-ia-v2
// §2.4). Thin presentational wrapper over the pure domain builder captionFor:
// it renders the es-AR sentence for the active layer at the derived level, and
// nothing when there is no captionable layer.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { getLayer } from "@/src/modules/panorama/domain/layers";
import type { PanoramaPeriod } from "@/src/modules/panorama/domain/types";

import { PanoramaCaption } from "../PanoramaCaption";

const period90d: PanoramaPeriod = { from: "2026-04-05", to: "2026-07-04" };

afterEach(cleanup);

describe("PanoramaCaption", () => {
  it("renders the plain caption for the active rate layer at province level", () => {
    render(
      <PanoramaCaption layer={getLayer("cobertura") ?? null} level="province" period={period90d} />,
    );
    expect(
      screen.getByText(
        "Cada área es una provincia. Relleno = cobertura antirrábica, estado actual. Meta 80%.",
      ),
    ).toBeInTheDocument();
  });

  it("recomputes for a density layer at locality level (context switch)", () => {
    render(
      <PanoramaCaption
        layer={getLayer("mordeduras") ?? null}
        level="locality"
        period={period90d}
      />,
    );
    expect(
      screen.getByText(
        "Cada burbuja es una división (departamento/partido, o barrio en CABA). Tamaño = eventos de mordedura / antirrábica, últimos 90 días.",
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing when there is no captionable layer", () => {
    const { container } = render(
      <PanoramaCaption layer={null} level="province" period={period90d} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
