// Reusable department/barrio-level aggregation for the scope-aware choropleth
// drill (design/scoped-choropleth-drill, engram #1481).
//
// Extracted from vigilancia's fetchCasesPerSubregion (govt-dashboards.ts) so
// ANY /gob screen with its own scoped entity rows (locality + a numeric value)
// can drill its choropleth to department (or barrio, for CABA) grain without
// re-deriving the ar_localities join. fetchCasesPerSubregion is now a thin
// wrapper over aggregateRowsByDepartment — see govt-dashboards.ts.
//
// Contract: `rows` are the CALLER's own already jurisdiction-scoped entity
// rows (one row per source record, or already summed per locality — this
// sums either way). This module resolves each row's raw locality name to its
// department (via ar_localities.departmentCode) or barrio slug (CABA), sums
// `value` per resolved code over the FULL sub-region set (every department /
// barrio gets an entry, 0-default when nothing resolved to it — so "no data"
// renders grey, not suppressed), and redacts sub-k cells (k=5) before
// returning. No caller ever sees a raw count in the 1..4 range.
//
// NOTHING IS DROPPED SILENTLY (L1·1, locality plan 2026-09-08). A row that
// resolves to no department/barrio — null locality, the whole-province
// sentinel, a name outside the catalog — is summed into `sinUbicacion`, which
// the /gob screens print under the map ("N sin ubicar"). Before, those rows
// fell through a bare `continue`, and the map and the table next to it
// disagreed with nothing on screen saying so.

import { arLocalities, analyticsDb as db } from "@/db";
import { normalizeBarioCode } from "@/lib/infra/geo-join";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  type SubregionAggregate,
  type SubregionCaseCount,
  redactSubregionAggregate,
} from "./subregion-redaction";

export type SubregionInputRow = {
  /** Raw (unnormalized) locality name, as stored on the caller's entity table. */
  locality: string | null;
  /** Value to fold into the resolved sub-region (e.g. 1 per row, or a pre-summed count). */
  value: number;
};

/**
 * Aggregates already-scoped entity rows into department (or barrio, for
 * CABA) cells for the given province.
 *
 * Locality→department resolution reuses the ar_localities.departmentCode
 * mapping — the same single source of truth Panorama's division-fill and
 * the pre-extraction fetchCasesPerSubregion both used. CABA (provinceIso ===
 * "AR-C") resolves to barrio slugs instead, via the canonical
 * normalizeBarioCode (matches caba-barrios.geojson `code`).
 *
 * k-anonymity: routes every return through redactSmallSubregionCells (k=5) —
 * this is the ONLY place that boundary needs to be enforced; callers never
 * receive a raw count in the 1..4 range.
 */
export async function aggregateRowsByDepartment(
  provinceIso: string,
  rows: SubregionInputRow[],
): Promise<SubregionAggregate> {
  if (provinceIso === "AR-C") {
    return aggregateRowsByBarrio(rows);
  }

  const province = provinceByCode(provinceIso);
  if (!province) return { cells: [], sinUbicacion: { count: 0, suppressed: false } };

  // 1. Full department set: every distinct (code, name) in the province.
  //    Iterating in (code, name) order makes the first name per code
  //    deterministic (defensive — department codes are 1:1 with names in
  //    practice).
  const deptRows = await db
    .select({ code: arLocalities.departmentCode, name: arLocalities.departmentName })
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, provinceIso),
        isNull(arLocalities.removedAt),
        isNotNull(arLocalities.departmentCode),
      ),
    )
    .orderBy(arLocalities.departmentCode, arLocalities.departmentName);

  const fullSet = new Map<string, SubregionCaseCount>();
  for (const r of deptRows) {
    if (!r.code) continue;
    if (fullSet.has(r.code)) continue; // first name wins (alpha order) = deterministic
    fullSet.set(r.code, { code: r.code, name: r.name ?? r.code, count: 0 });
  }

  // 2. locality name -> a SINGLE deterministic department. Normalized with
  //    normalizeBarioCode — the same accent/case/dot/whitespace fold the
  //    pre-extraction SQL normNameSql used, so a name normalized here matches
  //    a name normalized on the caller's side identically.
  const localityRows = await db
    .select({ name: arLocalities.localityName, departmentCode: arLocalities.departmentCode })
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, provinceIso),
        isNull(arLocalities.removedAt),
        isNotNull(arLocalities.departmentCode),
      ),
    )
    .orderBy(arLocalities.localityName, arLocalities.departmentName);

  const deptByLocalityKey = new Map<string, string>();
  for (const r of localityRows) {
    if (!r.departmentCode) continue;
    const key = normalizeBarioCode(r.name);
    if (deptByLocalityKey.has(key)) continue; // first row wins = deterministic
    deptByLocalityKey.set(key, r.departmentCode);
  }

  // 3. Fold each input row's value into its single resolved department. A row
  //    that resolves to none (null locality, the "" whole-province sentinel, a
  //    name outside the catalog) goes to the residual instead of vanishing.
  let residual = 0;
  for (const r of rows) {
    const deptCode = r.locality ? deptByLocalityKey.get(normalizeBarioCode(r.locality)) : undefined;
    const entry = deptCode ? fullSet.get(deptCode) : undefined;
    if (entry) entry.count += r.value;
    else residual += r.value;
  }

  return redactSubregionAggregate([...fullSet.values()], residual);
}

// CABA (AR-C): fold rows to barrio slugs, emitting the FULL set of barrios
// (0-default), excluding the catch-all "Ciudad Autónoma de Buenos Aires" row.
async function aggregateRowsByBarrio(rows: SubregionInputRow[]): Promise<SubregionAggregate> {
  const barrioRows = await db
    .select({ name: arLocalities.localityName })
    .from(arLocalities)
    .where(and(eq(arLocalities.provinceCode, "AR-C"), isNull(arLocalities.removedAt)));

  // A null or empty locality is the residual straight away; so is the city-wide
  // INDEC name and anything that is not a barrio — see the tally below.
  let residual = 0;
  const valueByCode = new Map<string, number>();
  for (const r of rows) {
    if (!r.locality) {
      residual += r.value;
      continue;
    }
    const code = normalizeBarioCode(r.locality);
    valueByCode.set(code, (valueByCode.get(code) ?? 0) + r.value);
  }

  const byCode = new Map<string, SubregionCaseCount>();
  for (const b of barrioRows) {
    if (b.name === "Ciudad Autónoma de Buenos Aires") continue;
    const code = normalizeBarioCode(b.name);
    if (byCode.has(code)) continue;
    byCode.set(code, { code, name: b.name, count: valueByCode.get(code) ?? 0 });
  }
  for (const [code, value] of valueByCode) {
    if (!byCode.has(code)) residual += value;
  }

  return redactSubregionAggregate([...byCode.values()], residual);
}
