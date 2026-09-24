// PANORAMA VIEWSTATE P2 — capability-gate cross-check (task #65 / WS-4).
//
// The sibling the characterization net (view-projection.characterization.test.ts)
// promised: it asserts `capabilitiesFor(viewState, runtime)` REPRODUCES the exact
// composed projection the console/map decide today, for a matrix of
// (preset × scope × zoom). This is the guard that would have caught the coherence
// drifts 5/5 times — if a future edit makes the gate disagree with the registry
// (a rate layer that should be META rendering sequential, a temporal layer that
// should light the scrubber leaving it dark, bivariate offered off-registry), a
// cell here goes red.
//
// The gate is the SINGLE source those decisions now read (isMeta ×4, the
// bivariate string-gate, the temporal aggregate). This test locks its output to
// the same registry facts the characterization fence pins — so P2's migration is
// provably behavior-preserving.
//
// Pure — no DB, no React, no maplibre. Deterministic.

import { describe, expect, it } from "vitest";

import {
  LOD_PROVINCE_ROLLUP_HINT,
  ZOOM_REPRESENTATIONS,
  bivariateEligibleFor,
  capabilitiesFor,
  isMetaLayer,
  lodProvinceRollupHint,
  markForZoom,
} from "@/src/modules/panorama/domain/capabilities";
import { getLayer, isTemporalLayer } from "@/src/modules/panorama/domain/layers";
import { percapitaEligibleFor } from "@/src/modules/panorama/domain/percapita";
import {
  PANORAMA_PRESETS,
  type PanoramaPreset,
  presetLayerIds,
} from "@/src/modules/panorama/domain/presets";
import type {
  AggregationLevel,
  PanoramaLayer,
  PanoramaScope,
} from "@/src/modules/panorama/domain/types";
import type { EncodingId } from "@/src/modules/panorama/domain/view-state";
import { makeViewState, scopeFromFilter } from "@/src/modules/panorama/domain/view-state";

// ---------------------------------------------------------------------------
// The same matrix the characterization fence uses (identical scopes + zooms), so
// the gate is checked against the pinned projection cell-for-cell.
// ---------------------------------------------------------------------------

const SCOPES: Record<string, PanoramaScope> = {
  national: { country: "AR" },
  province: { country: "AR", province: "AR-C" },
  locality: { country: "AR", province: "AR-C", locality: "Palermo" },
};
const ZOOMS = [3, 7, 11] as const;

/** The STATIC base encoding kind the gate resolves (design §3 — P2 resolves kind;
 *  the near-zoom "points" swap + the "bivariate" toggle are runtime bands layered
 *  on top, asserted separately below). */
function expectedEncodingKind(base: PanoramaLayer): EncodingId {
  if (base.geomType === "choropleth") {
    return isMetaLayer(base) ? "choropleth-meta" : "choropleth-seq";
  }
  if (base.dataType === "reference") return "reference";
  return "graduated";
}

/** Build the gate output for one matrix cell exactly as the console would: layers
 *  = the preset's activation set, level = the SCOPE-derived axis (P4c, design
 *  §5.5 — a committed province/locality reads the locality axis; national reads
 *  province at ANY zoom; the camera no longer drives the data axis). */
function gateFor(preset: PanoramaPreset, scopeKey: string, zoom: number) {
  const scope = SCOPES[scopeKey];
  const layers = presetLayerIds(preset);
  const level: AggregationLevel =
    scope.province != null || scope.locality != null ? "locality" : "province";
  const view = makeViewState({ scope: scopeFromFilter(scope), layers });
  return { level, layers, caps: capabilitiesFor(view, { zoom, level }) };
}

describe("capabilitiesFor — registry cross-check (P2 gate)", () => {
  it("reproduces level, encoding, temporal + bivariate gating for the full matrix", () => {
    for (const preset of PANORAMA_PRESETS) {
      const base = getLayer(preset.base) as PanoramaLayer;
      for (const scopeKey of Object.keys(SCOPES)) {
        for (const zoom of ZOOMS) {
          const { level, layers, caps } = gateFor(preset, scopeKey, zoom);
          const where = `${preset.id}/${scopeKey}/z${zoom}`;

          // level — echoed single source.
          expect(caps.level, `level ${where}`).toBe(level);

          // encoding.kind — the isMeta ×4 replacement.
          expect(caps.encoding.kind, `encoding ${where}`).toBe(expectedEncodingKind(base));
          expect(caps.encoding.suppression, `suppression ${where}`).toBe(base.suppressionStyle);

          // temporal — the scrubber aggregate + timeline representation.
          const anyTemporal = layers.some((id) => isTemporalLayer(id));
          expect(caps.allowedControls.scrubber, `scrubber ${where}`).toBe(anyTemporal);
          expect(caps.allowedRepresentations.includes("timeline"), `timeline ${where}`).toBe(
            anyTemporal,
          );
          expect(caps.allowedRepresentations).toContain("registros");
          expect(caps.allowedRepresentations).toContain("stats");

          // bivariate — the preset-string-free registry predicate.
          expect(caps.allowedControls.bivariateEligible, `bivariate ${where}`).toBe(
            bivariateEligibleFor(layers, level),
          );

          // inset adopts the SAME encoding the main map paints (never a 2nd fill).
          expect(caps.insetBehavior.encoding, `inset ${where}`).toEqual(caps.encoding);
          expect(caps.insetBehavior.visible, `inset-vis ${where}`).toBe(level === "province");
        }
      }
    }
  });

  // --- Invariant spot-checks (mirror the characterization fence, via the gate) --

  it("bivariate is eligible ONLY for a DECLARED pair's layer set at province", () => {
    // The two pair-owning presets at national→province framing.
    const brotes = PANORAMA_PRESETS.find((p) => p.id === "brotes-activos")!;
    expect(gateFor(brotes, "national", 3).caps.allowedControls.bivariateEligible).toBe(true);
    const crucePpp = PANORAMA_PRESETS.find((p) => p.id === "cruce-mordeduras-ppp")!;
    expect(gateFor(crucePpp, "national", 3).caps.allowedControls.bivariateEligible).toBe(true);
    // province scope forces locality level → not eligible.
    expect(gateFor(brotes, "province", 7).caps.allowedControls.bivariateEligible).toBe(false);
    expect(gateFor(crucePpp, "province", 7).caps.allowedControls.bivariateEligible).toBe(false);
    // No OTHER preset matches a declared pair (cumplimiento has a rate+target
    // base but NO overlay; sintomas/bienestar/perdidas have a non-rate base).
    for (const preset of PANORAMA_PRESETS) {
      if (preset.id === "brotes-activos" || preset.id === "cruce-mordeduras-ppp") continue;
      for (const scopeKey of Object.keys(SCOPES)) {
        expect(
          gateFor(preset, scopeKey, 3).caps.allowedControls.bivariateEligible,
          `${preset.id}/${scopeKey}`,
        ).toBe(false);
      }
    }
  });

  it("encoding.kind: rate-with-target → choropleth-meta; density choropleth → choropleth-seq; point base → graduated", () => {
    expect(gateFor(getPreset("cumplimiento"), "national", 3).caps.encoding.kind).toBe(
      "choropleth-meta",
    );
    // D1: the esterilizacion METRIC OPTION of cumplimiento (ex control-poblacional)
    // is the same rate-with-target shape → meta.
    const esterilizacionView = makeViewState({ layers: ["esterilizacion"] });
    expect(capabilitiesFor(esterilizacionView, { zoom: 3, level: "province" }).encoding.kind).toBe(
      "choropleth-meta",
    );
    expect(gateFor(getPreset("bienestar"), "national", 3).caps.encoding.kind).toBe("graduated");
    // mortalidad is a density CHOROPLETH (no target) → sequential, not meta.
    const mortView = makeViewState({ layers: ["mortalidad"] });
    expect(capabilitiesFor(mortView, { zoom: 3, level: "province" }).encoding.kind).toBe(
      "choropleth-seq",
    );
  });

  it("scrubber follows the presence of a temporal (event-windowable) active layer", () => {
    // cumplimiento (cobertura only — a current-state rate) has NO temporal layer.
    expect(gateFor(getPreset("cumplimiento"), "national", 3).caps.allowedControls.scrubber).toBe(
      false,
    );
    // brotes-activos (cobertura + zoonosis) — zoonosis IS temporal → scrubber on.
    expect(gateFor(getPreset("brotes-activos"), "national", 3).caps.allowedControls.scrubber).toBe(
      true,
    );
  });

  it("basisToggle needs a scrub AND a temporal base", () => {
    const temporalBase = makeViewState({ layers: ["perdidas"], asOf: "2026-06-01T00:00:00.000Z" });
    expect(
      capabilitiesFor(temporalBase, { zoom: 3, level: "province" }).allowedControls.basisToggle,
    ).toBe(true);
    // Same layers, live edge (no asOf) → no basis lens.
    const live = makeViewState({ layers: ["perdidas"] });
    expect(capabilitiesFor(live, { zoom: 3, level: "province" }).allowedControls.basisToggle).toBe(
      false,
    );
    // Scrubbing but a current-state base (cobertura) → no basis lens.
    const currentBase = makeViewState({ layers: ["cobertura"], asOf: "2026-06-01T00:00:00.000Z" });
    expect(
      capabilitiesFor(currentBase, { zoom: 3, level: "province" }).allowedControls.basisToggle,
    ).toBe(false);
  });

  // --- Direct bivariateEligibleFor characterization — hand-edited combos ------
  //
  // The suite above only drives bivariateEligibleFor THROUGH gateFor, which
  // enumerates the 6 PRESETS (presetLayerIds). That is BLIND to hand-edited,
  // non-preset active-layer sets — e.g. {esterilizacion, zoonosis}, reachable
  // in two clicks from the console but never emitted by a preset. That gap let
  // a P2 regression through: the predicate had gone over-general (any
  // rate-with-target base × any signal) while the bivariate JOIN
  // (`buildBivariateCells`) stayed hardcoded to cobertura × zoonosis, offering
  // the toggle for combos it cannot render. The fix constrains
  // bivariateEligibleFor to that exact pair. These cases call it DIRECTLY to
  // pin the constrained behavior. See the P2 review (2026-07-12).
  it("bivariateEligibleFor is constrained to the DECLARED pairs the join supports", () => {
    // The supported pairs, at province level (BIVARIATE_PAIRS: the original
    // brotes pair + the new-vistas riesgo-ppp pair).
    expect(bivariateEligibleFor(["cobertura", "zoonosis"], "province")).toBe(true);
    expect(bivariateEligibleFor(["ppp", "mordeduras"], "province")).toBe(true);
    // Order-free (the active set is a SET).
    expect(bivariateEligibleFor(["mordeduras", "ppp"], "province")).toBe(true);

    // The regression: esterilizacion is a rate-with-target base like cobertura,
    // but it is NOT cobertura — the join can't render this combo.
    expect(bivariateEligibleFor(["esterilizacion", "zoonosis"], "province")).toBe(false);

    // A different signal paired with the supported base — reunificacion is not
    // zoonosis, so the join still can't render it.
    expect(bivariateEligibleFor(["cobertura", "reunificacion"], "province")).toBe(false);

    // A third layer (a reference pin) added to the supported pair — the active
    // set is no longer exactly {cobertura, zoonosis}. Matches the old
    // brotes-activos-only behavior (brotes-activos IS exactly that pair).
    expect(bivariateEligibleFor(["cobertura", "zoonosis", "refugios"], "province")).toBe(false);

    // The supported pair, but off the province level — bivariate is
    // province-only regardless of the layer set.
    expect(bivariateEligibleFor(["cobertura", "zoonosis"], "locality")).toBe(false);
    expect(bivariateEligibleFor(["ppp", "mordeduras"], "locality")).toBe(false);

    // Still NEVER a shape predicate: a rate × count combo that is not a
    // DECLARED pair stays refused (nobody vetted its tercile sanity).
    expect(bivariateEligibleFor(["ppp", "denuncias"], "province")).toBe(false);
    expect(bivariateEligibleFor(["cobertura", "mordeduras"], "province")).toBe(false);
  });

  it("mapModes (task #24): always ['auto']; bivariate joins ONLY when eligible", () => {
    // brotes-activos at national → province level: bivariate offered.
    const brotes = gateFor(getPreset("brotes-activos"), "national", 3);
    expect(brotes.caps.mapModes).toEqual(["auto", "bivariate"]);
    // Same preset drilled (locality level) → auto only.
    expect(gateFor(getPreset("brotes-activos"), "province", 7).caps.mapModes).toEqual(["auto"]);
    // bienestar (base denuncias + reference decomisos) at national → province
    // level: the per-cápita encoding is offered (panorama-percapita v1).
    expect(gateFor(getPreset("bienestar"), "national", 3).caps.mapModes).toEqual([
      "auto",
      "percapita",
    ]);
  });

  it("mapModes/allowedControls (panorama-percapita): per-cápita only at province grain over an all-eligible count set", () => {
    // bienestar drilled (locality level) → no department denominator → auto only.
    const drilled = gateFor(getPreset("bienestar"), "province", 7);
    expect(drilled.caps.mapModes).toEqual(["auto"]);
    expect(drilled.caps.allowedControls.percapitaEligible).toBe(false);

    // National bienestar → offered, and the control mirror agrees with the
    // shared predicate (the same single-source pattern as bivariateEligible).
    const national = gateFor(getPreset("bienestar"), "national", 3);
    expect(national.caps.allowedControls.percapitaEligible).toBe(true);
    expect(percapitaEligibleFor(national.layers, national.level)).toBe(true);

    // sintomas (base sintomas + SIGNAL zoonosis): a non-eligible aggregating
    // layer shares the ONE graduated scale → refused (mixed units would lie).
    const sintomas = gateFor(getPreset("sintomas"), "national", 3);
    expect(sintomas.caps.mapModes).toEqual(["auto"]);
    expect(sintomas.caps.allowedControls.percapitaEligible).toBe(false);

    // A hand-edited single eligible layer (mordeduras alone) also qualifies —
    // eligibility is a LAYER-SET predicate, never a preset id.
    const view = makeViewState({ layers: ["mordeduras"] });
    const caps = capabilitiesFor(view, { zoom: 3, level: "province" });
    expect(caps.mapModes).toEqual(["auto", "percapita"]);
  });

  it("representationPerZoom declares the near-zoom points swap for points-capable bases", () => {
    // perdidas declares renderPolicy.points (clustered-points) → near band = points.
    const perdidasView = makeViewState({ layers: ["perdidas"] });
    const caps = capabilitiesFor(perdidasView, { zoom: 11, level: "locality" });
    expect(caps.representationPerZoom.perdidas.near).toBe("clustered-points");
    // cobertura (choropleth rate) declares no points → near falls back to its mark.
    const covView = makeViewState({ layers: ["cobertura"] });
    const covCaps = capabilitiesFor(covView, { zoom: 3, level: "province" });
    expect(covCaps.representationPerZoom.cobertura.near).toBe("choropleth-fill");
    expect(covCaps.representationPerZoom.cobertura.national).toBe("choropleth-fill");
  });
});

// ---------------------------------------------------------------------------
// LOD province-rollup disclosure (panorama campaign C2 coherence). Pure logic:
// (band, scopeIsDrilled, isReferenceLayer) → hint | null. This is the guard for
// the "algunas capas te sacan del zoom pero el scope queda en localidad" gap.
// ---------------------------------------------------------------------------

describe("lodProvinceRollupHint — LOD band disclosure", () => {
  it("hints ONLY when band is national AND the scope is drilled AND the layer is not reference", () => {
    // The one case that warrants the disclosure.
    expect(
      lodProvinceRollupHint({ band: "national", scopeIsDrilled: true, isReferenceLayer: false }),
    ).toBe(LOD_PROVINCE_ROLLUP_HINT);
  });

  it("stays silent on the national overview (scope not drilled) — the national band is expected", () => {
    expect(
      lodProvinceRollupHint({ band: "national", scopeIsDrilled: false, isReferenceLayer: false }),
    ).toBeNull();
  });

  it("stays silent when the band already matches the drilled scope (drilled / near)", () => {
    expect(
      lodProvinceRollupHint({ band: "drilled", scopeIsDrilled: true, isReferenceLayer: false }),
    ).toBeNull();
    expect(
      lodProvinceRollupHint({ band: "near", scopeIsDrilled: true, isReferenceLayer: false }),
    ).toBeNull();
  });

  it("exempts reference layers (refugios/decomisos) even at the national band on a drilled scope", () => {
    expect(
      lodProvinceRollupHint({ band: "national", scopeIsDrilled: true, isReferenceLayer: true }),
    ).toBeNull();
  });

  it("cross-checks against the real registry: a drilled scope at wide zoom flags aggregated layers, exempts reference layers", () => {
    // markForZoom drives the same band the console threads in. At a wide zoom (below
    // the layer's autoLevel.belowZoom) with a province in scope, aggregated/choropleth
    // layers resolve NATIONAL while reference layers (nationalBelowZoom=null) never do.
    const perdidasBand = markForZoom(ZOOM_REPRESENTATIONS.perdidas, 3, true).band;
    expect(perdidasBand).toBe("national");
    expect(
      lodProvinceRollupHint({
        band: perdidasBand,
        scopeIsDrilled: true,
        isReferenceLayer: getLayer("perdidas")!.dataType === "reference",
      }),
    ).toBe(LOD_PROVINCE_ROLLUP_HINT);

    // refugios (reference) at the same wide zoom never forces national, and is exempt.
    const refBand = markForZoom(ZOOM_REPRESENTATIONS.refugios, 3, true).band;
    expect(refBand).not.toBe("national");
    expect(
      lodProvinceRollupHint({
        band: refBand,
        scopeIsDrilled: true,
        isReferenceLayer: getLayer("refugios")!.dataType === "reference",
      }),
    ).toBeNull();
  });
});

// Local helper (kept below the suite for readability).
function getPreset(id: PanoramaPreset["id"]): PanoramaPreset {
  return PANORAMA_PRESETS.find((p) => p.id === id) as PanoramaPreset;
}
