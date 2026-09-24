"use client";

// P5 gift (#51) — render the panorama map surfaces from a FROZEN ViewState.
//
// `<PanoramaEmbed viewState={...} />` is the master-plan P5 deliverable: the map
// island as a pure projection of the canonical value, with NO chrome and NO URL
// coupling. The #51 cascade migrates the analytics-screen maps that SEMANTICALLY
// match a panorama layer: /gob/poblacion → esterilizacion (province ratePct,
// byte-identical to fetchSterilizationCoverage.byProvince). censo/perdidas/
// vigilancia stay on MapChoroplethDynamic — no equivalent layer (censo = registry
// COUNT) or map-local coupling the read-only v1 embed cannot honor (perdidas
// status·species·q filters + entity-vs-event population; vigilancia
// province→subregion drill + k-anon). #24/#33 build their modes on the same seam.
// v1 scope (documented, deliberate):
//  - aggregated + reference marks only (no near-zoom real-dots band — points are
//    an operator surface, not an embed surface);
//  - live view only (PO 2026-07-14: replay is live view, no ?basis=) — asOf IS
//    honored when the frozen view carries one (a scrubbed snapshot embeds
//    honestly);
//  - read-only data surface, no drill/scope commits. Camera lockdown (gob/
//    map-zoom-lockdown follow-up, 2026-07-21, PO-approved reversal of the v1
//    "native pan/zoom stays" call above): the embed now passes
//    `interactive={false}` to SituationalMap, mirroring the choropleth
//    screens' locked-down camera — an operator can never pan/zoom this map
//    away from its scope. The full /gob/panorama console (SituationalMap's
//    other consumer) never sets this prop, so it stays fully interactive.
//
// Fetches each layer once from /api/panorama/[layer] with the view's scope /
// period / asOf / verified — the SAME authz-fenced route the console uses, so an
// embed can never widen data scope.

import { useEffect, useMemo, useState } from "react";

import type { ActiveLayer, PointRenderMode } from "@/components/panorama/SituationalMap";
import { SituationalMapDynamic } from "@/components/panorama/SituationalMapDynamic";
import {
  AGGREGATED_POINT_IDS,
  CHOROPLETH_LAYERS,
  getLayer,
} from "@/src/modules/panorama/domain/layers";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import {
  type PanoramaViewState,
  scopeForcesLocality,
} from "@/src/modules/panorama/domain/view-state";
import { explainViewState } from "@/src/modules/panorama/domain/view-state-caption";
import { viewStateToParams } from "@/src/modules/panorama/domain/view-state-url";

const CHOROPLETH_IDS = new Set(CHOROPLETH_LAYERS.map((l) => l.id));
const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

type Props = {
  /** The frozen view to render. Layers/scope/period/asOf/verified are honored;
   *  camera/preset/encoding are chrome-level concerns the embed ignores in v1. */
  viewState: PanoramaViewState;
  /** Map height: px number or CSS value (SituationalMap's own default when omitted). */
  height?: number | string;
};

/** The data axis of the frozen view — scope-only, exactly the console's P4c rule. */
function axisOf(view: PanoramaViewState): "province" | "locality" {
  return scopeForcesLocality(view) ? "locality" : "province";
}

export function PanoramaEmbed({ viewState, height }: Props) {
  const [features, setFeatures] = useState<Map<string, FeatureCollection>>(new Map());
  const level = axisOf(viewState);

  // Fetch each frozen layer ONCE per (view) identity — the embed is a still
  // projection, not a live console; a new viewState prop refetches.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const base = viewStateToParams(viewState);
    // The layer route reads scope/period/asOf/verified; board params are chrome.
    for (const chromeParam of ["layers", "preset", "encoding", "z", "lat", "lng"]) {
      base.delete(chromeParam);
    }
    void Promise.all(
      viewState.layers.map(async (id) => {
        const params = new URLSearchParams(base);
        const levelSensitive = CHOROPLETH_IDS.has(id) || AGGREGATED_POINT_IDS.has(id);
        if (levelSensitive && level === "province") params.set("level", "province");
        try {
          const res = await fetch(`/api/panorama/${id}?${params.toString()}`, {
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          if (!res.ok) return [id, EMPTY_FC] as const;
          const body = (await res.json()) as { features: FeatureCollection };
          return [id, body.features] as const;
        } catch {
          // Aborted (unmount / view change) or transient failure — empty layer,
          // never a throw out of the embed.
          return [id, EMPTY_FC] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setFeatures(new Map(entries));
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [viewState, level]);

  const layers = useMemo<ActiveLayer[]>(() => {
    const out: ActiveLayer[] = [];
    for (const id of viewState.layers) {
      const l = getLayer(id);
      if (!l) continue;
      const isAggregatedPoint = AGGREGATED_POINT_IDS.has(l.id);
      const renderMode: PointRenderMode | undefined =
        l.geomType === "point" ? (isAggregatedPoint ? "graduated" : "reference") : undefined;
      out.push({
        id: l.id,
        color: l.color,
        label: l.label,
        geomType: l.geomType,
        renderMode,
        features: features.get(l.id) ?? EMPTY_FC,
        level: l.geomType === "choropleth" || isAggregatedPoint ? level : undefined,
        dimmed: false,
        dataType: l.dataType,
        complianceTarget: l.complianceTarget,
        opacity: 1,
      });
    }
    return out;
  }, [viewState.layers, features, level]);

  // The a11y label IS the explain sentence — the embed announces exactly what
  // the frozen view shows.
  const label = useMemo(() => explainViewState(viewState), [viewState]);

  return (
    <SituationalMapDynamic
      layers={layers}
      label={label}
      height={height}
      fill={false}
      // Camera lockdown (gob/map-zoom-lockdown follow-up, 2026-07-21): the
      // ONLY caller that opts into the locked-down camera — see the header
      // comment above. The full /gob/panorama console never passes this
      // prop and keeps `interactive`'s default `true` (fully interactive).
      interactive={false}
    />
  );
}
