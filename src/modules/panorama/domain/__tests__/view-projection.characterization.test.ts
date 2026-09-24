// PANORAMA VIEWSTATE REFACTOR — P0 CHARACTERIZATION NET (task #50).
//
// This is the REGRESSION FENCE for the ViewState foundational refactor. It pins
// the CURRENT composed view-projection — for a matrix of (preset × scope × zoom ×
// scrubbing), what does the panorama decide to render: active layers, aggregation
// level, the base layer's encoding/mark, points-mode, bivariate eligibility,
// temporal/scrubber availability, and the plain-language caption.
//
// WHY A COMPOSED SNAPSHOT (not just per-function tests): the refactor's entire
// risk is that surfaces re-derive these decisions from DIFFERENT state slices and
// drift (the coherence bug family). Today no single function produces this record
// — the decisions are scattered across PanoramaConsole (React) + situational-map-
// utils + the domain registries. This test COMPOSES them into one record per cell
// using the ACTUAL pure helpers where they exist, and faithfully-cited inline
// reconstructions for the two predicates that live inside the React component
// (bivariate gating at PanoramaConsole.tsx:2134-2138; the isMeta/encoding mark
// selection at :1519-1526 + the province fill isMeta at SituationalMap.tsx:1936).
//
// THE CONTRACT: P1–P3 MUST keep this snapshot byte-identical. When P2 introduces
// `capabilitiesFor(viewState, runtime)`, a sibling test will assert it reproduces
// this exact record for each cell — proving the gate changed nothing. P4 (LOD /
// glow) is the ONE phase allowed to update this snapshot, DELIBERATELY, with the
// change documented in the commit.
//
// ── P4b UPDATE (DELIBERATE, 2026-07-14) ─────────────────────────────────────
// The imperative points switch (`pointsEligible` + `POINTS_LAYER_IDS`) was
// replaced by the declaration-driven LOD bands (`markForZoom` over
// `ZOOM_REPRESENTATIONS` — renderPolicy finally read at runtime, closing A7).
// The record gains two fields:
//   `lodBand`     — the base layer's resolved band (national|drilled|near);
//   `paintedAxis` — the axis the base's FEATURES paint on (the cache routing).
// BEHAVIOR CHANGE pinned here (the GHOST fix): with a province in scope at
// national zoom (zoom < autoLevel.belowZoom), `level` stays "locality"
// (scope-wins, PO decision #1 — unchanged) but the base now PAINTS the
// province-axis rollup (`paintedAxis: "province"`) instead of hundreds of stale
// locality marks over the national frame. Every other cell is value-identical
// to the P0 net.
//
// ── P4c UPDATE (DELIBERATE, 2026-07-14, design §5.5) ────────────────────────
// The DATA axis (`level`) now follows the SCOPE alone: committed
// province/locality ⇒ locality; national ⇒ province at ANY zoom. The
// camera-driven half of the old derivedLevelWithHysteresis is gone (scroll =
// camera, click = drill — the wheel-hierarchy takeover was deleted with it).
// Matrix change: national-scope cells at zoom 7/11 keep `level: "province"`
// (they used to flip to locality past the Schmitt band); every scoped cell is
// unchanged. Rendering granularity remains the P4b LOD bands' job.
//
// Pure — no DB, no React, no maplibre. Deterministic (fixed periods, no `now`).

import { describe, expect, it } from "vitest";

import { ZOOM_REPRESENTATIONS, markForZoom } from "@/src/modules/panorama/domain/capabilities";
import { captionFor } from "@/src/modules/panorama/domain/caption";
import { getLayer, isTemporalLayer } from "@/src/modules/panorama/domain/layers";
import {
  PANORAMA_PRESETS,
  type PanoramaPreset,
  presetLayerIds,
} from "@/src/modules/panorama/domain/presets";
import type {
  AggregationLevel,
  LayerId,
  PanoramaLayer,
  PanoramaPeriod,
  PanoramaScope,
} from "@/src/modules/panorama/domain/types";
import {
  makeViewState,
  scopeFromFilter,
  toScopeFilter,
} from "@/src/modules/panorama/domain/view-state";

// ---------------------------------------------------------------------------
// Faithful reconstructions of the two decisions that live INSIDE the React
// component today. Each cites its exact current source so the reconstruction is
// auditable, and each becomes a field of `capabilitiesFor` in P2.
// ---------------------------------------------------------------------------

/** isMeta — SituationalMap.tsx:1936 / :2814, MapLegends.tsx:138, map-popup.ts:68
 *  (the predicate copy-pasted ×4, since consolidated into the gate's
 *  `isMetaLayer`). A layer with an ATTAINMENT TARGET renders the classed-step
 *  META choropleth; otherwise the sequential choropleth.
 *
 *  CORRECTED 2026-07-26: this reconstruction used to also require
 *  `dataType === "rate"`, mirroring the shared predicate at the time. That extra
 *  clause was never about what a meta scale IS — it conflated the aggregation
 *  routing with whether the value has a meta to be read against, and it denied
 *  the meta scale to `indice-territorial`, whose 0-100 score is nothing but
 *  attainment of three metas. The shared predicate dropped the clause; this copy
 *  follows it, because a characterization that no longer characterizes the code
 *  it mirrors pins fiction. */
function isMeta(layer: PanoramaLayer): boolean {
  return typeof layer.complianceTarget === "number";
}

/** bivariate eligibility — PanoramaConsole.tsx:2134-2138. The SOLE gate for the
 *  "Intensidad de reporte (brotes)" 3×3 encoding (renamed from "Riesgo de
 *  brotes" — C2, 2026-07-22): the brotes-activos preset, province level,
 *  with both cobertura (base) and zoonosis (signal) active. Reconstructed via the
 *  registry predicate it IMPLIES (no preset-id string in the eventual gate). */
function bivariateEligible(
  presetId: PanoramaPreset["id"],
  level: AggregationLevel,
  activeLayers: readonly LayerId[],
): boolean {
  // Current source keys on the preset id + level + the two specific layer ids.
  return (
    presetId === "brotes-activos" &&
    level === "province" &&
    activeLayers.includes("cobertura") &&
    activeLayers.includes("zoonosis")
  );
}

/** The base layer's rendered mark — P4b: the former imperative switch
 *  (PanoramaConsole `usesPoints = pointsMode && isPointsLayer`) is now the
 *  declaration read: near band ∧ pointsCapable. Composed with the province-fill
 *  isMeta branch (choropleth layers), unchanged. */
function baseEncoding(
  base: PanoramaLayer,
  level: AggregationLevel,
  pointsMode: boolean,
  bivariate: boolean,
): string {
  if (bivariate) return "bivariate"; // province fill is the 3×3 bivariate expr
  if (base.geomType === "choropleth") {
    return isMeta(base) ? "choropleth-meta" : "choropleth-seq";
  }
  // point base (density/signal — a preset base is never a reference layer)
  if (pointsMode && ZOOM_REPRESENTATIONS[base.id].pointsCapable) return "points";
  return "graduated";
}

// ---------------------------------------------------------------------------
// The matrix. Scopes × zooms × scrubbing, run for every preset.
// ---------------------------------------------------------------------------

const SCOPES: Record<string, PanoramaScope> = {
  national: { country: "AR" },
  province: { country: "AR", province: "AR-C" },
  locality: { country: "AR", province: "AR-C", locality: "Palermo" },
};

// Representative zooms: below the province↔locality band, inside a drill, and
// past Z_POINTS (10) where near-zoom real dots become eligible.
const ZOOMS = [3, 7, 11] as const;

// Fixed, deterministic periods per preset window (no dependency on `now`).
const PERIOD_90D: PanoramaPeriod = { from: "2026-04-13", to: "2026-07-12" };
const PERIOD_30D: PanoramaPeriod = { from: "2026-06-12", to: "2026-07-12" };
function periodFor(preset: PanoramaPreset): PanoramaPeriod {
  return preset.periodPreset === "30d" ? PERIOD_30D : PERIOD_90D;
}

type ProjectionRecord = {
  preset: string;
  scope: string;
  zoom: number;
  scrubbing: boolean;
  layers: LayerId[];
  level: AggregationLevel;
  base: LayerId;
  baseEncoding: string;
  /** P4b — the base layer's resolved LOD band at this camera. */
  lodBand: "national" | "drilled" | "near";
  /** P4b — the axis the base's features PAINT on (the cache routing; the ghost
   *  fix makes this "province" at national zoom even under scope-wins). */
  paintedAxis: AggregationLevel;
  pointsMode: boolean;
  bivariateEligible: boolean;
  temporalLayers: LayerId[];
  scrubberEnabled: boolean;
  caption: string;
};

/** Compose the full current projection for one matrix cell using the real pure
 *  helpers + the cited reconstructions above. This is EXACTLY the shape the
 *  console's assembly reproduces from `capabilitiesFor` + `markForZoom`. */
function project(
  preset: PanoramaPreset,
  scopeKey: string,
  zoom: number,
  scrubbing: boolean,
): ProjectionRecord {
  const scope = SCOPES[scopeKey];
  const provinceInScope = scope.province != null;
  const layers = presetLayerIds(preset);
  // P4c (design §5.5): the data axis derives from the SCOPE alone — the camera
  // never flips it. Mirrors the console's level effect exactly.
  const level: AggregationLevel =
    scope.province != null || scope.locality != null ? "locality" : "province";
  const base = getLayer(preset.base)!;
  // P4b: points mode = some active layer's declared band resolves NEAR and it is
  // points-capable (the former global pointsEligible × POINTS_LAYER_IDS gate).
  const pm = layers.some((id) => {
    const rep = ZOOM_REPRESENTATIONS[id];
    return rep.pointsCapable && markForZoom(rep, zoom, provinceInScope).band === "near";
  });
  const biv = bivariateEligible(preset.id, level, layers);
  const temporalLayers = layers.filter((id) => isTemporalLayer(id));
  // P4b: the base's own band + the axis its features paint on (the console's
  // cache routing: province cache at level=province OR in the national band).
  const baseBand = markForZoom(ZOOM_REPRESENTATIONS[preset.base], zoom, provinceInScope).band;
  const paintedAxis: AggregationLevel =
    level === "province" || baseBand === "national" ? "province" : "locality";
  return {
    preset: preset.id,
    scope: scopeKey,
    zoom,
    scrubbing,
    layers,
    level,
    base: preset.base,
    baseEncoding: baseEncoding(base, level, pm, biv),
    lodBand: baseBand,
    paintedAxis,
    pointsMode: pm,
    bivariateEligible: biv,
    temporalLayers,
    // scrubber is live iff at least one active layer is event-windowable.
    scrubberEnabled: temporalLayers.length > 0,
    caption: captionFor(base, level, periodFor(preset)),
  };
}

// ---------------------------------------------------------------------------
// The pinned matrix. One golden per (preset × scope × zoom); scrubbing is pinned
// separately for the temporal-gating assertions below (it does not alter the
// map/encoding projection, only the scrubber/dimming — asserted explicitly).
// ---------------------------------------------------------------------------

describe("panorama view-projection characterization (P0 fence)", () => {
  const matrix: ProjectionRecord[] = [];
  for (const preset of PANORAMA_PRESETS) {
    for (const scopeKey of Object.keys(SCOPES)) {
      for (const zoom of ZOOMS) {
        matrix.push(project(preset, scopeKey, zoom, false));
      }
    }
  }

  it("pins the full (preset × scope × zoom) projection matrix", () => {
    // The single golden. P1–P3 keep this identical; P4 updates it deliberately.
    expect(matrix).toMatchSnapshot();
  });

  // --- Invariant spot-checks (human-readable, survive a snapshot regen) -------

  it("national scope → province level at ANY zoom (P4c: the camera never flips the data axis)", () => {
    for (const preset of PANORAMA_PRESETS) {
      for (const zoom of ZOOMS) {
        // Before P4c, zoom 7/11 flipped national scope to locality (a nationwide
        // every-locality refetch triggered by looking closer). Now committing to
        // a jurisdiction is a CLICK; free zoom only changes the render bands.
        expect(project(preset, "national", zoom, false).level).toBe("province");
      }
    }
  });

  it("any province/locality scope → locality level regardless of zoom (scope wins)", () => {
    for (const preset of PANORAMA_PRESETS) {
      for (const zoom of ZOOMS) {
        expect(project(preset, "province", zoom, false).level).toBe("locality");
        expect(project(preset, "locality", zoom, false).level).toBe("locality");
      }
    }
  });

  it("P4b GHOST FIX: scoped at national zoom → the base PAINTS the province axis (level stays locality)", () => {
    // Scope-wins (PO decision #1) keeps `level` at locality for any scoped view —
    // unchanged. But at zoom 3 (below every autoLevel.belowZoom=5) the base's
    // declared band is NATIONAL, so its features paint the province rollup: no
    // more stale locality marks ghosting over the national frame.
    for (const preset of PANORAMA_PRESETS) {
      const r = project(preset, "province", 3, false);
      expect(r.level).toBe("locality"); // scope-wins, unchanged
      expect(r.lodBand).toBe("national"); // declaration read at runtime (A7 closed)
      expect(r.paintedAxis).toBe("province"); // the ghost fix
      // Inside the drill (zoom 7) the drilled band paints the locality axis.
      const drilled = project(preset, "province", 7, false);
      expect(drilled.lodBand).toBe("drilled");
      expect(drilled.paintedAxis).toBe("locality");
    }
  });

  it("points-mode only past Z_POINTS AND with a province in scope AND a points-capable active layer", () => {
    // points-capable layers (renderPolicy.points set) = perdidas, mordeduras, denuncias.
    // perdidas-reunificacion has perdidas as its base.
    const pr = PANORAMA_PRESETS.find((p) => p.id === "perdidas-reunificacion")!;
    expect(project(pr, "national", 11, false).pointsMode).toBe(false); // no province in scope
    expect(project(pr, "province", 7, false).pointsMode).toBe(false); // below Z_POINTS
    expect(project(pr, "province", 11, false).pointsMode).toBe(true); // eligible
    // bienestar's base (denuncias) is points-capable too; cumplimiento's base (cobertura, choropleth) is not.
    const cumpl = PANORAMA_PRESETS.find((p) => p.id === "cumplimiento")!;
    expect(project(cumpl, "province", 11, false).pointsMode).toBe(false);
  });

  it("bivariate is eligible ONLY for brotes-activos at province level with cobertura+zoonosis", () => {
    const brotes = PANORAMA_PRESETS.find((p) => p.id === "brotes-activos")!;
    expect(project(brotes, "national", 3, false).bivariateEligible).toBe(true); // national→province level
    expect(project(brotes, "province", 7, false).bivariateEligible).toBe(false); // province scope→locality level
    for (const preset of PANORAMA_PRESETS) {
      if (preset.id === "brotes-activos") continue;
      for (const scopeKey of Object.keys(SCOPES)) {
        expect(project(preset, scopeKey, 3, false).bivariateEligible).toBe(false);
      }
    }
  });

  it("base encoding: rate-with-target → choropleth-meta; density choropleth → choropleth-seq; point base → graduated/points", () => {
    // cumplimiento base cobertura (rate, target 80) → meta at province level.
    const cumpl = PANORAMA_PRESETS.find((p) => p.id === "cumplimiento")!;
    expect(project(cumpl, "national", 3, false).baseEncoding).toBe("choropleth-meta");
    // D1: cumplimiento's esterilizacion METRIC OPTION (ex control-poblacional)
    // — base esterilizacion (rate, target) → meta.
    const esterilizacion = { ...cumpl, base: "esterilizacion" as const };
    expect(project(esterilizacion, "national", 3, false).baseEncoding).toBe("choropleth-meta");
    // bienestar base denuncias (density point) → graduated (aggregated).
    const bienestar = PANORAMA_PRESETS.find((p) => p.id === "bienestar")!;
    expect(project(bienestar, "national", 3, false).baseEncoding).toBe("graduated");
    // perdidas-reunificacion base perdidas (points-capable) at near zoom in scope → points.
    const pr = PANORAMA_PRESETS.find((p) => p.id === "perdidas-reunificacion")!;
    expect(project(pr, "province", 11, false).baseEncoding).toBe("points");
    expect(project(pr, "province", 7, false).baseEncoding).toBe("graduated");
  });

  it("scrubber availability follows the presence of a temporal (event-windowable) active layer", () => {
    for (const preset of PANORAMA_PRESETS) {
      const r = project(preset, "national", 3, false);
      const anyTemporal = presetLayerIds(preset).some((id) => isTemporalLayer(id));
      expect(r.scrubberEnabled).toBe(anyTemporal);
    }
    // cumplimiento (cobertura only — a current-state rate) has NO temporal layer → no scrubber.
    const cumpl = PANORAMA_PRESETS.find((p) => p.id === "cumplimiento")!;
    expect(project(cumpl, "national", 3, false).scrubberEnabled).toBe(false);
    // brotes-activos (cobertura + zoonosis) — zoonosis IS temporal → scrubber on.
    const brotes = PANORAMA_PRESETS.find((p) => p.id === "brotes-activos")!;
    expect(project(brotes, "national", 3, false).scrubberEnabled).toBe(true);
  });

  // --- P1b Fork A: orphan-locality scope normalization (PO-approved fix) ------
  //
  // A crafted URL `?locality=X` with NO province anywhere (URL or jurisdiction)
  // used to force LOCALITY-level aggregation on a nationally-framed map, because
  // `derivedLevelWithHysteresis` gives locality whenever `scope.locality != null`
  // — an incoherent latent state no real UI path produces. P1b routes the
  // console's scope filter through `scopeFromFilter` → `toScopeFilter`, which
  // drop the orphan (ViewScope makes a locality-without-province unrepresentable).
  // This pins the CORRECTED national result the console now derives.
  it("Fork A: an orphan locality (no province) normalizes to national → province level", () => {
    const orphan: PanoramaScope = { country: "AR", province: null, locality: "Palermo" };
    // The normalization is structural: scopeFromFilter drops the orphan locality,
    // exactly as the console now routes its scope filter (scopeFromFilter →
    // canonical ViewScope → toScopeFilter).
    const normalizedScope = scopeFromFilter(orphan);
    expect(normalizedScope).toEqual({ kind: "national" });
    const normalized = toScopeFilter(makeViewState({ scope: normalizedScope }));
    expect(normalized).toEqual({ country: "AR", province: null, locality: null });
    // The normalized (national) scope derives PROVINCE under the P4c scope-only
    // rule; the raw orphan would have forced locality. The structural fix is the
    // normalization — a locality-without-province is unrepresentable in ViewScope.
    const levelOf = (s: PanoramaScope) =>
      s.province != null || s.locality != null ? "locality" : "province";
    expect(levelOf(normalized)).toBe("province"); // fixed
    expect(levelOf(orphan)).toBe("locality"); // old, incoherent input
  });
});
