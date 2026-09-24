// @vitest-environment jsdom
//
// LegendPill — Round-3 QA fix 6: the collapsed strip must convey "what does
// dark mean" (ramp min/max), the bivariate axes, and a graduated size hint —
// WITHOUT opening the panel. Pins the three additions against the plain
// <details><summary> markup (OverlayDisclosure renders both eagerly).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LegendPill } from "./LegendPill";

afterEach(cleanup);

describe("<LegendPill> — collapsed-strip enrichment (Round-3 QA fix 6)", () => {
  it("shows min/max endpoint labels flanking a sequential/meta ramp", () => {
    render(
      <LegendPill
        baseLabel="Cobertura antirrábica"
        rampColors={["#eee", "#ccc", "#999", "#666", "#333"]}
        rampEndpoints={{ min: "0%", max: "70% meta" }}
        layerDots={[]}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("70% meta")).toBeInTheDocument();
  });

  // ⚠️ REWRITTEN (PO 2026-08-01). This case used to assert
  //     expect(screen.getByText("cobertura × señal")).toBeInTheDocument();
  // against a LITERAL hardcoded in LegendPill.tsx, and it passed for every
  // bivariate frame regardless of which pair was on the canvas. It was pinning
  // the defect as the contract: "cobertura × señal" is ONE declared pair's
  // vocabulary (cobertura × zoonosis). On the `riesgo-ppp` vista the matrix
  // crosses registro PPP × mordeduras, and the strip announced axes the map was
  // not crossing — with the map's own popup, two centimetres above it, naming
  // them correctly. `bivariateCaptionText` had already been taught to read the
  // active pair (bivariate.ts, PO validacion-A 2026-07-23); the collapsed strip
  // kept the stale copy, and this test kept it alive.
  it("names the axes the ACTIVE pair declares, not a hardcoded pair", () => {
    render(
      <LegendPill
        baseLabel="Intensidad combinada"
        rampColors={null}
        rampEndpoints={null}
        bivariate
        bivariateAxes="Registro PPP × Mordeduras"
        layerDots={[]}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );

    expect(screen.getByText("Registro PPP × Mordeduras")).toBeInTheDocument();
    // The other pair's vocabulary must be nowhere on the strip.
    expect(screen.queryByText(/cobertura/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/señal/i)).not.toBeInTheDocument();
  });

  it("says nothing about the axes when the pair is unknown", () => {
    // A legend that cannot name what the matrix crosses stays silent; the 3×3
    // glyph still renders (the encoding IS a matrix, which is true regardless).
    const { container } = render(
      <LegendPill
        baseLabel="Intensidad combinada"
        rampColors={null}
        rampEndpoints={null}
        bivariate
        bivariateAxes={null}
        layerDots={[]}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );

    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
    expect(container.querySelector('[title^="Mapa bivariado"]')).toBeInTheDocument();
  });

  it("shows a small/large step hint with real value labels for graduated encodings", () => {
    render(
      <LegendPill
        baseLabel="Eventos por unidad"
        rampColors={null}
        layerDots={[{ color: "#f00", label: "Pérdidas activas" }]}
        graduatedHint={{ small: { r: 5, label: "1" }, large: { r: 30, label: "42" } }}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  // PO 2026-08-01 — "los círculos … no son consistentes con lo mostrado en el
  // mapa". The two hint dots were HARDCODED at 4 px and 10 px: a fixed 2,5×
  // pair that never moved with the data, and whose "large" dot was the exact
  // diameter of the map's SMALLEST bubble (BUBBLE_R_MIN 5 → 10 px across). The
  // prop's own doc promised "bubble radii (px, as rendered on the map)". They
  // cannot BE the map's radii inside a one-line pill (up to 60 px across), so
  // they are scaled down by ONE shared factor — which is what preserves the
  // ratio that carries the meaning.
  function hintDots(container: HTMLElement): number[] {
    return [...container.querySelectorAll<HTMLElement>("span[style*='width']")]
      .map((el) => Number.parseFloat(el.style.width))
      .filter((w) => Number.isFinite(w));
  }

  it("sizes the hint dots from the REAL radii, preserving their on-map ratio", () => {
    // Map radii 5 and 30 → a 6× diameter ratio. Rendered at 14 px max, the
    // small dot must land near 14/6 ≈ 2,3 → floored at the 3 px legibility
    // minimum, and must stay strictly smaller than the large one.
    const { container } = render(
      <LegendPill
        baseLabel="Eventos por unidad"
        rampColors={null}
        layerDots={[]}
        graduatedHint={{ small: { r: 5, label: "1" }, large: { r: 30, label: "42" } }}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );
    const wide = hintDots(container);
    expect(wide).toContain(14);
    expect(Math.min(...wide)).toBeLessThan(14);

    cleanup();

    // A frame whose bubbles barely differ (radii 12 vs 15) must NOT be drawn as
    // the same dramatic step — this is the whole point of deriving the sizes.
    const { container: c2 } = render(
      <LegendPill
        baseLabel="Eventos por unidad"
        rampColors={null}
        layerDots={[]}
        graduatedHint={{ small: { r: 12, label: "1" }, large: { r: 15, label: "3" } }}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );
    const narrow = hintDots(c2);
    expect(narrow).toContain(14);
    // 12/15 of 14 ≈ 11 — visibly closer together than the 6× frame above.
    expect(Math.min(...narrow)).toBeGreaterThan(Math.min(...wide));
  });

  it("cites the bubble colour the map paints when one layer owns it", () => {
    const { container } = render(
      <LegendPill
        baseLabel="Eventos por unidad"
        rampColors={null}
        layerDots={[]}
        graduatedHint={{
          small: { r: 5, label: "1" },
          large: { r: 30, label: "42" },
          color: "#f28e2b",
        }}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );
    // The map fills these circles with `layer.color`; a grey placeholder in the
    // key makes the reader guess that the two marks are the same thing.
    expect(container.innerHTML).toContain("rgb(242, 142, 43)");
  });

  // LIVE PIXEL VERIFICATION 2026-07-30. This case used to read "keeps the k-anon
  // pill visible regardless of the other collapsed hints" and rendered the pill
  // with NO suppression in the frame — it pinned the defect as if it were the
  // contract. Measured on the live console: a 113x25 px "k<5 protegido" chip with
  // a Ley 25.326 tooltip over a canvas with zero hatched units, while MapLegends
  // (same frame) correctly said "Por ahora no hay escalas que decodificar".
  it("shows the k-anon pill when the frame paints a hatch, whatever else is collapsed", () => {
    render(
      <LegendPill baseLabel="Cobertura" rampColors={null} layerDots={[]} suppressedInFrame={true}>
        <div>panel</div>
      </LegendPill>,
    );

    expect(screen.getByText("⊘ k<5 protegido")).toBeInTheDocument();
  });

  it("renders NO k-anon pill when the frame paints no hatch", () => {
    render(
      <LegendPill
        baseLabel="Cobertura"
        rampColors={["#eee", "#333"]}
        layerDots={[{ color: "#f00", label: "Zoonosis / señales" }]}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );

    expect(screen.queryByText("⊘ k<5 protegido")).not.toBeInTheDocument();
    // And the claim is gone in every form: no orphan Ley 25.326 tooltip left
    // announcing a mark the canvas does not paint.
    expect(
      screen.queryByTitle(
        "Unidades con menos de 5 casos: valor suprimido por k-anonimato (Ley 25.326)",
      ),
    ).not.toBeInTheDocument();
    // The rest of the strip is untouched.
    expect(screen.getByText("Cobertura")).toBeInTheDocument();
  });

  it("suppresses a layer dot whose label duplicates the pill title (visual review 2026-07-23 #2)", () => {
    // A graduated point-only view titles the pill with the caption label AND
    // used to repeat the same label as a dot chip ("Denuncias de bienestar •
    // Denuncias de bienestar"). The title is the naming — the duplicate chip
    // must not render (collapsed strip nor expanded repeat); distinct dots stay.
    render(
      <LegendPill
        baseLabel="Denuncias de bienestar"
        rampColors={null}
        layerDots={[
          { color: "#f00", label: "Denuncias de bienestar" },
          { color: "#0f0", label: "Zoonosis / señales" },
        ]}
        suppressedInFrame={false}
      >
        <div>panel</div>
      </LegendPill>,
    );

    // Exactly ONE "Denuncias de bienestar" — the bold title (the dot chip and
    // the expanded repeat would each add another occurrence).
    expect(screen.getAllByText("Denuncias de bienestar")).toHaveLength(1);
    // The non-duplicate dot renders twice: collapsed chip + expanded repeat.
    expect(screen.getAllByText("Zoonosis / señales")).toHaveLength(2);
  });
});
