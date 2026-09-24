// @vitest-environment jsdom
//
// PanoramaSuppressionNotice (panorama-redesign Fase 1) — promotes the k-anon
// badges ("sin localidad" / suppressed cells) out of the "Personalizar"
// disclosure to a first-class element visible without any click.
//
// The notice re-renders the SAME per-layer envelope counts LayerPanel shows
// (suppressedCount / noLocalityCount) — a count OF suppressed cells is not a
// suppressed value, so no k=5 math is touched here (privacy checklist pass).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import { PanoramaSuppressionNotice } from "@/components/panorama/PanoramaSuppressionNotice";
import { PANORAMA_LAYERS } from "@/src/modules/panorama/domain/layers";
import type { LayerId } from "@/src/modules/panorama/domain/types";

afterEach(cleanup);

const IDLE: LayerPanelState = {
  active: false,
  loading: false,
  count: 0,
  suppressedCount: 0,
  noLocalityCount: 0,
  truncated: false,
};

function makeStates(
  overrides: Partial<Record<LayerId, Partial<LayerPanelState>>> = {},
): Record<LayerId, LayerPanelState> {
  const out = {} as Record<LayerId, LayerPanelState>;
  for (const l of PANORAMA_LAYERS) {
    out[l.id] = { ...IDLE, ...(overrides[l.id] ?? {}) };
  }
  return out;
}

describe("PanoramaSuppressionNotice", () => {
  it("renders nothing when both totals are 0", () => {
    const { container } = render(<PanoramaSuppressionNotice states={makeStates()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("sums suppressed cells across ACTIVE non-loading layers", () => {
    const states = makeStates({
      denuncias: { active: true, suppressedCount: 3 },
      mordeduras: { active: true, suppressedCount: 1 },
    });
    render(<PanoramaSuppressionNotice states={states} />);
    // RA-7 F6: the copy now NAMES its universe ("en las capas activas de esta
    // vista"). It is the board's widest protected-cell figure, and the dock
    // publishes narrower ones beside it; unnamed, the smaller numbers read as
    // contradictions instead of subsets.
    expect(
      screen.getByText(
        "4 celdas con menos de 5 casos ocultas por privacidad (k-anonimato) en las capas activas de esta vista",
      ),
    ).toBeInTheDocument();
  });

  it("carries the per-layer breakdown in the title attribute", () => {
    const states = makeStates({
      denuncias: { active: true, suppressedCount: 3 },
      mordeduras: { active: true, suppressedCount: 1 },
    });
    render(<PanoramaSuppressionNotice states={states} />);
    const pill = screen.getByText(/celdas con menos de 5 casos/);
    // Breakdown follows the layer-registry order (mordeduras before denuncias).
    expect(pill).toHaveAttribute(
      "title",
      "Mordeduras / antirrábica: 1 · Denuncias de bienestar: 3",
    );
  });

  it("shows the sin-localidad pill with its own total and breakdown", () => {
    const states = makeStates({
      denuncias: { active: true, noLocalityCount: 7 },
    });
    render(<PanoramaSuppressionNotice states={states} />);
    const pill = screen.getByText(
      "7 registros sin localidad asignada — visibles solo a nivel provincial",
    );
    expect(pill).toHaveAttribute("title", "Denuncias de bienestar: 7");
  });

  it("ignores INACTIVE layers even when they carry counts", () => {
    const states = makeStates({
      denuncias: { active: false, suppressedCount: 9, noLocalityCount: 9 },
    });
    const { container } = render(<PanoramaSuppressionNotice states={states} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores LOADING layers (their envelope is not yet current)", () => {
    const states = makeStates({
      denuncias: { active: true, loading: true, suppressedCount: 9 },
    });
    const { container } = render(<PanoramaSuppressionNotice states={states} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders only the pill whose total is non-zero", () => {
    const states = makeStates({
      denuncias: { active: true, suppressedCount: 2, noLocalityCount: 0 },
    });
    render(<PanoramaSuppressionNotice states={states} />);
    expect(screen.getByText(/celdas con menos de 5 casos/)).toBeInTheDocument();
    expect(screen.queryByText(/sin localidad asignada/)).not.toBeInTheDocument();
  });
});
