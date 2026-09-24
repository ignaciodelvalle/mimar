// Unit tests for the pinned situational-map popup builders (pure, no maplibre).

import { describe, expect, it } from "vitest";

import {
  COUNT_READOUT_SUFFIX,
  buildChoroplethDetailProps,
  buildLayerReadout,
  buildPinnedPopupHtml,
  countReadoutLabel,
  divisionReadoutDataType,
  formatMetaGap,
  formatNegativeGap,
  formatSignedGap,
  formatValueWithUnit,
} from "../map-popup";

// A "rate" layer is only a rate at PROVINCE level. Drilled to a division the
// repository swaps the metric to a raw count-density (a per-division rate would
// expose both k-anonymised arms), and the legend and caption already say so.
// The pinned popup did not: it passed the layer's STATIC dataType through, so a
// drilled count of 11205 rendered "11.205%" and got measured against "meta 80%"
// while the drawer beside it showed the same value unit-less. QA ronda 5
// (2026-07-16) read that as the map contradicting the panel — the panel was
// right and the popup was inventing a unit.
describe("divisionReadoutDataType", () => {
  it("demotes a rate layer to a count at division level", () => {
    expect(divisionReadoutDataType("rate")).toBe("density");
  });

  it("leaves non-rate types untouched", () => {
    expect(divisionReadoutDataType("density")).toBe("density");
    expect(divisionReadoutDataType("signal")).toBe("signal");
    expect(divisionReadoutDataType("reference")).toBe("reference");
    expect(divisionReadoutDataType(undefined)).toBeUndefined();
  });

  it("a drilled coverage count renders with no percent and no compliance meta", () => {
    const readout = buildLayerReadout({
      label: "Cobertura antirrábica",
      value: 11205,
      dataType: divisionReadoutDataType("rate"),
      complianceTarget: undefined,
    });
    expect(readout.valueText).toBe("11.205");
    expect(readout.valueText).not.toContain("%");
    expect(readout.metaText).toBeUndefined();
  });

  it("province level keeps the percentage and the meta — the rate IS a rate there", () => {
    const readout = buildLayerReadout({
      label: "Cobertura antirrábica",
      value: 64.4,
      dataType: "rate",
      complianceTarget: 80,
    });
    expect(readout.valueText).toBe("64,4%");
    expect(readout.metaText).toBe("meta 80% · −15,6");
  });
});

// The drilled department popup shows a rate layer's raw COUNT ("72"); the scope-level
// side panel shows the same layer's percentage ("64,3%"). SAME label, different unit —
// both QA testers (2026-07-16) flagged it as not comparable. The PO fix differentiates
// the LABELS, not the data: the demoted count keeps its name + "(conteo)"; the scope %
// label is untouched.
describe("countReadoutLabel", () => {
  it("appends the (conteo) qualifier when the value is a demoted count", () => {
    expect(countReadoutLabel("Cobertura antirrábica", true)).toBe("Cobertura antirrábica (conteo)");
    expect(countReadoutLabel("Cobertura antirrábica", true)).toContain(COUNT_READOUT_SUFFIX);
  });

  it("leaves the label verbatim when the value is NOT demoted (the scope % keeps its label)", () => {
    expect(countReadoutLabel("Cobertura antirrábica", false)).toBe("Cobertura antirrábica");
  });
});

describe("buildLayerReadout — demoted count label", () => {
  it("a drilled rate count carries the (conteo) label AND no % / meta", () => {
    const readout = buildLayerReadout({
      label: "Cobertura antirrábica",
      value: 72,
      dataType: divisionReadoutDataType("rate"),
      complianceTarget: undefined,
      demotedToCount: true,
    });
    expect(readout.label).toBe("Cobertura antirrábica (conteo)");
    expect(readout.valueText).toBe("72");
    expect(readout.valueText).not.toContain("%");
    expect(readout.metaText).toBeUndefined();
  });

  it("the scope-level percentage readout keeps the plain label (no (conteo))", () => {
    const readout = buildLayerReadout({
      label: "Cobertura antirrábica",
      value: 64.3,
      dataType: "rate",
      complianceTarget: 80,
      // demotedToCount omitted → the scope % is untouched.
    });
    expect(readout.label).toBe("Cobertura antirrábica");
    expect(readout.valueText).toBe("64,3%");
    expect(readout.metaText).toBe("meta 80% · −15,7");
  });

  it("a demoted count that is k-anon suppressed still carries the (conteo) label", () => {
    const readout = buildLayerReadout({
      label: "Cobertura antirrábica",
      value: null,
      suppressed: true,
      demotedToCount: true,
    });
    expect(readout.label).toBe("Cobertura antirrábica (conteo)");
    expect(readout.state).toBe("suppressed");
  });
});

describe("formatValueWithUnit", () => {
  it("renders a rate value as an es-AR percentage", () => {
    expect(formatValueWithUnit(64.4, "rate")).toBe("64,4%");
    expect(formatValueWithUnit(80, "rate")).toBe("80%");
  });

  it("renders a count value as a grouped es-AR number with no unit", () => {
    expect(formatValueWithUnit(1234, "density")).toBe("1.234");
    expect(formatValueWithUnit(5, undefined)).toBe("5");
  });

  it("per-cápita branch: a tiny-but-real rate reads '<0,01', never a fake 0 (F2)", () => {
    // A per-10k density value ≈ 0,00057 (count 1 over Buenos Aires) must not paint
    // "0" in the popup — the honest small-rate display takes over.
    expect(formatValueWithUnit(0.00057, "density", true)).toBe("<0,01");
    expect(formatValueWithUnit(0.5026, "density", true)).toBe("0,50");
    // Non-per-cápita density formatting is byte-identical (no forced decimals).
    expect(formatValueWithUnit(1234, "density", false)).toBe("1.234");
  });
});

describe("buildLayerReadout — per-cápita display (F2)", () => {
  it("renders a positive-but-tiny per-10k rate as '<0,01' in the pinned readout", () => {
    const readout = buildLayerReadout({
      label: "Denuncias de bienestar (por 10.000 hab.)",
      value: 0.00057,
      dataType: "density",
      perCapita: true,
    });
    expect(readout.valueText).toBe("<0,01");
    expect(readout.state).toBeUndefined();
  });

  it("leaves a non-per-cápita density readout byte-identical", () => {
    const readout = buildLayerReadout({ label: "Zoonosis", value: 1234, dataType: "density" });
    expect(readout.valueText).toBe("1.234");
  });
});

describe("formatMetaGap", () => {
  it("formats a below-target gap with a unicode minus", () => {
    // 64,4 against meta 80 → −15,6.
    expect(formatMetaGap(64.4, 80)).toBe("meta 80% · −15,6");
  });

  it("formats an above-target gap with a plus", () => {
    expect(formatMetaGap(92, 80)).toBe("meta 80% · +12");
  });
});

describe("buildLayerReadout", () => {
  it("carries the value WITH unit and the meta+gap for a rate layer", () => {
    const r = buildLayerReadout({
      label: "Cobertura antirrábica",
      value: 64.4,
      dataType: "rate",
      complianceTarget: 80,
    });
    expect(r.valueText).toBe("64,4%");
    expect(r.metaText).toBe("meta 80% · −15,6");
    expect(r.state).toBeUndefined();
  });

  it("marks a suppressed cell as protected (no number)", () => {
    const r = buildLayerReadout({ label: "Zoonosis", value: null, suppressed: true });
    expect(r.valueText).toBeNull();
    expect(r.state).toBe("suppressed");
  });

  it("marks a null non-suppressed cell as no-data", () => {
    const r = buildLayerReadout({ label: "Zoonosis", value: null });
    expect(r.valueText).toBeNull();
    expect(r.state).toBe("nodata");
  });
});

describe("buildPinnedPopupHtml", () => {
  it("names EVERY active layer in a multi-layer readout", () => {
    const html = buildPinnedPopupHtml({
      place: "Buenos Aires",
      readouts: [
        buildLayerReadout({
          label: "Cobertura",
          value: 64.4,
          dataType: "rate",
          complianceTarget: 80,
        }),
        buildLayerReadout({ label: "Zoonosis", value: 1234, dataType: "density" }),
      ],
    });
    // Both layers are labeled with their own value (not one shared metric).
    expect(html).toContain("Cobertura");
    expect(html).toContain("64,4%");
    expect(html).toContain("meta 80% · −15,6");
    expect(html).toContain("Zoonosis");
    expect(html).toContain("1.234");
  });

  it("renders dialog semantics, the place title, and the Ver detalle affordance", () => {
    const html = buildPinnedPopupHtml({
      place: "Palermo",
      readouts: [buildLayerReadout({ label: "Zoonosis", value: 3, dataType: "density" })],
      cutoffLabel: "Al 30/6/2026",
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Detalle de Palermo"');
    expect(html).toContain("Al 30/6/2026");
    expect(html).toContain("data-pano-detail");
    expect(html).toContain("Ver detalle");
  });

  it("omits the Ver detalle affordance when withDetail is false", () => {
    const html = buildPinnedPopupHtml({
      place: "Palermo",
      readouts: [],
      withDetail: false,
    });
    expect(html).not.toContain("data-pano-detail");
  });

  it("escapes untrusted place + layer names", () => {
    const html = buildPinnedPopupHtml({
      place: "<img src=x onerror=alert(1)>",
      readouts: [buildLayerReadout({ label: "<b>x</b>", value: 1, dataType: "density" })],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
  });

  it("shows the protected copy for a suppressed readout, never a number", () => {
    const html = buildPinnedPopupHtml({
      place: "Comuna 1",
      readouts: [buildLayerReadout({ label: "Zoonosis", value: null, suppressed: true })],
    });
    expect(html).toContain("k-anonimato");
    expect(html).not.toMatch(/pano-pin-value/);
  });
});

// P4-F1: the ranking table and the row preview hand-rolled `−${gap.toFixed(1)}`
// — a DOT decimal on a console where every other number carries the es-AR
// comma, and an ASCII hyphen where the typographic minus belongs.
describe("formatNegativeGap — an already-computed shortfall", () => {
  it("uses the es-AR decimal comma", () => {
    expect(formatNegativeGap(15.6)).toContain("15,6");
    expect(formatNegativeGap(15.6)).not.toContain("15.6");
  });

  it("uses the Unicode minus, not a hyphen", () => {
    expect(formatNegativeGap(15.6).startsWith("−")).toBe(true);
    expect(formatNegativeGap(15.6).startsWith("-")).toBe(false);
  });

  it("keeps one decimal — a 0,4 gap must not round to zero", () => {
    expect(formatNegativeGap(0.4)).toBe("−0,4");
  });

  it("agrees with formatSignedGap on the same shortfall", () => {
    // 80 against a target of 95,6 is a 15,6-point gap either way.
    expect(formatSignedGap(80, 95.6)).toBe(formatNegativeGap(15.6));
  });
});

// RA-7 F1 — the "Ver detalle →" payload. The province click handler forwarded
// `cellFor(code).value` and threw the `.suppressed` from the SAME lookup away,
// so the DetailDrawer's k-anon guard was dead code on that path: the map
// hatched the province, the popup said "Dato protegido", and the drawer said
// "Mascotas fallecidas: 0". Both grains now go through ONE builder that takes
// the CELL, so a caller cannot forward the number without the flag.
describe("buildChoroplethDetailProps — the flag travels with the value", () => {
  it("carries suppressed:true for a protected PROVINCE cell (the F1 regression)", () => {
    const props = buildChoroplethDetailProps({
      level: "province",
      provinceCode: "AR-Z",
      province: "Santa Cruz",
      cell: { value: null, suppressed: true },
    });
    expect(props.suppressed).toBe(true);
    expect(props.value).toBeNull();
    expect(props.level).toBe("province");
    expect(props.province).toBe("Santa Cruz");
  });

  it("carries suppressed:false — explicitly, never undefined — for a published cell", () => {
    // `undefined` is the shape that broke it: `properties.suppressed === true`
    // is false for BOTH states, so an absent key reads exactly like "publicable".
    const props = buildChoroplethDetailProps({
      level: "province",
      provinceCode: "AR-B",
      province: "Buenos Aires",
      cell: { value: 137, suppressed: false },
    });
    expect(props.suppressed).toBe(false);
    expect(props.suppressed).not.toBeUndefined();
    expect(props.value).toBe(137);
  });

  it("keeps a null value NULL — the drawer must not read it as a measured 0", () => {
    const props = buildChoroplethDetailProps({
      level: "province",
      provinceCode: "AR-X",
      province: "Córdoba",
      cell: { value: null, suppressed: false },
    });
    expect(props.value).toBeNull();
    expect(props.value).not.toBe(0);
  });

  it("carries the flag at LOCALITY grain too (the division handler's contract)", () => {
    const props = buildChoroplethDetailProps({
      level: "locality",
      locality: "Palermo",
      departmentName: "Palermo",
      province: "CABA",
      cell: { value: null, suppressed: true },
    });
    expect(props.suppressed).toBe(true);
    expect(props.level).toBe("locality");
    expect(props.locality).toBe("Palermo");
  });

  it("emits `suppressed` at EVERY grain — the parity the two handlers used to break", () => {
    const grains = [
      buildChoroplethDetailProps({
        level: "province",
        provinceCode: "AR-B",
        province: "Buenos Aires",
        cell: { value: 1, suppressed: false },
      }),
      buildChoroplethDetailProps({
        level: "locality",
        locality: "Palermo",
        departmentName: "Palermo",
        province: "CABA",
        cell: { value: 1, suppressed: false },
      }),
    ];
    for (const props of grains) {
      expect(Object.hasOwn(props, "suppressed")).toBe(true);
    }
  });
});
