// Helpers for reading the canonical INDEC locality catalog (ar_localities).
//
// Pairs with lib/ar-provincias.ts (the static provincia catalog). The split
// between the two is intentional: provincias are 24 entries and fit in code;
// localidades are ~4500 and live in the DB.
//
// Every read filters by removed_at IS NULL so soft-deleted rows from past
// import runs never bleed into UI or validation paths.

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { type ArgentineLocality, arLocalities, db } from "@/db";
import { type ProvinceCode, provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

// isWholeProvinceAggregate lives in the pure lib/reference layer so the INDEC
// importer and the CI guard can reuse it without dragging @/db / server-only.
// Re-exported here for the runtime belt below and existing call sites/tests.
export { isWholeProvinceAggregate } from "@/lib/reference/locality-integrity";
import { isWholeProvinceAggregate } from "@/lib/reference/locality-integrity";

export type Locality = {
  /** ar_localities primary key (uuid). The structural locality-attribution FK
   * target (pets/welfare/cases.locality_id). Present on every catalog row,
   * including CABA barrios whose indecId is null. */
  id: string;
  indecId: string | null;
  provinceCode: ProvinceCode;
  departmentName: string | null;
  departmentCode: string | null;
  localityName: string;
  localitySlug: string;
  category: ArgentineLocality["category"];
};

export type LocalitySearchResult = Locality & {
  provinceName: string;
  matchKind: "exact" | "prefix" | "contains";
};

/**
 * Minimal shape expected by <JurisdictionSwitcher localities={...}>.
 * Returned by listLocalitiesByProvince for direct use as a prop.
 */
export type LocalityOption = { slug: string; name: string };

/**
 * [lng, lat] centroid for a locality, keyed by locality slug.
 * Only entries with non-null coordinates are included.
 * Used by SituationalMap to autozoom when a locality is selected (A1 PR-7).
 */
export type LocalityCentroids = Record<string, [number, number]>;

const MIN_QUERY_LENGTH = 2;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rowToLocality(row: ArgentineLocality): Locality {
  return {
    id: row.id,
    indecId: row.indecId,
    provinceCode: row.provinceCode as ProvinceCode,
    departmentName: row.departmentName,
    departmentCode: row.departmentCode,
    localityName: row.localityName,
    localitySlug: row.localitySlug,
    category: row.category as ArgentineLocality["category"],
  };
}

export async function localityByIndecId(indecId: string): Promise<Locality | null> {
  const [row] = await db
    .select()
    .from(arLocalities)
    .where(and(eq(arLocalities.indecId, indecId), isNull(arLocalities.removedAt)));
  return row ? rowToLocality(row) : null;
}

// Find a single locality by free-text name within a province. INDEC ships
// ambiguous (province, name) pairs in 68 cases — when this happens we return
// the first row deterministically (ordered by department to keep test
// stability). Callers that need to disambiguate should use searchLocalities
// and present alternatives.
export async function localityByName(
  provinceCode: ProvinceCode,
  name: string | null | undefined,
): Promise<Locality | null> {
  if (!name) return null;
  const normalized = normalize(name);
  const slugCandidate = normalized.replace(/\s+/g, "-");

  const [bySlug] = await db
    .select()
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, provinceCode),
        eq(arLocalities.localitySlug, slugCandidate),
        isNull(arLocalities.removedAt),
      ),
    )
    .orderBy(arLocalities.departmentName)
    .limit(1);
  if (bySlug) return rowToLocality(bySlug);

  // Fallback: case-insensitive name comparison. Cheaper than a full table scan
  // because the province filter narrows to ~150 rows max for any province.
  const [byNameCi] = await db
    .select()
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, provinceCode),
        sql`lower(${arLocalities.localityName}) = lower(${name})`,
        isNull(arLocalities.removedAt),
      ),
    )
    .orderBy(arLocalities.departmentName)
    .limit(1);
  return byNameCi ? rowToLocality(byNameCi) : null;
}

export async function isCanonicalLocality(
  provinceCodeOrName: string,
  localityName: string,
): Promise<boolean> {
  const province = provinceByCode(provinceCodeOrName) ?? provinceByName(provinceCodeOrName);
  if (!province) return false;
  return (await localityByName(province.code as ProvinceCode, localityName)) !== null;
}

/**
 * Returns all non-removed localities for a given province, ordered
 * alphabetically by locality_name. Shape matches <JurisdictionSwitcher
 * localities={...}> directly.
 *
 * Returns [] when the catalog is empty (import has not run yet) so the
 * locality select stays disabled rather than erroring.
 */
export async function listLocalitiesByProvince(
  provinceCode: ProvinceCode,
): Promise<LocalityOption[]> {
  const rows = await db
    .select({
      localitySlug: arLocalities.localitySlug,
      localityName: arLocalities.localityName,
      departmentCode: arLocalities.departmentCode,
    })
    .from(arLocalities)
    .where(and(eq(arLocalities.provinceCode, provinceCode), isNull(arLocalities.removedAt)))
    .orderBy(asc(arLocalities.localityName));

  // Belt against the province-as-locality overlap (INDEC ships CABA as a
  // whole-city "componente" that double-counts its 48 barrios). See
  // isWholeProvinceAggregate — drops only the aggregate, keeps every real
  // locality and every capital city.
  return rows
    .filter(
      (r) =>
        !isWholeProvinceAggregate({
          provinceCode,
          localityName: r.localityName,
          departmentCode: r.departmentCode,
        }),
    )
    .map((r) => ({ slug: r.localitySlug, name: r.localityName }));
}

/**
 * Returns a centroid map (slug → [lng, lat]) for all localities in a province
 * that have non-null coordinates in the INDEC catalog.
 *
 * Used by the Panorama SituationalMap to autozoom when an operator selects a
 * locality from the JurisdictionSwitcher (A1 PR-7). The centroids are computed
 * once on the server and passed as a prop so the client never needs a DB call.
 *
 * Entries with null latitude or longitude are omitted from the result.
 */
export async function listLocalityCentroids(
  provinceCode: ProvinceCode,
): Promise<LocalityCentroids> {
  const rows = await db
    .select({
      localitySlug: arLocalities.localitySlug,
      latitude: arLocalities.latitude,
      longitude: arLocalities.longitude,
    })
    .from(arLocalities)
    .where(and(eq(arLocalities.provinceCode, provinceCode), isNull(arLocalities.removedAt)));

  const out: LocalityCentroids = {};
  for (const r of rows) {
    if (r.latitude !== null && r.longitude !== null) {
      out[r.localitySlug] = [Number(r.longitude), Number(r.latitude)];
    }
  }
  return out;
}

export async function searchLocalities(input: {
  provinceCode?: ProvinceCode;
  query: string;
  limit?: number;
}): Promise<LocalitySearchResult[]> {
  const limit = Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const q = normalize(input.query);
  if (q.length < MIN_QUERY_LENGTH) return [];
  const qSlug = q.replace(/\s+/g, "-");
  // Build the "contains" pattern from the normalized slug (accent- and
  // case-folded) and match it against locality_slug — NOT a raw ILIKE on
  // locality_name. Postgres ILIKE is case-insensitive but accent-SENSITIVE, so
  // `%${input.query}%` on the display name missed mid-string matches when the
  // query's accents didn't match (e.g. "cordoba" vs stored "Córdoba"). Matching
  // the already-normalized slug makes all three score branches behave uniformly.
  const qContains = `%${qSlug}%`;
  const qPrefix = `${qSlug}%`;

  const scoreExpr = sql<number>`(
    case
      when ${arLocalities.localitySlug} = ${qSlug} then 1000
      when ${arLocalities.localitySlug} like ${qPrefix} then 100
      when ${arLocalities.localitySlug} like ${qContains} then 10
      else 0
    end
  )`;

  // Category priority: ciudad > localidad > pueblo > barrio > comuna > componente.
  // Within the same score bucket, prefer larger / more recognizable categories.
  const categoryPriorityExpr = sql<number>`(
    case ${arLocalities.category}
      when 'ciudad' then 6
      when 'localidad' then 5
      when 'pueblo' then 4
      when 'barrio' then 3
      when 'comuna' then 2
      when 'componente' then 1
      else 0
    end
  )`;

  const conditions = [isNull(arLocalities.removedAt), sql`${scoreExpr} > 0`];
  if (input.provinceCode) conditions.push(eq(arLocalities.provinceCode, input.provinceCode));

  const rows = await db
    .select({
      id: arLocalities.id,
      indecId: arLocalities.indecId,
      provinceCode: arLocalities.provinceCode,
      departmentName: arLocalities.departmentName,
      departmentCode: arLocalities.departmentCode,
      localityName: arLocalities.localityName,
      localitySlug: arLocalities.localitySlug,
      category: arLocalities.category,
      score: scoreExpr,
    })
    .from(arLocalities)
    .where(and(...conditions))
    .orderBy(sql`${scoreExpr} desc, ${categoryPriorityExpr} desc, ${arLocalities.localityName} asc`)
    .limit(limit);

  return rows.map(
    (r): LocalitySearchResult => ({
      id: r.id,
      indecId: r.indecId,
      provinceCode: r.provinceCode as ProvinceCode,
      provinceName: provinceByCode(r.provinceCode)?.name ?? r.provinceCode,
      departmentName: r.departmentName,
      departmentCode: r.departmentCode,
      localityName: r.localityName,
      localitySlug: r.localitySlug,
      category: r.category as Locality["category"],
      matchKind: r.score >= 1000 ? "exact" : r.score >= 100 ? "prefix" : "contains",
    }),
  );
}

/** A catalog locality near a point, with its approximate distance to it. */
export type NearbyLocality = {
  id: string;
  provinceCode: ProvinceCode;
  localityName: string;
  distanceKm: number;
};

/** Kilometres per degree of latitude (mean Earth radius 6371 km). */
const KM_PER_DEGREE = 111.195;

/**
 * Equirectangular distance in km from a catalog centroid to `point` — exact
 * enough at the tens-of-kilometres scale it is used for, and plain arithmetic
 * (the local stack has no PostGIS). Rows without a centroid come out NULL.
 */
function distanceKmSql(point: { lat: number; lng: number }) {
  return sql<number | null>`(${KM_PER_DEGREE} * sqrt(
    power(${arLocalities.latitude}::float8 - ${point.lat}::float8, 2) +
    power((${arLocalities.longitude}::float8 - ${point.lng}::float8) * cos(radians(${point.lat}::float8)), 2)
  ))`;
}

/**
 * The `limit` catalog localities whose centroid lies closest to `point`,
 * nearest first. Rows without a centroid are skipped. Used to CORROBORATE a
 * client-supplied jurisdiction against the coordinates that came with it —
 * never to derive one (see lib/infra/jurisdiction-from-text.ts).
 */
export async function nearestLocalities(input: {
  lat: number;
  lng: number;
  limit: number;
}): Promise<NearbyLocality[]> {
  const distance = distanceKmSql(input);
  const rows = await db
    .select({
      id: arLocalities.id,
      provinceCode: arLocalities.provinceCode,
      localityName: arLocalities.localityName,
      distanceKm: distance,
    })
    .from(arLocalities)
    .where(
      and(
        isNull(arLocalities.removedAt),
        sql`${arLocalities.latitude} IS NOT NULL`,
        sql`${arLocalities.longitude} IS NOT NULL`,
      ),
    )
    .orderBy(asc(distance))
    .limit(input.limit);
  return rows.map((r) => ({
    id: r.id,
    provinceCode: r.provinceCode as ProvinceCode,
    localityName: r.localityName,
    distanceKm: Number(r.distanceKm),
  }));
}

/**
 * Distance in km from one catalog locality's centroid to `point`, or null when
 * the row is missing, removed, or has no centroid.
 */
export async function localityDistanceKm(
  localityId: string,
  point: { lat: number; lng: number },
): Promise<number | null> {
  const [row] = await db
    .select({ distanceKm: distanceKmSql(point) })
    .from(arLocalities)
    .where(and(eq(arLocalities.id, localityId), isNull(arLocalities.removedAt)))
    .limit(1);
  if (!row || row.distanceKm === null) return null;
  return Number(row.distanceKm);
}
