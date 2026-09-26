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

import { arLocalities } from "@/db";
import { readPlaceFlag } from "@/lib/place/flags";

import { normNameSql, provinceIsoMapSql } from "./repository-scope";

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
  if (mode === "id") return sql`${arLocalities.id}::text = ${grouped.localityId}`;
  return sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(grouped.province)}
    AND ${arLocalities.localityNameNorm} = ${normNameSql(grouped.locality)}
    AND ${arLocalities.removedAt} IS NULL`;
}

/** A rollup key that keeps homonyms apart on the id path. */
export function rollupKey(province: string, locality: string, localityId: string | null): string {
  return localityId ? `${province}|${locality}|${localityId}` : `${province}|${locality}`;
}
