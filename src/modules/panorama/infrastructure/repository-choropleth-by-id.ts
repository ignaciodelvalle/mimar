// The ID PATH of the per-locality choropleth rollup (localidades-por-id D6),
// split out of repository-choropleth.ts (file-size fence). The name path and
// the flag switch stay there; rollupPetsPerLocality calls this when the
// `panorama` flag (or an explicit mode) is 'id'.

import { type SQL, and, asc, countDistinct, desc, sql } from "drizzle-orm";

import { arLocalities, type analyticsDb as db, pets } from "@/db";

import { catalogueJoin, groupedLocality, groupedLocalityId, rollupKey } from "./place-attribution";
import { PER_LAYER_CAP, type RollupRow, provinceRepresentativeCentroid } from "./repository-scope";

export type AnalyticsExecutor = Pick<typeof db, "select">;

/**
 * The ID PATH of rollupPetsPerLocality (localidades-por-id D6): grouped by
 * catalogue row, joined to ar_localities by id — each homonym is its own
 * cell in its own department; an unresolved pet lands in its province's
 * "Sin localidad" cell on the province's representative point. Same cap and
 * same total order as the name path.
 */
export async function rollupPetsPerLocalityById(
  exec: AnalyticsExecutor,
  conditions: SQL[],
): Promise<RollupRow[]> {
  const cols = {
    province: sql`${pets.jurisdictionProvince}`,
    locality: sql`${pets.jurisdictionLocality}`,
    localityId: sql`${pets.localityId}`,
  };
  const groupedName = groupedLocality("id", cols);
  const groupedId = groupedLocalityId("id", cols);
  const agg = exec
    .select({
      province: pets.jurisdictionProvince,
      locality: sql<string>`${groupedName}`.as("locality"),
      localityId: sql<string | null>`${groupedId}`.as("locality_id"),
      n: countDistinct(pets.id).as("n"),
    })
    .from(pets)
    .where(and(...conditions))
    .groupBy(pets.jurisdictionProvince, groupedName, groupedId)
    .orderBy(
      desc(countDistinct(pets.id)),
      asc(pets.jurisdictionProvince),
      asc(groupedName),
      asc(groupedId),
    )
    .limit(PER_LAYER_CAP)
    .as("agg");
  const rows = await exec
    .select({
      province: agg.province,
      locality: agg.locality,
      localityId: agg.localityId,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: agg.n,
    })
    .from(agg)
    .leftJoin(
      arLocalities,
      catalogueJoin("id", {
        province: sql`${agg.province}`,
        locality: sql`${agg.locality}`,
        localityId: sql`${agg.localityId}`,
      }),
    )
    .groupBy(agg.province, agg.locality, agg.localityId, agg.n)
    .orderBy(desc(agg.n), asc(agg.province), asc(agg.locality), asc(agg.localityId));

  return rows
    .filter((r) => r.province !== null && r.locality !== null)
    .map((r) => {
      const unresolved = r.localityId === null;
      const centroid = unresolved
        ? provinceRepresentativeCentroid(r.province)
        : { centroidLat: r.centroidLat, centroidLng: r.centroidLng };
      return {
        key: rollupKey(r.province as string, r.locality as string, r.localityId),
        province: r.province as string,
        locality: r.locality as string,
        ...centroid,
        departmentCode: r.departmentCode,
        departmentName: r.departmentName,
        count: r.n,
      };
    });
}
