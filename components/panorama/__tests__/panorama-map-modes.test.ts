import { describe, expect, it } from "vitest";

import type { ActiveLayer } from "@/components/panorama/SituationalMap";
import {
  bivariateRefusalNoteFor,
  buildMapModeControlModel,
} from "@/components/panorama/panorama-map-modes";
import { BIVARIATE_MIN_UNITS } from "@/src/modules/panorama/domain/bivariate";

const BASE = {
  mapModes: ["auto"] as const,
  activeLayers: [] as ActiveLayer[],
  level: "province" as const,
  scrubbing: false,
  bivariateEligible: false,
  bivariateActive: false,
  bivariateMode: false,
  bivariateDegenerate: false,
  bivariateDegenerateReason: null,
  bivariatePair: null,
  percapitaActive: false,
  percapitaMode: false,
  percapitaEligible: false,
  percapitaLayersEligible: false,
  percapitaHasCensus: false,
};

describe("bivariateRefusalNoteFor", () => {
  it("names the unit threshold when there are too few comparable jurisdictions", () => {
    expect(bivariateRefusalNoteFor("count")).toContain(String(BIVARIATE_MIN_UNITS));
  });

  it("gives a distinct reason per refusal, and none when the cross is viable", () => {
    const notes = (["count", "tercile", "suppressed"] as const).map(bivariateRefusalNoteFor);
    expect(new Set(notes).size).toBe(3);
    expect(bivariateRefusalNoteFor(null)).toBeNull();
  });
});

describe("buildMapModeControlModel", () => {
  it("labels the bivariate mode as reporting intensity, never as risk (C2)", () => {
    const model = buildMapModeControlModel({
      ...BASE,
      mapModes: ["auto", "bivariate"],
      bivariateEligible: true,
    });
    const bivariate = model.options.find((o) => o.id === "bivariate");
    expect(bivariate?.label).toContain("Intensidad de reporte");
    expect(bivariate?.label).not.toMatch(/riesgo/i);
  });

  it("disables bivariate mid-scrub and explains why", () => {
    const model = buildMapModeControlModel({
      ...BASE,
      mapModes: ["auto", "bivariate"],
      bivariateEligible: true,
      scrubbing: true,
    });
    expect(model.options.find((o) => o.id === "bivariate")?.disabled).toBe(true);
    expect(model.note).toContain("solo al último evento");
  });

  it("keeps per cápita VISIBLE but disabled after a drill — never a silent vanish", () => {
    const model = buildMapModeControlModel({
      ...BASE,
      mapModes: ["auto"],
      level: "locality",
      percapitaMode: true,
      percapitaLayersEligible: true,
    });
    const percapita = model.options.find((o) => o.id === "percapita");
    expect(percapita).toBeDefined();
    expect(percapita?.disabled).toBe(true);
    expect(model.note).toContain("Per cápita se calcula por provincia");
  });

  it("shows NO active segment while a selection is suspended", () => {
    const model = buildMapModeControlModel({
      ...BASE,
      mapModes: ["auto", "bivariate"],
      bivariateEligible: true,
      bivariateMode: true,
      scrubbing: true,
    });
    expect(model.value).toBe("");
  });

  it("falls back to 'auto' when the operator has selected no encoding", () => {
    expect(buildMapModeControlModel({ ...BASE, mapModes: ["auto"] }).value).toBe("auto");
  });
});
