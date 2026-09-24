// Location accessor layer.
//
// App code MUST NOT read pet_events.locationLat / pet_events.locationLng or
// welfare_reports.locationLat / welfare_reports.locationLng directly. Use the
// helpers in this file. This is the single swap point for the future PostGIS
// migration: today readPoint pulls two `numeric(10,7)` columns; the day we
// add `location_point geography(Point, 4326)` and drop the lat/lng pair, the
// signature stays the same and only the body changes.
//
// Why numeric and not float8?
//   - `numeric(10,7)` gives exact decimal storage to 7 decimal places (~1cm
//     resolution), comfortably enough for "where did I last see my pet?"
//     and "vet visit GPS pin".
//   - Drizzle returns `numeric` columns as JS `string` so reads need a
//     deliberate Number() conversion. Doing it in one place catches the
//     well-known traps: `Number(null) === 0`, `Number("") === 0`,
//     `Number("not a number") === NaN`. None of those should ever look like
//     a real coordinate.

export type Point = { lat: number; lng: number };

/**
 * Read a {@link Point} from a row. The source values may be `null`, a numeric
 * string (e.g. `"-34.6083000"`), or a number. Any NaN, Infinity, or
 * empty-string value returns `null` rather than silently pretending to be
 * `0,0` (which would map to the middle of the Atlantic).
 *
 * Reads from the canonical `locationLat`/`locationLng` columns. This is the
 * PostGIS swap contract — when PostGIS lands, only the body changes.
 */
export function readPoint(row: Record<string, unknown>): Point | null {
  const lat = coerce(row.locationLat);
  const lng = coerce(row.locationLng);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/** Presentation precision for a {@link Point}, selected per audience. */
export type PointPrecision = "exact" | "approx";

/**
 * Reduce a point's precision for public presentation. Audience-precision plan
 * (2026-06-19): the stored coordinate stays exact, but each audience sees only
 * the precision its function needs. The authority (Ley 14.346 — maltrato, the
 * investigative/decomiso need) sees `"exact"`; the public tracking receipt sees
 * `"approx"` (Ley 25.326 — data minimisation), so a reference-code holder can't
 * pin the exact denounced site (and, by elevation, de-anonymise the victim or
 * reporter).
 *
 * Does NOT mutate the stored value — this only changes presentation output.
 *
 * Deterministic grid rounding, NOT random jitter: repeated loads must return the
 * SAME coarse value, otherwise a holder could average many reads to triangulate
 * the true point. `"approx"` rounds to 3 decimals (~110 m at AR latitudes) —
 * enough to place the report in a neighbourhood without a street-level pin.
 */
export function coarsenPoint(point: Point, precision: PointPrecision): Point {
  // Defensive copy even for "exact": callers must never be able to mutate the
  // source Point through the returned value.
  if (precision === "exact") return { lat: point.lat, lng: point.lng };
  // `+ 0` normalises a negative-zero result (e.g. -0.0004 → Math.round(-0.4)/1000
  // is -0) back to 0 so the value JSON-serialises consistently.
  const round = (n: number) => Math.round(n * 1000) / 1000 + 0;
  return { lat: round(point.lat), lng: round(point.lng) };
}

/**
 * Convert a {@link Point} (or `null`) to the shape Drizzle expects when
 * writing into `numeric(10,7)` columns. Numeric values must be passed as
 * strings to avoid silent precision loss; the `toFixed(7)` truncation keeps
 * the value within the column's declared scale.
 *
 * Pass `null` to clear both columns (e.g. when erasing a previously stored
 * point). Always writes to the canonical `locationLat`/`locationLng` columns.
 */
export function writePoint(point: Point | null): {
  locationLat: string | null;
  locationLng: string | null;
} {
  if (!point) return { locationLat: null, locationLng: null };
  // Guard against NaN / Infinity — Postgres would reject "NaN" with an
  // invalid_text_representation error far from the call site. Caller-side
  // validation is the first line of defense; this is defense in depth so
  // every future caller doesn't have to remember the precondition.
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    throw new Error(
      `writePoint requires finite coordinates, got lat=${point.lat}, lng=${point.lng}`,
    );
  }
  return {
    locationLat: point.lat.toFixed(7),
    locationLng: point.lng.toFixed(7),
  };
}

export function coerce(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // Reject empty strings explicitly — Number("") is 0, which would otherwise
  // pass the isFinite check and look like a valid coordinate.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
