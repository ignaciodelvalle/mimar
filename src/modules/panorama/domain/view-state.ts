// Panorama ViewState — the single canonical view-configuration value (task #50).
//
// See dim-interno:docs/plans/panorama-viewstate-design.md for the concrete design. This is
// the FOUNDATION module (P1a): the pure type + its constructors/converters. The
// URL boundary lives in `view-state-url.ts`; the capability gate (`capabilitiesFor`)
// arrives in P2. Nothing in the React console reads this yet — P1b wires it.
//
// Pure — NO @/db, NO next, NO React (hexagonal domain purity, enforced by the
// biome noRestrictedImports override for src/modules/*/domain/**).
//
// DISCIPLINE: everything the panorama renders — map, KPIs, dock, legend, CABA
// inset, URL, saved views — is a pure projection `(ViewState, runtime) → render`.
// Two surfaces reading one value cannot diverge; the coherence invariant becomes
// structural instead of defended per-fix.

import type { PresetId } from "./presets";
import type { TimeBasis } from "./time-scrub";
import type { AggregationLevel, LayerId, PanoramaScope } from "./types";

// ---------------------------------------------------------------------------
// Field value types
// ---------------------------------------------------------------------------

/**
 * The analytic-window preset ids (mirrors lib/analytics/analytics-period.ts —
 * the resolver's `period` search-param values, minus `custom` which is the
 * {kind:'custom'} variant below). English code; the labels are elsewhere.
 */
export type AnalyticsPeriodPreset = "7d" | "30d" | "90d" | "ytd" | "trailing12m" | "3y" | "5y";

/**
 * WHAT data is in view — data-scope only, NOT the camera. A discriminated union
 * so an illegal state (a locality without a province) is unrepresentable.
 */
export type ViewScope =
  | { kind: "national" }
  | { kind: "province"; province: string }
  | { kind: "locality"; province: string; locality: string };

/**
 * The analytic window SELECTOR. Resolves to a concrete {since,until} via
 * `resolveAnalyticsPeriod(toPeriodSearchParams(view))` — the window itself is
 * DERIVED, never stored (same discipline the data layer already uses).
 */
export type ViewPeriod =
  | { kind: "preset"; preset: AnalyticsPeriodPreset }
  | { kind: "custom"; from: string; to: string };

/** OPTIONAL camera frame, for reproduction only (deep-link / saved view / embed).
 *  The LIVE zoom that drives LOD is a RUNTIME input to the projection, not stored
 *  — storing continuous zoom would thrash the canonical value on every pan. This
 *  is the settled frame a deep link restores. Serialized as z/lat/lng. */
export type ViewCamera = { zoom: number; lat: number; lng: number };

/** Encoding SELECTION seam (reserved for #24). `null` = "auto": the capability
 *  gate derives the encoding from preset + layers exactly as today. P1 keeps this
 *  null everywhere (no behavior change). */
export type EncodingId =
  | "choropleth-seq"
  | "choropleth-meta"
  | "bivariate"
  /** panorama-percapita v1: count layers re-encoded por 10.000 habitantes
   *  (province grain — jurisdictions_census denominator). */
  | "percapita"
  | "graduated"
  | "points"
  | "reference"
  | "glow";

/** Which surface the dock foregrounds. Today = the dock tab (PanoramaDockTab);
 *  #33 (viz-suite) expands this union with estadisticas/tendencias/flujos. */
export type Representation = "registros" | "stats" | "timeline";

// ---------------------------------------------------------------------------
// The canonical value
// ---------------------------------------------------------------------------

export type PanoramaViewState = {
  /** WHAT data is in view (data-scope). */
  scope: ViewScope;
  /** The analytic-window selector (resolves to {since,until}). */
  period: ViewPeriod;
  /** The time-scrubber cut. null = live edge (current state). */
  asOf: string | null;
  /** Bitemporal replay lens. Only meaningful while `asOf != null`. Ephemeral —
   *  intentionally NOT URL-serialized in P1 (design fork #1: "a lens, not a
   *  shareable coordinate"). */
  basis: TimeBasis;
  /** Active layers, in activation order [base, signal?, ...references]. */
  layers: LayerId[];
  /** Vet-signed filter (the `?verified=1` toggle). A real data-scope axis. */
  verifiedOnly: boolean;
  /** The preset this view came from; null once hand-edited into "modo avanzado". */
  preset: PresetId | null;
  /** Encoding selection; null = auto. P5 (PO 2026-07-14): an explicit selection
   *  SERIALIZES (`?encoding=`) so a shared link reproduces it — only encodings a
   *  preset declares (`preset.encodings`) parse back. */
  encoding: EncodingId | null;
  /** Which surface the dock foregrounds. Ephemeral (dock tab is not URL-backed). */
  representation: Representation;
  /** Optional settled camera frame for reproduction. */
  camera: ViewCamera | null;
};

/** The URL-SERIALIZED subset — the fields the boundary round-trips. The other
 *  two (basis, representation) are ephemeral by design (§4.2; fork #1 resolved:
 *  basis stays out — replay is live view). */
export const SERIALIZED_FIELDS = [
  "scope",
  "period",
  "asOf",
  "layers",
  "verifiedOnly",
  "preset",
  "encoding",
  "camera",
] as const;

// ---------------------------------------------------------------------------
// Defaults + normalization
// ---------------------------------------------------------------------------

/** The neutral default view (bare-URL national landing before any seed/preset). */
export const DEFAULT_VIEW_STATE: PanoramaViewState = {
  scope: { kind: "national" },
  period: { kind: "preset", preset: "3y" }, // PANORAMA_DEFAULT_PRESET
  asOf: null,
  basis: "valid",
  layers: [],
  verifiedOnly: false,
  preset: null,
  encoding: null,
  representation: "registros",
  camera: null,
};

/** A partial seed the boundary/console layers over the defaults. */
export type ViewStateSeed = Partial<PanoramaViewState>;

/** Merge a partial seed onto the defaults into a complete, valid ViewState. */
export function makeViewState(seed: ViewStateSeed = {}): PanoramaViewState {
  return { ...DEFAULT_VIEW_STATE, ...seed };
}

// ---------------------------------------------------------------------------
// Converters to the existing domain shapes (ease P1b wiring — no rewrite of the
// loaders/console; they keep consuming PanoramaScope / PeriodSearchParams).
// ---------------------------------------------------------------------------

/** Project the ViewState scope onto the existing `PanoramaScope` filter shape. */
export function toScopeFilter(view: PanoramaViewState): PanoramaScope {
  switch (view.scope.kind) {
    case "national":
      return { country: "AR", province: null, locality: null };
    case "province":
      return { country: "AR", province: view.scope.province, locality: null };
    case "locality":
      return { country: "AR", province: view.scope.province, locality: view.scope.locality };
  }
}

/** Project the ViewState period onto the resolver's search-param shape, so
 *  `resolveAnalyticsPeriod(toPeriodSearchParams(view))` yields the {since,until}. */
export function toPeriodSearchParams(view: PanoramaViewState): {
  period?: string;
  from?: string;
  to?: string;
} {
  if (view.period.kind === "preset") return { period: view.period.preset };
  return { period: "custom", from: view.period.from, to: view.period.to };
}

/** Build a ViewScope from the existing `PanoramaScope` shape (P1b entry point). */
export function scopeFromFilter(scope: PanoramaScope): ViewScope {
  if (scope.province && scope.locality) {
    return { kind: "locality", province: scope.province, locality: scope.locality };
  }
  if (scope.province) return { kind: "province", province: scope.province };
  return { kind: "national" };
}

/** The province in scope, or null (national). Used by inset/division projections. */
export function scopeProvince(view: PanoramaViewState): string | null {
  return view.scope.kind === "national" ? null : view.scope.province;
}

/** The DERIVED aggregation level is a pure function of the SCOPE (P4c, design
 *  §5.5): a committed province/locality reads the locality axis; national reads
 *  province at any zoom — level is a projection output, never stored. This
 *  predicate IS that derivation (true ⇒ locality axis). */
export function scopeForcesLocality(view: PanoramaViewState): boolean {
  return view.scope.kind !== "national";
}

/** True when this view can be fully reconstructed from its URL (no ephemeral
 *  field diverges from its default). Used to guard "Copiar vista" honesty.
 *  P5: `encoding` left this list — it serializes now, so it always reproduces. */
export function isUrlReproducible(view: PanoramaViewState): boolean {
  return view.basis === DEFAULT_VIEW_STATE.basis;
}

// A no-op reference so `AggregationLevel` stays imported for the JSDoc contract
// above without a lint unused-import error; the type is part of this module's
// public vocabulary even though the value is derived elsewhere.
export type { AggregationLevel };
