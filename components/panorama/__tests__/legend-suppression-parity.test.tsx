// The two legend surfaces must agree with the CANVAS about the k-anon mark.
//
// LIVE PIXEL VERIFICATION 2026-07-30 (a2-05-FINDING-legendpill-announces-
// unpainted-mark.png). In one measured frame:
//   · LegendPill  → rendered «⊘ k<5 protegido» (113×25 px, tooltip citing
//                   Ley 25.326) with ZERO hatched marks on the canvas.
//   · MapLegends  → correctly omitted its k-anon rows and said "Por ahora no
//                   hay escalas que decodificar".
// Two surfaces, one frame, opposite claims. The pill was unconditional by
// design ("NEVER hidden"), which reads as privacy diligence but is the mirror
// of the disclosure bug it looks like: announcing a mark the map does not paint
// teaches the operator that the legend does not describe the canvas — and the
// notice they learn to skip is the privacy one.
//
// This file pins the COUPLING, not one component: for the same frame, both
// surfaces are driven by the same `frameHasSuppressedMark` / `layerPaintsHatch`
// atoms, so they cannot drift apart again. A per-component test could not have
// caught the original defect — each one was internally consistent.

import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegendPill } from "@/components/panorama/LegendPill";
import { MapLegends } from "@/components/panorama/MapLegends";
import type { ActiveLayer, DivisionLegendDescriptor } from "@/components/panorama/SituationalMap";
import type { GraduatedScale } from "@/components/panorama/graduated-scale";
import { frameHasSuppressedMark, layerPaintsHatch } from "@/components/panorama/hatch-pattern";
import { hasSuppressedProvince } from "@/components/panorama/province-choropleth-style";
import type { BivariateCell } from "@/src/modules/panorama/domain/bivariate";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";

// EVERY wording MapLegends uses to name the k-anon mark, CONDITIONALLY — i.e.
// rendered only when THIS FRAME actually paints a suppressed unit. RA-7 F3:
// this file used to grep for the hatch row alone, so the FOURTH key — the
// graduated block's muted-dot row, which says something else entirely — was
// invisible to the parity check that exists precisely so no key can drift
// from the canvas. A legend key added with new copy and no entry here is
// caught by `every rendered k-anon key is one this test knows about`, below.
const K_ANON_KEYS = ["Protegido por privacidad", "Datos insuficientes (privacidad)"] as const;

// T4.1 (2026-08-01): "Cómo leer las marcas" is an ALWAYS-rendered glossary
// block (independent of `anyLegend` and of whether this frame suppresses
// anything) that explains the SAME hatch mark in prose. Its wording must NOT
// be added to `K_ANON_KEYS` above: that array drives `legendsClaim` below,
// which means "this frame's surfaces claim a suppression happened" — folding
// in copy that is present on EVERY frame would make `legendsClaim` true
// unconditionally, exactly the disclosure bug this whole file exists to
// catch, just introduced from the opposite direction. Tracked separately so
// the source-scan sanity check (which enumerates every "privacidad" mention)
// still accounts for it without corrupting the per-frame claim.
const GLOSSARY_PRIVACY_COPY = ["protegido por privacidad"] as const;
const PILL_CHIP = "k&lt;5 protegido";

/** The suppressed DOT the graduated bubble layers paint (COLOR_SUPPRESSED). */
const GRADUATED_SCALE: GraduatedScale = {
  maxValue: 40,
  bins: [
    { value: 1, label: "1", r: 3 },
    { value: 10, label: "10", r: 6 },
    { value: 40, label: "40", r: 10 },
  ],
  radiusStops: [
    [0, 3],
    [40, 10],
  ],
};

function provinceFC(
  cells: Array<{ provinceCode: string; value: number | null; suppressed?: boolean }>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      geometry: null,
      properties: {
        provinceCode: c.provinceCode,
        province: c.provinceCode,
        value: c.value,
        suppressed: c.suppressed === true,
      },
    })),
  };
}

function provinceLayer(
  cells: Array<{ provinceCode: string; value: number | null; suppressed?: boolean }>,
): ActiveLayer {
  return {
    id: "cobertura",
    color: "#59a14f",
    label: "Cobertura antirrábica (perros, 12m)",
    geomType: "choropleth",
    level: "province",
    dataType: "rate",
    complianceTarget: 80,
    features: provinceFC(cells),
  } as ActiveLayer;
}

function bivariateCell(provinceCode: string, suppressed: boolean): BivariateCell {
  return {
    provinceCode,
    place: provinceCode,
    coverageValue: suppressed ? null : 55,
    signalValue: suppressed ? null : 12,
    coverageClass: suppressed ? null : 2,
    signalClass: suppressed ? null : 2,
    suppressed,
  };
}

function bivariateLayer(cells: BivariateCell[]): ActiveLayer {
  return {
    id: "brotes",
    color: "#e15759",
    label: "Señales de brote",
    geomType: "choropleth",
    level: "province",
    features: provinceFC(cells.map((c) => ({ provinceCode: c.provinceCode, value: null }))),
    bivariateCells: cells,
  } as unknown as ActiveLayer;
}

/** A GRADUATED point layer — síntomas / zoonosis / denuncias / mordeduras /
 *  pérdidas. Its features carry `place` / `locality` / `province` and NEVER a
 *  `provinceCode`: that absence is exactly what made `hasSuppressedProvince`
 *  skip every one of them and answer false for the whole family (RA-7 F3). The
 *  fixture keeps the missing code, or it would not reproduce the defect. */
function graduatedLayer(
  units: Array<{ place: string; count: number | null; suppressed?: boolean }>,
): ActiveLayer {
  return {
    id: "sintomas",
    color: "#f28e2b",
    label: "Síntomas reportados",
    geomType: "point",
    renderMode: "graduated",
    level: "locality",
    dataType: "signal",
    features: {
      type: "FeatureCollection",
      features: units.map((u) => ({
        type: "Feature",
        geometry: null,
        properties: {
          place: u.place,
          locality: u.place,
          province: "Buenos Aires",
          count: u.count,
          suppressed: u.suppressed === true,
        },
      })),
    },
  } as unknown as ActiveLayer;
}

function divisionLegend(suppressed: boolean): DivisionLegendDescriptor {
  return {
    label: "Cobertura antirrábica (perros, 12m)",
    unitNoun: "departamento",
    min: 1,
    max: 40,
    hasRamp: true,
    breaks: [10, 20, 30],
    colors: ["#eef", "#ccd", "#99a", "#667"],
    suppressed,
  };
}

/** Render BOTH surfaces over ONE frame, exactly as PanoramaConsole wires them:
 *  the pill's gate is `frameHasSuppressedMark` over the same layers + lifted
 *  division legend MapLegends receives.
 *
 *  RA-7 F3 — the graduated scale is DERIVED from the frame, never hardcoded.
 *  This helper used to pass `graduatedScale={null}` unconditionally, which made
 *  the whole graduated legend block unreachable: the one k-anon key in this file
 *  with no gate at all could not be rendered by the very test whose purpose is
 *  that no key drifts from the canvas. A frame with graduated layers now gets a
 *  resolved scale, exactly as the console gives it one. */
function renderFrame(layers: ActiveLayer[], division: DivisionLegendDescriptor | null) {
  const suppressedInFrame = frameHasSuppressedMark(layers, division);
  const graduatedScale = layers.some((l) => l.renderMode === "graduated") ? GRADUATED_SCALE : null;
  const pill = renderToStaticMarkup(
    <LegendPill
      baseLabel="Cobertura antirrábica (perros, 12m)"
      rampColors={["#eef", "#667"]}
      layerDots={[]}
      suppressedInFrame={suppressedInFrame}
    >
      <div>panel</div>
    </LegendPill>,
  );
  const legends = renderToStaticMarkup(
    <MapLegends
      layers={layers}
      divisionLegend={division}
      graduatedScale={graduatedScale}
      provinceSeqLegend={{}}
    />,
  );
  return {
    suppressedInFrame,
    pillClaims: pill.includes(PILL_CHIP),
    // ANY of the four keys counts as "the legend named the mark" — the surfaces
    // must agree about the CLAIM, not about which glyph carries it.
    legendsClaim: K_ANON_KEYS.some((k) => legends.includes(k)),
    legendsHtml: legends,
  };
}

describe("a frame with ZERO suppressed features names the k-anon mark NOWHERE", () => {
  it("province choropleth, every cell visible — neither surface claims a hatch", () => {
    const frame = renderFrame(
      [
        provinceLayer([
          { provinceCode: "AR-B", value: 61 },
          { provinceCode: "AR-X", value: 44 },
        ]),
      ],
      null,
    );
    expect(frame.suppressedInFrame).toBe(false);
    expect(frame.pillClaims).toBe(false);
    expect(frame.legendsClaim).toBe(false);
  });

  it("division fill with no suppressed unit — neither surface claims a hatch", () => {
    const frame = renderFrame([provinceLayer([{ provinceCode: "AR-B", value: 61 }])], {
      ...divisionLegend(false),
    });
    expect(frame.suppressedInFrame).toBe(false);
    expect(frame.pillClaims).toBe(false);
    expect(frame.legendsClaim).toBe(false);
  });

  it("bivariate frame with no suppressed cell — neither surface claims a hatch", () => {
    // The bivariate k-anon row in MapLegends was the LAST unconditional one in
    // that file; before this fix it printed the hatch key on every bivariate
    // frame, suppressed or not.
    const frame = renderFrame(
      [bivariateLayer([bivariateCell("AR-B", false), bivariateCell("AR-X", false)])],
      null,
    );
    expect(frame.suppressedInFrame).toBe(false);
    expect(frame.pillClaims).toBe(false);
    expect(frame.legendsClaim).toBe(false);
  });

  it("graduated bubbles with no suppressed unit — neither surface claims a mark", () => {
    // RA-7 F3, direction ONE. The graduated block's k-anon key had no gate at
    // all, so it announced the protected dot on every graduated frame. This test
    // could not see it: renderFrame hardcoded `graduatedScale={null}`, which
    // made the entire block unreachable.
    const frame = renderFrame(
      [
        graduatedLayer([
          { place: "Lanús", count: 31 },
          { place: "Quilmes", count: 12 },
        ]),
      ],
      null,
    );
    expect(frame.suppressedInFrame).toBe(false);
    expect(frame.pillClaims).toBe(false);
    expect(frame.legendsClaim).toBe(false);
    // Named explicitly: the graduated key's wording is NOT the hatch row's, and
    // grepping for the hatch row alone is how this key hid for so long.
    expect(frame.legendsHtml).not.toContain("Datos insuficientes (privacidad)");
    // ...while the block itself IS rendering (otherwise the assertion above is
    // vacuous — the exact way the old `graduatedScale={null}` faked a pass).
    expect(frame.legendsHtml).toContain("Eventos por unidad");
  });

  it("empty frame (nothing painting at all) — neither surface claims a hatch", () => {
    const frame = renderFrame([], null);
    expect(frame.suppressedInFrame).toBe(false);
    expect(frame.pillClaims).toBe(false);
    expect(frame.legendsClaim).toBe(false);
  });
});

describe("a frame that DOES paint a hatch names it on BOTH surfaces", () => {
  it("a suppressed province cell", () => {
    const frame = renderFrame(
      [
        provinceLayer([
          { provinceCode: "AR-B", value: 61 },
          { provinceCode: "AR-Z", value: null, suppressed: true },
        ]),
      ],
      null,
    );
    expect(frame.suppressedInFrame).toBe(true);
    expect(frame.pillClaims).toBe(true);
    expect(frame.legendsClaim).toBe(true);
  });

  it("a suppressed division unit (locality grain — no province cell to read)", () => {
    const frame = renderFrame([], divisionLegend(true));
    expect(frame.suppressedInFrame).toBe(true);
    expect(frame.pillClaims).toBe(true);
    expect(frame.legendsClaim).toBe(true);
  });

  it("a suppressed bivariate cell", () => {
    const frame = renderFrame(
      [bivariateLayer([bivariateCell("AR-B", false), bivariateCell("AR-Z", true)])],
      null,
    );
    expect(frame.suppressedInFrame).toBe(true);
    expect(frame.pillClaims).toBe(true);
    expect(frame.legendsClaim).toBe(true);
  });

  it("a suppressed GRADUATED bubble (a muted dot is a mark too)", () => {
    // RA-7 F3, direction TWO — the opposite failure, same encoding. The map DOES
    // publish a protected mark here: SituationalMap paints the dot
    // COLOR_SUPPRESSED at 0.6 opacity with its own stroke and collapses it to
    // BUBBLE_R_MIN. `layerPaintsHatch` fell through to `hasSuppressedProvince`,
    // which skips every feature without a `provinceCode` — graduated features
    // have none — so the pill's gate was false and the pill stayed silent over a
    // frame that was marking protected units on screen.
    const frame = renderFrame(
      [
        graduatedLayer([
          { place: "Lanús", count: 31 },
          { place: "Tandil", count: null, suppressed: true },
        ]),
      ],
      null,
    );
    expect(frame.suppressedInFrame).toBe(true);
    expect(frame.pillClaims).toBe(true);
    expect(frame.legendsClaim).toBe(true);
    expect(frame.legendsHtml).toContain("Datos insuficientes (privacidad)");
  });
});

describe("layerPaintsHatch reads each surface's OWN carrier", () => {
  // The two carriers are genuinely different and a single generic rule would be
  // wrong: a bivariate layer's `features` have no `suppressed` flag (the k-anon
  // propagation lives on `bivariateCells`), and an ordinary province layer has
  // no cells. Reading the wrong one silently answers false.
  it("bivariate suppression is read off bivariateCells, not features", () => {
    const layer = bivariateLayer([bivariateCell("AR-Z", true)]);
    expect(
      layer.features.features.every(
        (f) => (f.properties as { suppressed?: boolean }).suppressed !== true,
      ),
      "fixture: the bivariate layer's features carry no suppressed flag",
    ).toBe(true);
    expect(layerPaintsHatch(layer)).toBe(true);
  });

  it("province suppression is read off the feature flag", () => {
    expect(layerPaintsHatch(provinceLayer([{ provinceCode: "AR-B", value: 61 }]))).toBe(false);
    expect(
      layerPaintsHatch(provinceLayer([{ provinceCode: "AR-Z", value: null, suppressed: true }])),
    ).toBe(true);
  });

  it("graduated suppression is read off the feature flag DESPITE no provinceCode", () => {
    const layer = graduatedLayer([{ place: "Tandil", count: null, suppressed: true }]);
    expect(
      layer.features.features.every(
        (f) => (f.properties as { provinceCode?: string }).provinceCode === undefined,
      ),
      "fixture: graduated features carry no provinceCode — the reason the old rule skipped them",
    ).toBe(true);
    // The pre-fix rule (hasSuppressedProvince) answers false on this exact layer.
    expect(hasSuppressedProvince(layer.features)).toBe(false);
    // The fixed rule reads the carrier the graduated renderer actually paints.
    expect(layerPaintsHatch(layer)).toBe(true);
    expect(layerPaintsHatch(graduatedLayer([{ place: "Lanús", count: 31 }]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The check that keeps this file honest as MapLegends grows.
//
// RA-7 F3's root cause was not a missing gate — it was that the parity test
// COULD NOT SEE the ungated key: it grepped for one wording and rendered a frame
// in which the block carrying the other wording was unreachable. A fifth key
// added tomorrow with fresh copy would hide the same way. So the wordings are
// enumerated, and the enumeration is checked against the component's source.
// ---------------------------------------------------------------------------
describe("K_ANON_KEYS covers every k-anon key MapLegends can render", () => {
  it("no rendered privacy copy escapes the enumeration", () => {
    const source = readFileSync(new URL("../MapLegends.tsx", import.meta.url), "utf8");
    const rendered = source
      .split(/\r?\n/)
      .filter((line) => /privacidad/i.test(line))
      .filter((line) => !line.trimStart().startsWith("//"));
    // Sanity: the five keys are actually in there (a zero-length list would make
    // the loop below vacuously pass — the failure mode this whole file is about).
    expect(rendered.length).toBeGreaterThanOrEqual(5);
    // Every "privacidad" mention must be accounted for by EITHER set: a
    // conditional claim key (drives `legendsClaim`) or the always-rendered
    // glossary copy (never should — see the comment on GLOSSARY_PRIVACY_COPY).
    const knownWordings = [...K_ANON_KEYS, ...GLOSSARY_PRIVACY_COPY];
    for (const line of rendered) {
      expect(
        knownWordings.some((k) => line.includes(k)),
        `MapLegends renders privacy copy this parity test does not know about: ${line.trim()}`,
      ).toBe(true);
    }
  });
});
