// Pure helpers for the locality-choropleth DIVISION FILL render mode.
//
// A single-province scope now renders real administrative divisions:
//   - CABA (AR-C)  → the 48 barrios      (public/geo/caba-barrios.geojson)
//   - any other    → that province's departamentos (public/geo/ar-departments.geojson)
//
// These outlines are ALWAYS drawn for a scoped province (even with no data — the
// PO directive "siempre mostrar la división al menos"). Where the active locality
// choropleth base layer has data, its cells are joined to the division polygons
// and rendered as a POLYGON FILL, replacing the old graduated centroid-circle
// hack. Cells with NO polygon match fall back to the centroid circle (no data
// loss). Suppressed cells that DO match a division render outline-only (no fill).
//
// Extracted from SituationalMap so the join + color expression are unit-testable
// WITHOUT importing maplibre-gl (only its expression TYPE is imported). The map
// consumes `joinCellsToDivisions` (which FeatureCollection to feed the circle
// source) and `divisionFillColorExpr` (the data-driven polygon fill).

import type { ExpressionSpecification, FilterSpecification } from "maplibre-gl";

import {
  type ClassScale,
  computeClassScale,
  stepColorExpr,
} from "@/components/panorama/class-scale";
import { normalizeBarioCode, normalizeDepartmentCode } from "@/lib/infra/geo-join";
import type { FeatureCollection, PanoramaFeature } from "@/src/modules/panorama/domain/types";

/** Which administrative division a scoped province drills to. */
export type DivisionLevel = "barrio" | "department";

/** The subset of a locality choropleth cell's properties the join reads. */
export type ChoroplethCellProps = {
  province?: string;
  locality?: string;
  departmentCode?: string | null;
  departmentName?: string | null;
  value?: number | null;
  suppressed?: boolean;
};

/**
 * The division join code for one locality choropleth cell.
 *  - `barrio` (CABA): the normalized barrio slug derived from the locality name,
 *    using the SHARED canonical normalizer (lib/infra/geo-join → same slug the
 *    govt dashboards + MapChoropleth compute, so codes never drift).
 *  - `department`: the INDEC 5-digit code the repository carried on the cell
 *    (from ar_localities), zero-padded for safety.
 * Returns null when the cell cannot be mapped to a division (no locality name /
 * no department code) — such a cell falls back to its centroid circle.
 */
export function divisionCodeForCell(
  props: ChoroplethCellProps,
  level: DivisionLevel,
): string | null {
  if (level === "barrio") {
    const raw = props.locality;
    if (!raw) return null;
    const code = normalizeBarioCode(raw);
    return code.length > 0 ? code : null;
  }
  const raw = props.departmentCode;
  if (!raw) return null;
  return normalizeDepartmentCode(raw);
}

/** Result of joining a locality choropleth layer to its division polygons. */
export type DivisionJoin = {
  /**
   * Fill value per division code — the SUM of the non-suppressed cells that map
   * to that division. A department can aggregate several localities; CABA is
   * effectively 1:1. Divisions with no visible cell are absent (→ outline only).
   */
  values: Map<string, number>;
  /**
   * The cells that did NOT match a loaded division polygon (unknown code, or a
   * code not present in this province's division set). These keep their centroid
   * circle so no data is lost. Matched cells — including suppressed ones — are
   * excluded here: a matched suppressed cell renders as an OUTLINE-only division,
   * never also a muted circle (no double-encoding).
   */
  unmatched: FeatureCollection;
  /**
   * cursor #2 — division codes whose matched cells are k-anon SUPPRESSED and
   * which carry NO visible value (so they are absent from `values`). These render
   * with a diagonal HATCH pattern — perceptually distinct from both a colored
   * data cell and an outline-only genuine no-data cell (the honest trichotomy).
   *
   * A division that has SOME visible constituent (present in `values`) is NOT
   * listed here: it renders as a real colored fill, and the suppressed
   * constituents are simply omitted from its sum (existing k-anon behavior). This
   * changes PRESENTATION only — the suppression LOGIC (what is dropped from the
   * sum) is untouched; a suppressed cell still never contributes a number.
   */
  suppressed: Set<string>;
};

/**
 * Join a locality choropleth layer's cells to the active province's division
 * polygons. `divisionCodes` is the set of `code` properties present in the loaded
 * division GeoJSON (barrios or the filtered departamentos).
 *
 * K-anon (k=5) is preserved: a suppressed cell (value=null) never contributes to
 * `values`, so a division whose only cells are suppressed stays fill-less
 * (outline only) — the conservative policy the task mandates. A department whose
 * visible localities cross k while some constituents were suppressed shows the
 * sum of the VISIBLE localities only; the suppressed ones are simply omitted,
 * inventing no new disclosure semantics.
 */
export function joinCellsToDivisions(
  features: FeatureCollection,
  level: DivisionLevel,
  divisionCodes: ReadonlySet<string>,
): DivisionJoin {
  return joinCellsToDivisionsMulti(features, [{ level, codes: divisionCodes }]);
}

/**
 * Generalization of {@link joinCellsToDivisions} to SEVERAL division levels at
 * once — the zoom-driven multi-province case. When the camera zooms past the
 * division threshold with multiple provinces in view, the loaded division source
 * is the UNION of their polygons: departamentos (for every non-CABA province) AND
 * CABA barrios, two different code spaces coexisting in one source.
 *
 * Each cell is tried against the levels in order; the first level whose code set
 * contains the cell's code claims it. The two spaces are disjoint in practice (a
 * departamento cell carries a numeric INDEC code; a CABA barrio cell carries a
 * locality slug), so order is not load-bearing. A cell matched by NO level falls
 * back to its centroid circle (unmatched); k-anon is preserved exactly as in the
 * single-level path — a matched-but-suppressed cell adds no fill (outline only).
 */
// --- Memoization -------------------------------------------------------------
// SituationalMap.syncLayers calls joinCellsToDivisionsMulti on every repaint,
// even when neither the choropleth cells nor the loaded division code sets have
// changed (a dim/legend/asOf-driven re-sync). The join is a PURE function of
// (features, levels), and the caller holds BOTH the features FeatureCollection
// and the code Sets in refs (stable across repaints, rebuilt only on a data or
// province-set change), so we memoize on the FeatureCollection reference — a
// WeakMap key, so a superseded features object is GC'd with its cache entry (no
// leak) — guarded by a cheap version string over the level code-set IDENTITIES.
// A repaint that reuses the same features + same Sets returns the previously
// computed DivisionJoin object BY REFERENCE (skipping the O(features) loop); any
// change in either input misses and recomputes. Referential stability is pinned
// by division-fill.test.ts.

// Stable numeric id per Set instance, so the version string is O(levels) to
// build (never O(codes)) and is identity- not content-based: a new Set with the
// same members is a different scope and correctly misses the cache.
let _setIdSeq = 0;
const _setIds = new WeakMap<object, number>();
function setId(s: ReadonlySet<string>): number {
  let id = _setIds.get(s);
  if (id === undefined) {
    id = ++_setIdSeq;
    _setIds.set(s, id);
  }
  return id;
}

function levelsVersion(
  levels: ReadonlyArray<{ level: DivisionLevel; codes: ReadonlySet<string> }>,
): string {
  return levels.map((l) => `${l.level}#${setId(l.codes)}`).join("|");
}

type JoinCacheEntry = { version: string; result: DivisionJoin };
// `let` (not `const`): WeakMap has no clear(), so the test-only reset rebinds it.
let _joinCache = new WeakMap<FeatureCollection, JoinCacheEntry>();

/** Test-only: drop the memo so referential-stability cases start from a clean slate. */
export function __resetDivisionJoinCache(): void {
  _joinCache = new WeakMap<FeatureCollection, JoinCacheEntry>();
}

export function joinCellsToDivisionsMulti(
  features: FeatureCollection,
  levels: ReadonlyArray<{ level: DivisionLevel; codes: ReadonlySet<string> }>,
): DivisionJoin {
  const version = levelsVersion(levels);
  const cached = _joinCache.get(features);
  if (cached && cached.version === version) return cached.result;
  const result = computeDivisionJoin(features, levels);
  _joinCache.set(features, { version, result });
  return result;
}

function computeDivisionJoin(
  features: FeatureCollection,
  levels: ReadonlyArray<{ level: DivisionLevel; codes: ReadonlySet<string> }>,
): DivisionJoin {
  const values = new Map<string, number>();
  const unmatched: PanoramaFeature[] = [];
  // Codes that had at least one matched SUPPRESSED cell — resolved against
  // `values` after the loop so a division with any visible constituent stays a
  // colored fill (not hatched).
  const suppressedSeen = new Set<string>();

  for (const f of features.features) {
    const props = (f.properties ?? {}) as ChoroplethCellProps;
    let matched = false;
    for (const { level, codes } of levels) {
      const code = divisionCodeForCell(props, level);
      if (code === null || !codes.has(code)) continue;
      matched = true;
      // Matched: contributes to the fill only when visible (k-anon). A matched
      // but suppressed cell is intentionally dropped from the sum → it renders
      // as a HATCH (below) if no visible constituent covers the same division.
      if (props.suppressed === true) {
        suppressedSeen.add(code);
      } else if (typeof props.value === "number") {
        values.set(code, (values.get(code) ?? 0) + props.value);
      }
      break;
    }
    if (!matched) unmatched.push(f);
  }

  // A division is HATCHED only when it is suppressed AND has no visible value —
  // otherwise the visible sum wins and the cell is a normal colored fill.
  const suppressed = new Set<string>();
  for (const code of suppressedSeen) {
    if (!values.has(code)) suppressed.add(code);
  }

  return { values, unmatched: { type: "FeatureCollection", features: unmatched }, suppressed };
}

/** A fully-transparent fill — a division with no (visible) data shows outline only. */
const TRANSPARENT = "rgba(0,0,0,0)";

/**
 * Build the data-driven `fill-color` for the division choropleth. Mirrors the
 * province choropleth's structure (a `match` on the polygon `code` → value, then
 * a THRESHOLD-CLASSED `["step", …]` across the dark-map ramp — see class-scale.ts)
 * but paints divisions WITHOUT a value transparent instead of the no-data grey —
 * the always-visible outline is the "no data" signal, so an unfilled division must
 * let it show through.
 *
 * Division fill is a drill-level view with no policy meta (the divergent-vs-meta
 * scale is province-only in v1), so the breaks are QUANTILE over the visible
 * division values — frozen across a scrub via `lockedBreaks` (still quantile), so a
 * division keeps the same class-color across every as-of frame.
 *
 * Returns a flat transparent expression when there are no values (nothing to
 * fill — only outlines).
 */
export function divisionFillColorExpr(
  values: ReadonlyMap<string, number>,
  // Optional frozen breaks (fix: time-scrub color-scale lock). When supplied, the
  // classed scale renders these frozen live-edge quantile breaks instead of the
  // frame's own quantiles, so a value keeps the same class-color across every
  // as-of frame of a scrub.
  lockedBreaks?: readonly number[] | null,
  // ONE polarity convention across the console (PO decision D4, 2026-07-28):
  // dark = alarm, always. The province branch has always inverted the ramp for
  // a layer that declares `higherIsBetter`; this branch never received the flag,
  // so drilling in flipped the meaning of dark under the reader — acceso-
  // veterinario read dark = fewer acts (worse) at province level and dark = more
  // attended pets (better) one zoom later, under the same legend (P1-F1).
  opts?: { invert?: boolean },
): ExpressionSpecification {
  return divisionFillFromScale(
    values,
    computeClassScale([...values.values()], {
      lockedBreaks: lockedBreaks ?? null,
      invert: opts?.invert === true,
    }),
  );
}

/**
 * Assemble the division `fill-color` from an ALREADY-RESOLVED ClassScale — the
 * province path's `classedProvinceFill` counterpart, and for the same reason:
 * the scale is passed in, never recomputed here, so a caller that ALSO shows the
 * scale (the legend) can hand the identical object to both surfaces.
 *
 * Returns a flat transparent expression when there are no values (nothing to
 * fill — only outlines).
 */
export function divisionFillFromScale(
  values: ReadonlyMap<string, number>,
  scale: ClassScale,
): ExpressionSpecification {
  if (values.size === 0) return TRANSPARENT as unknown as ExpressionSpecification;

  const valueMatch = [
    "match",
    ["get", "code"],
    ...[...values].flatMap(([code, value]) => [code, value] as [string, number]),
    -1,
  ] as unknown as ExpressionSpecification;

  return [
    "case",
    ["==", valueMatch, -1],
    TRANSPARENT,
    stepColorExpr(valueMatch, scale),
  ] as unknown as ExpressionSpecification;
}

/**
 * cursor #2 — build the MapLibre `filter` that selects the SUPPRESSED division
 * polygons (for the diagonal-hatch overlay). Matches the shared-source `code`
 * property against the suppressed code set. Returns a constant-`false` filter
 * when the set is empty so the hatch layer renders nothing (never everything).
 */
export function divisionSuppressedFilter(codes: ReadonlySet<string>): FilterSpecification {
  if (codes.size === 0) return false as unknown as FilterSpecification;
  return ["match", ["get", "code"], [...codes], true, false] as unknown as FilterSpecification;
}

/**
 * D.5(b) — build the MapLibre `filter` that selects the NO-DATA division
 * polygons (for the stipple overlay): everything that is neither valued nor
 * suppressed.
 *
 * Expressed as a COMPLEMENT on purpose. The no-data set is not computed
 * anywhere — the join only knows what it matched — and enumerating it would
 * mean walking the geojson and keeping a fourth set in sync with the other
 * three. The complement needs no such bookkeeping: a division the join never
 * accounted for is, by definition, one we have nothing to say about.
 *
 * When NOTHING is known (empty map, failed load) this returns a constant-`true`
 * filter, so the whole grain is stippled. That is the honest reading: a map
 * with no data anywhere should look like it, not like bare land.
 */
export function divisionNoDataFilter(
  valued: ReadonlyMap<string, number>,
  suppressed: ReadonlySet<string>,
): FilterSpecification {
  const known = new Set<string>([...valued.keys(), ...suppressed]);
  if (known.size === 0) return true as unknown as FilterSpecification;
  return [
    "!",
    ["match", ["get", "code"], [...known], true, false],
  ] as unknown as FilterSpecification;
}

/**
 * Whether the division stipple is actually painted on at least one polygon —
 * the gate the legend's "Sin datos (solo contorno)" key must pass.
 *
 * RA-7 F9 (2026-07-31). That key rendered unconditionally on every drilled
 * frame, so a scope whose every departamento carries a value still advertised a
 * mark the canvas does not paint. Same complement `divisionNoDataFilter` uses
 * (valued ∪ suppressed), measured against the number of polygons actually in
 * the shared division source — which is the set the filter is evaluated over, so
 * key and overlay answer from the same arithmetic.
 *
 * `divisionsInSource === 0` → there is no polygon to stipple, so nothing is
 * painted, even though the filter's empty-`known` branch is constant-`true`.
 */
export function divisionPaintsNoData(
  valued: ReadonlyMap<string, number>,
  suppressed: ReadonlySet<string>,
  divisionsInSource: number,
): boolean {
  if (divisionsInSource <= 0) return false;
  const known = new Set<string>([...valued.keys(), ...suppressed]);
  return known.size < divisionsInSource;
}

/** value min/max over a division values map (for the fill legend). null when empty. */
export function divisionValueBounds(
  values: ReadonlyMap<string, number>,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/**
 * Filter a raw ar-departments FeatureCollection to the departamentos of one
 * province, by INDEC prefix (first 2 digits of the 5-digit code). Keeps the perf
 * budget: the 693 KB national file is fetched once but only the active province's
 * polygons are handed to MapLibre as a source.
 */
export function filterDepartmentsByPrefix(
  fc: { features: Array<{ properties?: { code?: string } | null }> },
  prefix: string,
): Array<{ properties?: { code?: string } | null }> {
  return fc.features.filter((f) => {
    const code = f.properties?.code;
    return typeof code === "string" && normalizeDepartmentCode(code).startsWith(prefix);
  });
}

/**
 * THE division ramp for a LAYER: the ONE resolved ClassScale that the drilled
 * fill paints — polarity included (D4: dark = alarm, always).
 *
 * Read by the fill (`divisionFillForLayer`) AND by the legend descriptor
 * SituationalMap lifts to MapLegends / LegendPill, so the swatches and the
 * polygons come from the same object.
 *
 * WHY this exists (PO 2026-08-01, "las referencias de colores no son
 * consistentes con lo mostrado en el mapa"): `divisionFillForLayer` honoured
 * `higherIsBetter` (P1-F1) but the legend descriptor re-derived its own scale
 * with a bare `computeClassScale(values, { lockedBreaks })` — the flag never
 * crossed over. On `acceso-veterinario`, the only drillable higher-is-better
 * layer, that printed the ramp EXACTLY BACKWARDS: the legend's darkest swatch
 * sat on the highest count while the map painted its darkest polygons on the
 * lowest. Both the dock's "Referencias" swatches and the collapsed pill's ramp
 * (which falls back to these same `colors`) carried the reversal, which is why
 * the PO saw it collapsed AND expanded. The breaks always matched — `invert`
 * only reassigns colours — so the numbers were right and the colours lied,
 * the least detectable form of the defect.
 */
export function divisionClassScaleForLayer(
  layer: { higherIsBetter?: boolean },
  values: ReadonlyMap<string, number>,
  lockedBreaks?: readonly number[] | null,
): ClassScale {
  return computeClassScale([...values.values()], {
    lockedBreaks: lockedBreaks ?? null,
    invert: layer.higherIsBetter === true,
  });
}

/**
 * The division fill for a LAYER — built from {@link divisionClassScaleForLayer},
 * so the callers do not each have to remember the polarity rule.
 *
 * The map had three call sites all passing `{ invert: layer.higherIsBetter }`
 * by hand; the polarity rule belongs beside the ramp it governs, not repeated
 * at every place a ramp is painted.
 */
export function divisionFillForLayer(
  layer: { higherIsBetter?: boolean },
  values: ReadonlyMap<string, number>,
  lockedBreaks?: readonly number[] | null,
): ExpressionSpecification {
  return divisionFillFromScale(values, divisionClassScaleForLayer(layer, values, lockedBreaks));
}
