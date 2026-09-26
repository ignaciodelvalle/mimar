// Where a panorama row is attributed — localidades-por-id D6 (flag `panorama`).
//
// NAME PATH (default, what every map served before D6): rows are grouped by
// their stored (province, locality NAME) and joined to ar_localities on the
// folded name; an ambiguous name (Mechita, partido Alberti and partido
// Bragado) is ONE cell whose department MIN() picks — a homonym folded into
// the other's department.
//
// ID PATH: rows are grouped by their catalogue row (locality_id) and joined
// to ar_localities by id, so each homonym is its own cell in its own
// department (statistical geography stays INDEC departments, distinct from
// authority units). A row whose place never resolved (locality_id NULL, but
// a locality text) is never guessed: it is counted in ONE per-province cell,
// "Sin localidad", placed on the province's representative point — visible,
// never dropped, and still under k-anonymity like any other cell.
//
// Rows with no locality text at all keep their existing treatment (the
// no-locality residual each loader already reports).

import { type SQL, sql } from "drizzle-orm";

import { arLocalities, petEvents } from "@/db";
import { readPlaceFlag } from "@/lib/place/flags";

import {
  type RollupRow,
  normNameSql,
  provinceIsoMapSql,
  provinceRepresentativeCentroid,
} from "./repository-scope";

export const SIN_LOCALIDAD = "Sin localidad";
const SIN_LOCALIDAD_SQL = `'${SIN_LOCALIDAD}'`;

export type AttributionMode = "name" | "id";

/** The `panorama` flag as the loaders read it ('shadow' serves the name path). */
export async function panoramaAttributionMode(): Promise<AttributionMode> {
  return (await readPlaceFlag("panorama")) === "id" ? "id" : "name";
}

export type PlaceColumns = { province: SQL; locality: SQL; localityId: SQL };

/** The locality a row is GROUPED under. */
export function groupedLocality(mode: AttributionMode, c: PlaceColumns): SQL<string> {
  return mode === "id"
    ? // A SQL literal, not a bound parameter: the same expression appears in
      // SELECT, GROUP BY and ORDER BY, and Postgres only matches them when
      // they are textually identical (two parameters are two expressions).
      sql<string>`CASE WHEN ${c.localityId} IS NULL THEN ${sql.raw(SIN_LOCALIDAD_SQL)} ELSE ${c.locality} END`
    : sql<string>`${c.locality}`;
}

/** The catalogue row a group carries (NULL on the name path). */
export function groupedLocalityId(mode: AttributionMode, c: PlaceColumns): SQL<string | null> {
  return mode === "id" ? sql<string | null>`${c.localityId}::text` : sql<string | null>`NULL::text`;
}

/**
 * The ar_localities join for a grouped row. `grouped` are the GROUPED
 * expressions (from a pre-aggregated subquery or the same row).
 */
export function catalogueJoin(
  mode: AttributionMode,
  grouped: { province: SQL; locality: SQL; localityId: SQL },
): SQL {
  // Both sides as text: a grouped id arrives as text from a subquery, a raw
  // column as uuid.
  if (mode === "id") return sql`${arLocalities.id}::text = (${grouped.localityId})::text`;
  return sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(grouped.province)}
    AND ${arLocalities.localityNameNorm} = ${normNameSql(grouped.locality)}
    AND ${arLocalities.removedAt} IS NULL`;
}

/** A rollup key that keeps homonyms apart on the id path. */
export function rollupKey(province: string, locality: string, localityId: string | null): string {
  return localityId ? `${province}|${locality}|${localityId}` : `${province}|${locality}`;
}

/**
 * The catalogue row an EVENT happened at (event_places, migration 0250): the
 * event's own resolved place, or its home per the spine for history
 * (scripts/place-backfill-event-places.ts). NULL = never resolved.
 */
export function eventPlaceLocalityIdSql(): SQL {
  return sql`(SELECT ep.locality_id FROM public.event_places ep WHERE ep.event_id = ${petEvents.id})`;
}

/**
 * The locality-grain columns, catalogue join and grouping of a per-unit
 * rollup (repository-by-unit.ts), on the path `mode` selects. The name path
 * renders exactly what the loaders served before D6 (plus a constant NULL id
 * in the grouping, which changes no group).
 */
export function localityRollupShape(mode: AttributionMode, cols: PlaceColumns) {
  const locality = groupedLocality(mode, cols);
  const localityId = groupedLocalityId(mode, cols);
  return {
    columns: {
      province: sql<string | null>`${cols.province}`,
      locality: sql<string | null>`${locality}`,
      localityId: sql<string | null>`${localityId}`,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      // Department roll-up keys (PO "Option A") — pinned deterministically via MIN.
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
    },
    join: catalogueJoin(mode, cols),
    groupBy: [cols.province, locality, localityId],
  };
}

/**
 * Grouped rows → RollupRow. On the id path each homonym keeps its own key, and
 * the per-province "Sin localidad" cell sits on the province's representative
 * point (it has no catalogue row, so no centroid and no department).
 */
export function toLocalityRollupRows(
  mode: AttributionMode,
  rows: ReadonlyArray<{
    province: string | null;
    locality: string | null;
    localityId: string | null;
    centroidLat: string | null;
    centroidLng: string | null;
    departmentCode: string | null;
    departmentName: string | null;
    n: number;
  }>,
): RollupRow[] {
  return rows
    .filter((r) => r.province && r.locality)
    .map((r) => {
      const province = r.province as string;
      const locality = r.locality as string;
      const unresolved = mode === "id" && r.localityId === null;
      return {
        key: rollupKey(province, locality, r.localityId),
        province,
        locality,
        ...(unresolved
          ? provinceRepresentativeCentroid(province)
          : { centroidLat: r.centroidLat, centroidLng: r.centroidLng }),
        departmentCode: r.departmentCode,
        departmentName: r.departmentName,
        count: r.n,
      };
    });
}
