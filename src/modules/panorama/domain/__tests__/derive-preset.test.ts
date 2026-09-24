import { describe, expect, it } from "vitest";
import { deriveActiveComplianceMetric, derivePreset } from "../derive-preset";
import { PANORAMA_PRESETS, getPreset, presetLayerIds, presetLayerIdsWithBase } from "../presets";
import type { EncodingId } from "../view-state";

describe("derivePreset", () => {
  it("derives every preset from its EXACT layer set (auto encoding)", () => {
    // Selecting a preset sets layers to its config; the derived value reports it.
    for (const preset of PANORAMA_PRESETS) {
      expect(derivePreset(presetLayerIds(preset), null, PANORAMA_PRESETS)).toBe(preset.id);
    }
  });

  it("is order- and duplicate-independent (a SET, not a sequence)", () => {
    // brotes-activos = [cobertura, zoonosis]; reversed + duplicated still matches.
    expect(derivePreset(["zoonosis", "cobertura", "cobertura"], null, PANORAMA_PRESETS)).toBe(
      "brotes-activos",
    );
  });

  it("returns null ('personalizada') for a hand-edited set matching no preset", () => {
    // cumplimiento is [cobertura]; adding an unrelated layer leaves every preset.
    expect(derivePreset(["cobertura", "denuncias"], null, PANORAMA_PRESETS)).toBeNull();
    // A partial of a multi-layer preset that is no other preset's full set.
    expect(derivePreset(["zoonosis"], null, PANORAMA_PRESETS)).toBeNull();
  });

  it("returns null for the empty layer set (all layers off)", () => {
    expect(derivePreset([], null, PANORAMA_PRESETS)).toBeNull();
  });

  it("derives HONESTLY to another preset when a chip swap lands on its config", () => {
    // Start on "Señales de brote" ([cobertura, zoonosis]); toggling zoonosis OFF
    // lands on [cobertura] — which IS "cumplimiento"'s exact config. The badge
    // must follow truthfully, not cling to the old preset or force null.
    expect(derivePreset(["cobertura"], null, PANORAMA_PRESETS)).toBe("cumplimiento");
    // And the reverse edit (adding zoonosis to cumplimiento) lands on brotes-activos.
    expect(derivePreset(["cobertura", "zoonosis"], null, PANORAMA_PRESETS)).toBe("brotes-activos");
  });

  it("P5: a preset-DECLARED encoding stays on the preset; an un-owned one is personalizada", () => {
    // brotes-activos declares encodings:["bivariate"] — the "Riesgo" toggle is a
    // display encoding WITHIN the vista, so the badge stays "Señales de brote" and
    // the ?encoding=bivariate deep-link derives honestly.
    expect(derivePreset(["cobertura", "zoonosis"], "bivariate", PANORAMA_PRESETS)).toBe(
      "brotes-activos",
    );
    // An encoding NO preset owns on that set → personalizada.
    const unowned: EncodingId = "glow";
    expect(derivePreset(["cobertura", "zoonosis"], unowned, PANORAMA_PRESETS)).toBeNull();
    // A declared encoding forced onto a DIFFERENT preset's set → that preset does
    // not own it → personalizada (cumplimiento = {cobertura} owns no encodings).
    expect(derivePreset(["cobertura"], "bivariate", PANORAMA_PRESETS)).toBeNull();
  });

  it("panorama-percapita: bienestar owns the percapita encoding; other sets do not", () => {
    // bienestar declares encodings:["percapita"] — the per-10k toggle is a display
    // encoding WITHIN the vista, so the badge stays "Bienestar y fiscalización".
    expect(derivePreset(["denuncias", "decomisos"], "percapita", PANORAMA_PRESETS)).toBe(
      "bienestar",
    );
    // Forced onto a set whose preset does not own it → personalizada.
    expect(derivePreset(["cobertura"], "percapita", PANORAMA_PRESETS)).toBeNull();
    expect(derivePreset(["cobertura", "zoonosis"], "percapita", PANORAMA_PRESETS)).toBeNull();
  });

  it("matches against the passed catalogue only", () => {
    // Empty catalogue → nothing can match.
    expect(derivePreset(["cobertura"], null, [])).toBeNull();
  });

  // D1 metric selector: every metric's layer set stays WITHIN the vista.
  it("derives cumplimiento from EVERY metric option's layer set (metric switch ≠ personalizada)", () => {
    const cumplimiento = getPreset("cumplimiento")!;
    for (const option of cumplimiento.metricOptions!) {
      expect(
        derivePreset(presetLayerIdsWithBase(cumplimiento, option.base), null, PANORAMA_PRESETS),
        option.metric,
      ).toBe("cumplimiento");
    }
  });

  it("still refuses a metric-option set carrying an extra layer (personalizada)", () => {
    expect(derivePreset(["esterilizacion", "denuncias"], null, PANORAMA_PRESETS)).toBeNull();
  });
});

describe("deriveActiveComplianceMetric", () => {
  const cumplimiento = () => getPreset("cumplimiento")!;

  it("reports each option's metric for its exact layer set", () => {
    for (const option of cumplimiento().metricOptions!) {
      expect(
        deriveActiveComplianceMetric(
          presetLayerIdsWithBase(cumplimiento(), option.base),
          cumplimiento(),
        ),
      ).toBe(option.metric);
    }
  });

  it("reports the DEFAULT metric (cobertura) for the preset's own layer set", () => {
    expect(deriveActiveComplianceMetric(presetLayerIds(cumplimiento()), cumplimiento())).toBe(
      "cobertura",
    );
  });

  it("returns null for a set matching no option, and for option-less presets", () => {
    expect(deriveActiveComplianceMetric(["denuncias"], cumplimiento())).toBeNull();
    const bienestar = getPreset("bienestar")!;
    expect(deriveActiveComplianceMetric(presetLayerIds(bienestar), bienestar)).toBeNull();
  });
});
