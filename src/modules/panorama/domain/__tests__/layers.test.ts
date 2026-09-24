// Unit tests for the Panorama layer registry (pure domain).

import { describe, expect, it } from "vitest";

import {
  AGGREGATED_POINT_IDS,
  AGGREGATED_POINT_LAYERS,
  CHOROPLETH_LAYERS,
  NATIONAL_DEPARTMENT_GRAIN_IDS,
  PANORAMA_LAYERS,
  POINTS_LAYER_IDS,
  POINT_LAYERS,
  REFERENCE_LAYERS,
  TEMPORAL_LAYERS,
  aggregationBadgeLabel,
  getLayer,
  isAggregatedPointLayer,
  isLayerId,
  isNationalDepartmentGrain,
  isPointsLayer,
  isTemporalLayer,
} from "@/src/modules/panorama/domain/layers";
import type { LayerDataType, LayerPrivacy } from "@/src/modules/panorama/domain/types";

describe("PANORAMA_LAYERS registry", () => {
  it("has the 19 v2 layers with unique ids", () => {
    expect(PANORAMA_LAYERS).toHaveLength(19);
    const ids = PANORAMA_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(19);
  });

  it("every layer declares a unique color (legend swatch collisions confuse the map)", () => {
    const colors = PANORAMA_LAYERS.map((l) => l.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  // Cursor red-team 2026-07-23 (claim #3): a drilled division-fill paints raw
  // COUNTS, not the rate `label` names (division-fill.ts sums per-unit
  // values). Every rate layer must declare a count-truthful `countLabel` that
  // drops the rate stems ("Cobertura"/"Penetración"/"Registro") that would
  // misname a headcount as a percentage once " (conteo)" is appended
  // (components/panorama/panorama-labels.ts's legendRampTitle).
  // WIDENED 2026-07-28 (P1-F1): this keyed on `dataType`, which describes how the
  // layer is CLASSED, not what its values ARE. acceso-veterinario carries a rate
  // (actos/1.000) but is classed "density" because it has no compliance target,
  // so it slipped past and the drill legend printed
  // "Acceso veterinario (actos/1.000) (conteo) · 5 → 2.184" — a rate title over a
  // count. `valueKind` is the honest key: any layer whose per-unit value is a
  // rate needs a name for what the count-fallback actually counts.
  it("every rate-VALUED layer declares a count-truthful countLabel (no rate-implying stem)", () => {
    const rateStems = ["Cobertura", "Penetración", "Registro"];
    for (const layer of CHOROPLETH_LAYERS) {
      const isRateValued = layer.dataType === "rate" || layer.valueKind === "rate";
      if (!isRateValued) continue;
      expect(
        layer.countLabel,
        `${layer.id} carries a rate value but has no countLabel — its drill legend would name a headcount with a rate title`,
      ).toBeTruthy();
      for (const stem of rateStems) {
        expect(layer.countLabel?.includes(stem)).toBe(false);
      }
    }
  });

  it("every layer declares all required fields with valid values", () => {
    const validGeom = new Set(["point", "choropleth"]);
    const validPrivacy = new Set<LayerPrivacy>(["none", "coarse", "gated"]);
    const validDataType = new Set<LayerDataType>(["rate", "density", "signal", "reference"]);
    for (const layer of PANORAMA_LAYERS) {
      expect(layer.label.length).toBeGreaterThan(0);
      expect(layer.source.length).toBeGreaterThan(0);
      expect(validGeom.has(layer.geomType)).toBe(true);
      expect(validPrivacy.has(layer.privacy)).toBe(true);
      expect(layer.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(typeof layer.scopeFilterable).toBe("boolean");
      expect(validDataType.has(layer.dataType)).toBe(true);
    }
  });

  it("partitions cleanly into point (9) and choropleth (10) layers", () => {
    expect(POINT_LAYERS).toHaveLength(9);
    expect(CHOROPLETH_LAYERS).toHaveLength(10);
    expect(POINT_LAYERS.length + CHOROPLETH_LAYERS.length).toBe(PANORAMA_LAYERS.length);
  });

  it("draws denuncias coarse (spec §8 PII) — no exact coordinate in the layer", () => {
    expect(getLayer("denuncias")?.privacy).toBe("coarse");
  });

  it("sources every choropleth rollup from lib/metrics (k-anon denominator)", () => {
    for (const layer of CHOROPLETH_LAYERS) {
      expect(layer.source.startsWith("metrics:")).toBe(true);
    }
  });

  it("makes every layer scope-filterable (govt intersects its jurisdiction)", () => {
    expect(PANORAMA_LAYERS.every((l) => l.scopeFilterable)).toBe(true);
  });

  it("panorama-ia-v2: every layer declares renderPolicy, suppressionStyle and caption", () => {
    const validMode = new Set(["choropleth-fill", "graduated-symbol", "clustered-points"]);
    const validSuppression = new Set(["muted", "hatched"]);
    const validWindow = new Set(["period", "current"]);
    for (const layer of PANORAMA_LAYERS) {
      // renderPolicy — both levels declared with a valid mark.
      expect(validMode.has(layer.renderPolicy.province)).toBe(true);
      expect(validMode.has(layer.renderPolicy.locality)).toBe(true);
      // suppressionStyle.
      expect(validSuppression.has(layer.suppressionStyle)).toBe(true);
      // caption — unit per level, non-empty measure, valid window.
      expect(layer.caption.unit.province.length).toBeGreaterThan(0);
      expect(layer.caption.unit.locality.length).toBeGreaterThan(0);
      expect(layer.caption.measure.length).toBeGreaterThan(0);
      expect(validWindow.has(layer.caption.window)).toBe(true);
    }
  });

  it("panorama-ia-v2: rate + mortalidad suppress with hatch; density/reference muted", () => {
    // Rate layers + mortalidad must hatch (spatial honesty on the choropleth).
    expect(getLayer("cobertura")?.suppressionStyle).toBe("hatched");
    expect(getLayer("esterilizacion")?.suppressionStyle).toBe("hatched");
    expect(getLayer("microchip")?.suppressionStyle).toBe("hatched");
    expect(getLayer("ppp")?.suppressionStyle).toBe("hatched");
    expect(getLayer("mortalidad")?.suppressionStyle).toBe("hatched");
    // Density-point + signal + reference layers are muted.
    for (const id of [
      "perdidas",
      "mordeduras",
      "denuncias",
      "zoonosis",
      "sintomas",
      "reunificacion",
      "refugios",
      "clinicas",
      "decomisos",
    ] as const) {
      expect(getLayer(id)?.suppressionStyle).toBe("muted");
    }
  });

  it("panorama-ia-v2: aggregated layers force province below the locality zoom threshold", () => {
    // Every non-reference layer sets autoLevel → province below zoom 5 (kills the blob).
    for (const layer of PANORAMA_LAYERS) {
      if (layer.dataType === "reference") {
        expect(layer.renderPolicy.autoLevel).toBeUndefined();
      } else {
        expect(layer.renderPolicy.autoLevel).toEqual({ belowZoom: 5, level: "province" });
      }
    }
  });

  it("marks event-windowable layers temporal and current-state ones not (F4)", () => {
    // Temporal: the event-based point layers (perdidas, mordeduras, denuncias,
    // zoonosis, decomisos, sintomas, reunificacion).
    const temporalIds = TEMPORAL_LAYERS.map((l) => l.id).sort();
    expect(temporalIds).toEqual(
      [
        "decomisos",
        "denuncias",
        "mordeduras",
        "perdidas",
        "zoonosis",
        "sintomas",
        "reunificacion",
        // desierto-veterinario: a period-windowed RECENCY choropleth ("as of t"
        // the last vet visit was N days back) — temporal, unlike its
        // current-state choropleth siblings.
        "desierto-veterinario",
        // tendencia: two period-derived event windows — temporal (asOf shifts both).
        "tendencia",
      ].sort(),
    );
    // Non-temporal: refugios (no time) + the three current-state choropleths.
    expect(isTemporalLayer("refugios")).toBe(false);
    expect(isTemporalLayer("cobertura")).toBe(false);
    expect(isTemporalLayer("esterilizacion")).toBe(false);
    expect(isTemporalLayer("mortalidad")).toBe(false);
    expect(isTemporalLayer("perdidas")).toBe(true);
  });
});

describe("F1 dataType taxonomy (Panorama v2)", () => {
  it("each layer has exactly one dataType from the valid set", () => {
    const validDataType = new Set<LayerDataType>(["rate", "density", "signal", "reference"]);
    for (const layer of PANORAMA_LAYERS) {
      expect(validDataType.has(layer.dataType)).toBe(true);
    }
  });

  it("assigns dataType correctly per layer", () => {
    expect(getLayer("cobertura")?.dataType).toBe("rate");
    expect(getLayer("esterilizacion")?.dataType).toBe("rate");
    expect(getLayer("microchip")?.dataType).toBe("rate");
    expect(getLayer("ppp")?.dataType).toBe("rate");
    expect(getLayer("mortalidad")?.dataType).toBe("density");
    expect(getLayer("perdidas")?.dataType).toBe("density");
    expect(getLayer("mordeduras")?.dataType).toBe("density");
    expect(getLayer("denuncias")?.dataType).toBe("density");
    expect(getLayer("sintomas")?.dataType).toBe("density");
    expect(getLayer("zoonosis")?.dataType).toBe("signal");
    expect(getLayer("reunificacion")?.dataType).toBe("signal");
    expect(getLayer("refugios")?.dataType).toBe("reference");
    expect(getLayer("clinicas")?.dataType).toBe("reference");
    expect(getLayer("decomisos")?.dataType).toBe("reference");
  });

  /**
   * WAS "rate layers declare a complianceTarget; NON-RATE layers do not".
   *
   * The second half was locking in a conflation, not a rule: it read `dataType`
   * — which decides the AGGREGATION path — as if it also decided whether a value
   * has a meta to be read against. `indice-territorial` pays for that: a 0-100
   * attainment score routed as a density, and therefore denied the meta scale
   * and the gap ranking that are the only honest way to read it (the mean of
   * three target-attainments is 100 exactly when the three metas are met).
   *
   * What must stay pinned is the real constraint: a target is an ATTAINMENT
   * floor, so it may only be declared where reaching a higher value is the goal.
   * A count / duration / delta layer declaring one would paint policy fiction —
   * there is no "meta de mordeduras" and no meta for days without vet activity.
   */
  it("F5: every rate layer declares a positive complianceTarget", () => {
    for (const layer of PANORAMA_LAYERS) {
      if (layer.dataType !== "rate") continue;
      expect(
        layer.complianceTarget,
        `${layer.id} is a rate layer and must declare complianceTarget`,
      ).toBeTypeOf("number");
      expect(
        (layer.complianceTarget as number) > 0,
        `${layer.id} complianceTarget must be positive`,
      ).toBe(true);
    }
  });

  it("F5: a non-rate layer may declare a target only if higher is better", () => {
    for (const layer of PANORAMA_LAYERS) {
      if (layer.dataType === "rate" || layer.complianceTarget === undefined) continue;
      expect(
        layer.higherIsBetter,
        `${layer.id} declares a complianceTarget, so a HIGHER value must be the goal: a target on a count/duration/delta layer would be an invented meta`,
      ).toBe(true);
      expect(
        (layer.complianceTarget as number) > 0,
        `${layer.id} complianceTarget must be positive`,
      ).toBe(true);
    }
  });

  it("polarity: only the two higher-is-better layers declare it", () => {
    const declared = PANORAMA_LAYERS.filter((l) => l.higherIsBetter === true).map((l) => l.id);
    // The default (absent) means "more of this is worse", which is the correct
    // reading for every harm count, for days without vet activity and for the
    // event delta. Only these two invert it — and both are documented in the
    // registry with why. A new layer added here without a rationale is a bug.
    expect(declared.sort()).toEqual(["acceso-veterinario", "indice-territorial"]);
  });

  it("F5: cobertura complianceTarget is 80 (antirrábica legal goal)", () => {
    expect(getLayer("cobertura")?.complianceTarget).toBe(80);
  });

  it("F5: esterilizacion complianceTarget is 70 (TARGETS.STERILIZATION_COVERAGE_PCT)", () => {
    expect(getLayer("esterilizacion")?.complianceTarget).toBe(70);
  });

  it("F5: microchip complianceTarget is 80 (TARGETS.MICROCHIP_PENETRATION_PCT)", () => {
    expect(getLayer("microchip")?.complianceTarget).toBe(80);
  });

  it("F5: ppp complianceTarget is 80 (program benchmark, no legal target)", () => {
    expect(getLayer("ppp")?.complianceTarget).toBe(80);
  });

  it("AGGREGATED_POINT_LAYERS contains the 6 density+signal point layers", () => {
    // perdidas, mordeduras, denuncias, sintomas (density) + zoonosis, reunificacion (signal).
    // Does NOT include refugios/decomisos (reference) or the choropleth layers.
    const ids = AGGREGATED_POINT_LAYERS.map((l) => l.id).sort();
    expect(ids).toEqual(
      ["denuncias", "mordeduras", "perdidas", "zoonosis", "sintomas", "reunificacion"].sort(),
    );
  });

  it("AGGREGATED_POINT_IDS and isAggregatedPointLayer are consistent", () => {
    for (const layer of PANORAMA_LAYERS) {
      const expected = AGGREGATED_POINT_IDS.has(layer.id);
      expect(isAggregatedPointLayer(layer.id)).toBe(expected);
    }
  });

  it("POINTS_LAYER_IDS: near-zoom real-dot layers are perdidas + mordeduras + denuncias; zoonosis is NOT", () => {
    // panorama-event-points tiers: perdidas (Slice 1 sightings), mordeduras
    // (Slice 2 operator-scoped incidents), denuncias (Slice 3 locality centroid).
    // Zoonosis is deliberately excluded — outbreak_signal writers persist no
    // columnar coordinate, so there is nothing to plot (plan §5 tier decision).
    const ids = [...POINTS_LAYER_IDS].sort();
    expect(ids).toEqual(["denuncias", "mordeduras", "perdidas"].sort());
    expect(isPointsLayer("zoonosis")).toBe(false);
    expect(isPointsLayer("perdidas")).toBe(true);
    expect(isPointsLayer("mordeduras")).toBe(true);
    expect(isPointsLayer("denuncias")).toBe(true);
    // Reference layers never plot event dots.
    expect(isPointsLayer("refugios")).toBe(false);
    expect(isPointsLayer("decomisos")).toBe(false);
  });

  it("every POINTS_LAYER_IDS member declares renderPolicy.points = clustered-points", () => {
    for (const id of POINTS_LAYER_IDS) {
      expect(getLayer(id)?.renderPolicy.points).toBe("clustered-points");
    }
  });

  it("NATIONAL_DEPARTMENT_GRAIN_IDS: only zoonosis renders department grain at national", () => {
    // PO 2026-07-16: the national overview draws one bubble per DEPARTMENT for
    // zoonosis (urban departments get medium circles, the rest small/distributed),
    // instead of one fixed point per province.
    expect([...NATIONAL_DEPARTMENT_GRAIN_IDS].sort()).toEqual(["zoonosis"]);
    expect(isNationalDepartmentGrain("zoonosis")).toBe(true);
    // Density point layers stay one-point-per-province at national (byte-identical) —
    // they are NOT members, so the shared view level is never dragged for them.
    expect(isNationalDepartmentGrain("perdidas")).toBe(false);
    expect(isNationalDepartmentGrain("mordeduras")).toBe(false);
    expect(isNationalDepartmentGrain("denuncias")).toBe(false);
    expect(isNationalDepartmentGrain("sintomas")).toBe(false);
    expect(isNationalDepartmentGrain("reunificacion")).toBe(false);
    // Choropleths and the province-only composite are unaffected.
    expect(isNationalDepartmentGrain("cobertura")).toBe(false);
    expect(isNationalDepartmentGrain("indice-territorial")).toBe(false);
  });

  it("zoonosis is national-department-grain AND still NOT points-capable (orthogonal axes)", () => {
    // Department grain is an AGGREGATION choice, never real event dots: outbreak_signal
    // persists no columnar coordinate, so zoonosis stays out of POINTS_LAYER_IDS.
    expect(isNationalDepartmentGrain("zoonosis")).toBe(true);
    expect(isPointsLayer("zoonosis")).toBe(false);
    expect(POINTS_LAYER_IDS.has("zoonosis")).toBe(false);
  });

  it("REFERENCE_LAYERS contains refugios, clinicas and decomisos", () => {
    const ids = REFERENCE_LAYERS.map((l) => l.id).sort();
    expect(ids).toEqual(["clinicas", "decomisos", "refugios"].sort());
  });

  it("partition: AGGREGATED_POINT + REFERENCE covers every point layer", () => {
    const allPointIds = POINT_LAYERS.map((l) => l.id).sort();
    const aggregatedAndReference = [...AGGREGATED_POINT_LAYERS, ...REFERENCE_LAYERS]
      .map((l) => l.id)
      .sort();
    // The title used to say "all 8 point layers" while POINT_LAYERS held 9
    // (H8.4). A hardcoded number in a title drifts silently; a hardcoded number
    // in an ASSERTION does not — and it also stops this partition from passing
    // vacuously with both sides empty.
    expect(allPointIds).toHaveLength(9);
    expect(aggregatedAndReference).toEqual(allPointIds);
  });
});

describe("aggregationBadgeLabel — honest map-grain badge (recorrido-80 residual)", () => {
  it("names the base grain below the national rollup, regardless of layers", () => {
    // Locality without a province scope.
    expect(
      aggregationBadgeLabel({
        level: "locality",
        selectedProvinceCode: null,
        activeLayerIds: ["zoonosis"],
      }),
    ).toBe("Localidades");
    // Drilled into a province → the division noun (CABA is comunas).
    expect(
      aggregationBadgeLabel({
        level: "locality",
        selectedProvinceCode: "AR-B",
        activeLayerIds: ["zoonosis"],
      }),
    ).toBe("Departamentos/partidos");
    expect(
      aggregationBadgeLabel({
        level: "locality",
        selectedProvinceCode: "AR-C",
        activeLayerIds: ["zoonosis"],
      }),
    ).toBe("Comunas");
  });

  it("national rollup with NO finer-grain layer → plain 'Provincias'", () => {
    expect(
      aggregationBadgeLabel({
        level: "province",
        selectedProvinceCode: null,
        activeLayerIds: ["perdidas", "cobertura"],
      }),
    ).toBe("Provincias");
  });

  it("national rollup where EVERY aggregating layer is finer-grain → 'Departamentos'", () => {
    expect(
      aggregationBadgeLabel({
        level: "province",
        selectedProvinceCode: null,
        activeLayerIds: ["zoonosis"],
      }),
    ).toBe("Departamentos");
    // Reference pins (refugios) don't establish a province grain → still Departamentos.
    expect(
      aggregationBadgeLabel({
        level: "province",
        selectedProvinceCode: null,
        activeLayerIds: ["zoonosis", "refugios"],
      }),
    ).toBe("Departamentos");
  });

  it("national rollup with MIXED grains → compound label naming the finer layer", () => {
    // The exact case the QA hit: zoonosis (departments) + a province-grain density layer.
    expect(
      aggregationBadgeLabel({
        level: "province",
        selectedProvinceCode: null,
        activeLayerIds: ["zoonosis", "perdidas"],
      }),
    ).toBe("Provincias · Zoonosis: departamentos");
    // A province-grain choropleth alongside zoonosis triggers the same compound.
    expect(
      aggregationBadgeLabel({
        level: "province",
        selectedProvinceCode: null,
        activeLayerIds: ["cobertura", "zoonosis"],
      }),
    ).toBe("Provincias · Zoonosis: departamentos");
  });
});

describe("getLayer / isLayerId", () => {
  it("getLayer returns the entry for each known id", () => {
    expect(getLayer("perdidas")?.label).toBe("Pérdidas / avistajes");
    expect(getLayer("mortalidad")?.geomType).toBe("choropleth");
  });

  it("isLayerId guards arbitrary strings (e.g. a route param)", () => {
    expect(isLayerId("mortalidad")).toBe(true);
    expect(isLayerId("perdidas")).toBe(true);
    expect(isLayerId("../../etc/passwd")).toBe(false);
    expect(isLayerId("escaneos")).toBe(false); // deferred to v2
    expect(isLayerId("")).toBe(false);
  });
});

describe("layer descriptions (task #38 Filtro method notes)", () => {
  it("every layer carries a non-empty es-AR method line", () => {
    for (const layer of PANORAMA_LAYERS) {
      expect(layer.description.length, `${layer.id} description`).toBeGreaterThan(20);
    }
  });

  it("the denuncias note is honest about coarse (centroid) location", () => {
    expect(getLayer("denuncias")?.description).toMatch(/centroide|localidad/i);
  });
});

/**
 * `valueKind` — what a per-unit value MEANS, and therefore whether the dock may
 * sum it into "Registros".
 *
 * The bug this locks was live on 2026-07-25: the dock defined its summable set
 * by EXCLUSION (everything that is not `dataType: "rate"`), so layers whose
 * values are rates, signed deltas or durations were added up as if they were
 * rows. The console showed "Registros −13.288" (Tendencia), "Registros 1.394,7"
 * (Pérdidas y reunificación) and "Registros 2.138" (Desierto veterinario). A
 * negative or fractional record count on a government console discredits every
 * other number on the screen.
 */
describe("PanoramaLayer.valueKind — only counts are summable", () => {
  const kindOf = (id: string) => PANORAMA_LAYERS.find((l) => l.id === id)?.valueKind ?? "count";

  it("marks every layer whose per-unit value is NOT a row count", () => {
    expect(kindOf("tendencia")).toBe("delta");
    expect(kindOf("reunificacion")).toBe("rate");
    expect(kindOf("acceso-veterinario")).toBe("rate");
    // WAS "duration" — the layer measured days since the last veterinary act.
    // It now measures the SHARE of active pets with no act in the period (PO
    // 2026-07-26), which is a percentage: still not summable, but for a new
    // reason. Summing days produced "Registros 2.138"; summing percentages
    // would produce an equally meaningless number, so the declaration stays.
    expect(kindOf("desierto-veterinario")).toBe("rate");
    expect(kindOf("indice-territorial")).toBe("index");
  });

  it("leaves the genuine event layers summable", () => {
    for (const id of [
      "perdidas",
      "mordeduras",
      "denuncias",
      "zoonosis",
      "sintomas",
      "mortalidad",
    ]) {
      expect(kindOf(id), id).toBe("count");
    }
  });

  it("a layer whose own measure names a non-count unit must declare it", () => {
    // The real guard: `?? "count"` means an omission is SILENTLY summable, so a
    // future layer measuring days/percentages/indices would reintroduce the bug.
    // The layer's own es-AR measure text gives it away — use that as the tell.
    const NON_COUNT_MEASURE = /tasa|%|d[íi]as|[íi]ndice|por 1\.000|por 10\.000|variaci[óo]n/i;
    for (const l of PANORAMA_LAYERS) {
      if (l.dataType === "rate" || l.dataType === "reference") continue;
      if (!NON_COUNT_MEASURE.test(l.caption.measure)) continue;
      expect(l.valueKind, `${l.id} measures "${l.caption.measure}"`).toBeDefined();
      expect(l.valueKind, l.id).not.toBe("count");
    }
  });

  it("a delta-encoded layer is never summable", () => {
    for (const l of PANORAMA_LAYERS) {
      if (l.deltaEncoded) expect(l.valueKind, l.id).toBe("delta");
    }
  });
});
