// lib/ui/map-layer-nav.ts — Shallow pushState/replaceState URL sync for the
// map-QOL Panorama layer/period/scope controls (map-QOL P0 primitive).
//
// WHY: same router-hot-path defect this whole helper family works around —
// see lib/ui/sheet-nav.ts's module docblock (Next.js 15.5.x's App Router can
// silently drop a router.push/router.replace soft navigation in production,
// engram #621/#622). Opening/closing sheets and switching the pet profile's
// tab already route around it via the native History API instead of
// next/navigation's router; this module applies the identical primitive to
// Panorama's map state (layer toggles, period/scope, `asOf`).
//
// This is the mechanism a LATER map-QOL commit will use to SUPERSEDE
// components/panorama/PanoramaConsole.tsx's `onPreset` interim cure — a full
// `window.location.assign` reload on period commit (see that file's docblock,
// ~lines 677-698) — with a shallow, client-fetch period/layer commit. NOT
// wired into PanoramaConsole in this commit: this file only builds the
// primitive a later commit will consume.
//
// Only use these helpers for SAME-ROUTE transitions (layer/period/scope query
// params on the current Panorama route) — see isSameRouteUrl, re-exported
// from sheet-nav.ts (not duplicated) for callers that need to decide between
// a shallow push and a real navigation to a different route.

export { isSameRouteUrl } from "./sheet-nav";

/**
 * Pushes a new map-state URL (layer/period/scope/`asOf` query params) onto
 * the history stack via the native History API — same primitive and
 * router-hot-path rationale as sheet-nav.ts's pushTabUrl. `url` must target
 * the SAME route as the current page (only search params differ); a
 * different route is a real navigation and must go through next/navigation's
 * router instead — see isSameRouteUrl.
 */
export function pushMapStateUrl(url: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", url);
}

/**
 * Replaces the current map-state URL WITHOUT pushing a new history entry —
 * same primitive as sheet-nav.ts's replaceTabUrl. Use this for a silent,
 * one-time normalization the user did not explicitly navigate to (e.g.
 * clamping a stale `asOf` on mount); use pushMapStateUrl for an explicit
 * user-driven layer/period change that should be back-button undoable.
 */
export function replaceMapStateUrl(url: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------
// "Copiar vista" fidelity (map-QOL): the shareable URL must reproduce the EXACT
// view the operator sees. Layer/period/scope already travel; camera (zoom +
// center) and the scrub position (`asOf`) did NOT, so a copied link opened a
// DIFFERENT view. These pure encode/decode helpers close that gap — the console
// writes them through replaceMapStateUrl on camera-settle / scrub-change and
// restores them on load. Rounding keeps the URL short and stable (a sub-metre
// camera jitter must not churn the querystring on every settle).
// ---------------------------------------------------------------------------

/** A restorable map camera: the values a single `jumpTo` needs. */
export type MapCamera = { zoom: number; lng: number; lat: number };

const CAMERA_ZOOM_KEY = "z";
const CAMERA_LAT_KEY = "lat";
const CAMERA_LNG_KEY = "lng";
const AS_OF_KEY = "asOf";

/** The camera (zoom + center) query keys, as one list for strip/round-trips. */
export const CAMERA_PARAM_KEYS = [CAMERA_ZOOM_KEY, CAMERA_LAT_KEY, CAMERA_LNG_KEY] as const;

/**
 * Drop the camera (zoom + center) keys from `params` (mutates in place). A camera
 * is only valid for the scope it was captured in: a national frame pinned in the
 * URL must NOT survive a drill into a province (or a jurisdiction switch, or a
 * return to national), or the scope's own framing logic (A1 autozoom / province
 * fit) is overridden by a stale camera on reload. Scope-changing navigations call
 * this so the new scope frames itself. The `asOf` scrub position is deliberately
 * NOT dropped — a date is scope-independent and stays valid across the change.
 */
export function stripCameraParams(params: URLSearchParams): void {
  for (const key of CAMERA_PARAM_KEYS) params.delete(key);
}

/** Round to `dp` decimals (avoids float-tail noise like 3.4000000000000004). */
function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Write the camera to `params` (mutates in place). Zoom keeps 2 decimals (the
 * level-flip hysteresis needs sub-integer fidelity); lat/lng keep 3 (~110 m,
 * plenty for a shared frame and short in the URL).
 */
export function encodeCameraToParams(params: URLSearchParams, camera: MapCamera): void {
  params.set(CAMERA_ZOOM_KEY, String(round(camera.zoom, 2)));
  params.set(CAMERA_LAT_KEY, String(round(camera.lat, 3)));
  params.set(CAMERA_LNG_KEY, String(round(camera.lng, 3)));
}

/**
 * Parse a camera from `params`, or null when any component is absent, non-finite,
 * or out of the valid lat/lng range (a hand-edited or truncated URL must not
 * jump the camera to a nonsense coordinate — fall back to the computed frame).
 */
export function parseCameraFromParams(params: URLSearchParams): MapCamera | null {
  const zRaw = params.get(CAMERA_ZOOM_KEY);
  const latRaw = params.get(CAMERA_LAT_KEY);
  const lngRaw = params.get(CAMERA_LNG_KEY);
  if (zRaw === null || latRaw === null || lngRaw === null) return null;
  const zoom = Number(zRaw);
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { zoom, lng, lat };
}

/**
 * Write the scrub position to `params` at DAY precision (a scrub steps whole
 * days, so the time-of-day is meaningless). null = live edge → drop the param.
 */
export function encodeAsOfToParams(params: URLSearchParams, asOf: Date | null): void {
  if (asOf === null || Number.isNaN(asOf.getTime())) {
    params.delete(AS_OF_KEY);
    return;
  }
  params.set(AS_OF_KEY, asOf.toISOString().slice(0, 10));
}

/**
 * Parse the scrub position from `params` → a Date at UTC midnight of the encoded
 * day, or null when absent/malformed. Tolerates a full ISO string (older links
 * that stamped the whole instant) by reading only its date part.
 */
export function parseAsOfFromParams(params: URLSearchParams): Date | null {
  const raw = params.get(AS_OF_KEY);
  if (raw === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match === null) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
