"use client";

// useLayerFeatures — client hook that fetches a layer's feature geojson from
// app/api/panorama/[layer]/route.ts (map-QOL P0 primitive). That route
// already implements auth (401/403), profile/jurisdiction lookup, and
// scope-narrowing of province/locality/level intersected with the viewer's
// assignments — read its docblock. This hook is a THIN client fetch wrapper
// around it; no auth/scope logic is duplicated here.
//
// AbortController-based cancellation on param change mirrors
// components/panorama/DetailDrawer.tsx's UnitHistorySection fetch idiom (its
// fetch to /api/panorama/unit-history) — same idle/loading/error/ok state
// shape, same "ignore AbortError, surface everything else" catch.
//
// Structured so a LATER map-QOL commit can call this once per ACTIVE layer on
// toggle changes (one hook instance per toggled layer id). NOT wired into
// PanoramaConsole.tsx in this commit — this file only builds the primitive.

import { useEffect, useState } from "react";

import type {
  AggregationLevel,
  FeatureCollection,
  LayerId,
} from "@/src/modules/panorama/domain/types";

export type UseLayerFeaturesParams = {
  layerId: LayerId;
  /** ISO 3166-2:AR province code (e.g. "AR-B"), NOT a display name. Resolved server-side via provinceByCode. */
  province?: string | null;
  /** Locality slug scoped to `province`, NOT a display name. Resolved server-side via localityByName. */
  locality?: string | null;
  level?: AggregationLevel;
  /** F4 temporal reproduction: ISO date-time upper bound. Omit for the live edge. */
  asOf?: string | null;
};

/** Mirrors app/api/panorama/[layer]/route.ts's JSON response envelope. */
export type LayerFeaturesResponse = {
  features: FeatureCollection;
  truncated: boolean;
  suppressedCount: number;
  level: AggregationLevel;
};

export type UseLayerFeaturesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: LayerFeaturesResponse };

/** Builds the /api/panorama/[layer] request URL for the given params. */
export function buildLayerFeaturesUrl(params: UseLayerFeaturesParams): string {
  const sp = new URLSearchParams();
  if (params.province) sp.set("province", params.province);
  if (params.locality) sp.set("locality", params.locality);
  if (params.level) sp.set("level", params.level);
  if (params.asOf) sp.set("asOf", params.asOf);
  const qs = sp.toString();
  return `/api/panorama/${encodeURIComponent(params.layerId)}${qs ? `?${qs}` : ""}`;
}

/**
 * Fetches app/api/panorama/[layer]/route.ts for the given layer/scope/period.
 * Refetches whenever any param changes, cancelling the previous in-flight
 * request (AbortController) so a fast toggle sequence never lets a stale
 * response overwrite a newer one.
 */
export function useLayerFeatures(params: UseLayerFeaturesParams): UseLayerFeaturesState {
  const { layerId, province, locality, level, asOf } = params;
  const [state, setState] = useState<UseLayerFeaturesState>({ status: "loading" });

  useEffect(() => {
    setState({ status: "loading" });
    const controller = new AbortController();
    const url = buildLayerFeaturesUrl({ layerId, province, locality, level, asOf });

    fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LayerFeaturesResponse>;
      })
      .then((data) => {
        setState({ status: "ok", data });
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setState({ status: "error", message: "No se pudo cargar la capa." });
      });

    return () => controller.abort();
  }, [layerId, province, locality, level, asOf]);

  return state;
}
