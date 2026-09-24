// @vitest-environment jsdom
//
// Privacy-checklist guard (panorama-redesign Fase 1 — task 4.5).
// AGENTS.md #privacidad-y-manejo-de-datos:
//
//   1. The auto-reading derives ONLY from KpiDelta[] (jurisdiction-level
//      dashboard aggregates). It must never read any other field — a k-anon-
//      suppressed cell value smuggled onto a KPI object must be invisible.
//   2. The reading issues ZERO requests of its own (it reads the already-
//      fetched KPI state).
//   3. The suppression notice shows COUNTS OF SUPPRESSION only (a count of
//      suppressed cells is not a suppressed value) — it never derives a rate
//      or percentage from anything.
//
// The k=5 suppression math itself lives server-side and is untouched by this
// change (no file under src/modules/panorama/application or lib/analytics is
// modified) — asserted by review of the Fase 1 diff, not by this test.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import { PanoramaReading } from "@/components/panorama/PanoramaReading";
import { PanoramaSuppressionNotice } from "@/components/panorama/PanoramaSuppressionNotice";
import { PANORAMA_LAYERS } from "@/src/modules/panorama/domain/layers";
import { buildPanoramaReading } from "@/src/modules/panorama/domain/reading";
import type { LayerId } from "@/src/modules/panorama/domain/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("privacy guard — auto-reading reads deltas ONLY", () => {
  it("produces byte-identical output whether or not decoy cell-level fields are present", () => {
    const bare = [
      { id: "cobertura", delta: { pct: 5, direction: "up" as const } },
      { id: "mordeduras", delta: { pct: -8, direction: "down" as const } },
    ];
    // Same deltas, plus fields that LOOK like suppressed-cell data. If the
    // reading ever consumed them, the outputs would diverge.
    const withDecoys = [
      {
        id: "cobertura",
        delta: { pct: 5, direction: "up" as const },
        // Non-percentage display value: fails the anchor's echo gate (the
        // fast-follow anchor only echoes the strip's own "NN%" aggregates).
        value: "3",
        suppressed: true,
        suppressedCount: 4,
        cellValue: 2, // sub-k=5 style value — must never be read
      },
      {
        id: "mordeduras",
        delta: { pct: -8, direction: "down" as const },
        suppressed: true,
        cellValue: 1,
      },
    ];
    expect(buildPanoramaReading(withDecoys)).toBe(buildPanoramaReading(bare));
  });

  it("the absolute anchor ECHOES the strip's % aggregate; cell-level decoys stay invisible", () => {
    // `value` is the SAME jurisdiction-level display value PanoramaKpiStrip
    // already renders — echoing it is sanctioned (design-QA 2026-07-04 nit 3).
    const withValue = [
      { id: "cobertura", delta: { pct: 5, direction: "up" as const }, value: "42%" },
    ];
    const withValueAndDecoys = [
      { ...withValue[0], suppressed: true, suppressedCount: 4, cellValue: 2 },
    ];
    expect(buildPanoramaReading(withValue)).toContain("cobertura actual 42%");
    // The anchor never computes: byte-identical whether decoys are present.
    expect(buildPanoramaReading(withValueAndDecoys)).toBe(buildPanoramaReading(withValue));
  });

  it("mounts PanoramaReading without issuing ANY network request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <PanoramaReading
        kpis={[{ id: "cobertura", delta: { pct: 5, direction: "up" } }]}
        stale={false}
      />,
    );

    expect(screen.getByText(/Cobertura antirrábica mejora 5%/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("privacy guard — suppression notice shows counts of suppression, never a rate", () => {
  const IDLE: LayerPanelState = {
    active: false,
    loading: false,
    count: 0,
    suppressedCount: 0,
    noLocalityCount: 0,
    truncated: false,
  };

  it("renders only the envelope totals — no percentage, no derived value", () => {
    const states = {} as Record<LayerId, LayerPanelState>;
    for (const l of PANORAMA_LAYERS) states[l.id] = { ...IDLE };
    states.denuncias = {
      ...IDLE,
      active: true,
      count: 120,
      suppressedCount: 4,
      noLocalityCount: 9,
    };

    const { container } = render(<PanoramaSuppressionNotice states={states} />);

    // The two pills carry the raw envelope counts…
    expect(screen.getByText(/^4 celdas con menos de 5 casos/)).toBeInTheDocument();
    expect(screen.getByText(/^9 registros sin localidad/)).toBeInTheDocument();
    // …and NO rate/percentage is ever derived from them (North-Star rejection:
    // never compute a rate from k=5-suppressed cells).
    expect(container.textContent).not.toContain("%");
  });
});
