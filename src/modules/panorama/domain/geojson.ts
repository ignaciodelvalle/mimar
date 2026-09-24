// Pure GeoJSON construction helpers for Panorama layers.
//
// GeoJSON mandates [longitude, latitude] order (RFC 7946 §3.1.1) — the reverse
// of how lat/lng are written and stored. Centralising construction here kills
// the classic swapped-coordinate bug. Also mirrors the pet_events
// `location_pair_check` invariant: a feature is located ONLY when BOTH
// coordinates are present and finite, otherwise geometry is null.
//
// Coordinates arrive from Drizzle as strings (postgres numeric(10,7) → string),
// so the helpers accept number | string and parse defensively.

import type { FeatureCollection, PanoramaFeature, PointGeometry } from "./types";

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a Point feature from lat/lng (in that natural order) + properties.
 * Emits coordinates as [lng, lat] per GeoJSON. If either coordinate is
 * missing/invalid, geometry is null (a non-located feature) — never a
 * half-formed point.
 */
export function pointFeature<P extends Record<string, unknown>>(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined,
  properties: P,
): PanoramaFeature<P> {
  const latN = toFiniteNumber(lat);
  const lngN = toFiniteNumber(lng);
  const geometry: PointGeometry | null =
    latN === null || lngN === null ? null : { type: "Point", coordinates: [lngN, latN] };
  return { type: "Feature", geometry, properties };
}

export function featureCollection<P extends Record<string, unknown>>(
  features: Array<PanoramaFeature<P>>,
): FeatureCollection<P> {
  return { type: "FeatureCollection", features };
}

export function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
