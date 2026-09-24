// P2-2 — the printed informe does not render the structure of something empty,
// and never hides a declaration to do it.
//
// PO principle P2: don't render the structure of something empty — hide it, or
// show the MINIMUM. The ranking card already obeys it (6fb4b4eb, via the
// tri-state in src/modules/panorama/domain/data-availability.ts). Two sections
// of this printed briefing did not: "Indicadores" and "Capas de la vista" both
// printed a heading followed by a sentence restating their own absence.
//
// THE LIMIT these tests exist to pin (same one the tri-state encodes): there are
// several kinds of empty and only ONE of them may be hidden.
//
//   ABSENT      → hide. Nothing was measured, nothing withheld, nothing broke.
//   FAILURE     → DECLARE. `kpisDegradedText` means the fan-out could not be
//                 computed; dropping it in silence prints an all-clear over
//                 "we are blind" on a document a funcionario files to justify a
//                 decision.
//   SUPPRESSED  → DECLARE. k-anonymity withheld values; the note stays.
//
// A hide that ever swallowed a failure or a suppression would be a worse defect
// than the empty structure it removed, which is why each hide below is tested
// against its non-absent siblings, not only against the happy path.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanoramaInformeSituacion } from "@/components/panorama/PanoramaInformeSituacion";
import { type BuildInformeInput, buildInformeModel } from "@/components/panorama/panorama-informe";

function baseInput(overrides: Partial<BuildInformeInput> = {}): BuildInformeInput {
  return {
    scopeLabel: "Nacional",
    periodLabel: "últimos 90 días",
    asOf: null,
    generatedAt: null,
    isDemo: false,
    viewSummary: "Vista personalizada — Argentina (todas las provincias), últimos 90 días.",
    kpis: [
      {
        id: "cobertura",
        label: "Cobertura antirrábica",
        value: "64%",
        currentState: true,
        info: { definition: "Porcentaje de perros del padrón con vacunación antirrábica." },
      },
    ],
    kpisDegraded: false,
    ranking: null,
    caption: "Cada área es una provincia. Relleno = cobertura antirrábica, estado actual.",
    activeLayerLabels: ["Cobertura antirrábica"],
    suppressedTotal: 0,
    ...overrides,
  };
}

const render = (input: Partial<BuildInformeInput> = {}) =>
  renderToStaticMarkup(<PanoramaInformeSituacion model={buildInformeModel(baseInput(input))} />);

describe("Informe · Indicadores — absent hides, failure declares", () => {
  it("prints the section when there are indicators", () => {
    const html = render();
    expect(html).toContain("Indicadores");
    expect(html).toContain("Cobertura antirrábica");
  });

  it("drops the whole section when there is nothing to indicate (ABSENT)", () => {
    // The builder emits `kpis: []` with no degraded text only when this view has
    // no indicators at all. Heading + "Sin indicadores para esta vista." is
    // structure over nothing.
    const html = render({ kpis: [] });
    expect(html).not.toContain("Indicadores");
    expect(html).not.toContain("Sin indicadores para esta vista");
  });

  it("KEEPS the section when the fan-out FAILED — a failure is not an absence", () => {
    // The one hiding rule that would be a trust defect. `kpisDegraded` sets
    // `kpis: []` too, so a naive `kpis.length === 0` hide would swallow it.
    const html = render({ kpisDegraded: true });
    expect(html).toContain("Indicadores");
    expect(html).toContain("No pudimos calcular los indicadores");
  });

  it("declares the failure even with an empty KPI list — the two empties differ", () => {
    const absent = render({ kpis: [] });
    const failed = render({ kpis: [], kpisDegraded: true });
    expect(absent).not.toContain("Indicadores");
    expect(failed).toContain("Indicadores");
  });
});

describe("Informe · Capas de la vista — absent hides, caption keeps", () => {
  it("prints the layers when the operator turned some on", () => {
    const html = render();
    expect(html).toContain("Capas de la vista");
    expect(html).toContain("Cobertura antirrábica");
  });

  it("drops the section when there are no layers AND no caption (ABSENT)", () => {
    const html = render({ activeLayerLabels: [], caption: null });
    expect(html).not.toContain("Capas de la vista");
    expect(html).not.toContain("Sin capas activas");
  });

  it("keeps the section for the caption alone — it describes what the map showed", () => {
    const html = render({ activeLayerLabels: [], caption: "Cada área es una provincia." });
    expect(html).toContain("Capas de la vista");
    expect(html).toContain("Cada área es una provincia.");
  });
});

describe("Informe · what P2 may never remove", () => {
  it("the k-anon disclosure survives every empty section", () => {
    // The whole point of the ABSENT/SUPPRESSED split. Strip the informe down to
    // nothing hideable and the privacy declaration is still printed.
    const html = render({ kpis: [], activeLayerLabels: [], caption: null, ranking: null });
    expect(html).not.toContain("Indicadores");
    expect(html).not.toContain("Capas de la vista");
    expect(html.toLowerCase()).toContain("k-anon");
  });

  it("the ranking's suppression note is never hidden by an empty ranking", () => {
    // Zero printable rows, but units DID report and k-anon withheld them: the
    // section stays so the note stays (the rule 6fb4b4eb established).
    const html = render({
      ranking: {
        rows: [],
        kind: "rate",
        measureLabel: "cobertura antirrábica",
        smallScope: false,
        unitNoun: "jurisdicciones",
        suppressedCount: 3,
        unavailable: false,
      },
    });
    expect(html).toContain("protegid");
  });
});
