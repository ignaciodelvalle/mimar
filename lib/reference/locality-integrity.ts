// Pure, dependency-light predicate for the province-as-locality overlap.
//
// Lives in lib/reference (NOT lib/infra) on purpose: it must stay free of any
// `@/db` / `server-only` import so it can be reused from three places that run
// in very different environments — the runtime dropdown belt (server), the
// INDEC importer (tsx script), and the CI guard scripts/check-locality-integrity
// (plain tsx, no server context). It depends only on the pure province catalog.

import { provinceByName } from "@/lib/reference/ar-provincias";

/**
 * True when a locality row is really the *whole-province aggregate* — a phantom
 * "locality" that spans its entire province rather than a real subdivision.
 *
 * The canonical offender is CABA's "Ciudad Autónoma de Buenos Aires"
 * (indec_id 02000010, category 'componente'): INDEC ships the city as a single
 * locality that coexists with the 48 barrios tiling the same city, so selecting
 * it in a Localidad dropdown double-counts every barrio it contains.
 *
 * A row qualifies only when BOTH hold:
 *   1. its canonical name resolves to its OWN province — province==locality
 *      identity (provinceByName tolerates the "Ciudad Autónoma…" alias → AR-C), and
 *   2. it has no departamento (`departmentCode` null) — i.e. it is the province
 *      itself, not a subdivision.
 *
 * Why BOTH conditions (verified against the live INDEC catalog):
 *   - Name-equality alone would wrongly drop real capital cities that share
 *     their province's name (Córdoba, Mendoza, Salta, Paraná…) — but every
 *     capital sits inside a departamento, so condition (2) spares them.
 *   - department-null alone would wrongly drop the 48 CABA barrios (also
 *     department-less) — but their names ("Palermo", "Recoleta"…) do not
 *     resolve to AR-C, so condition (1) spares them.
 * Only CABA's whole-city row satisfies both. It is the sole department-less row
 * whose name resolves to its province across the entire catalog.
 */
export function isWholeProvinceAggregate(row: {
  provinceCode: string;
  localityName: string;
  departmentCode: string | null;
}): boolean {
  if (row.departmentCode != null) return false;
  return provinceByName(row.localityName)?.code === row.provinceCode;
}

/**
 * Provinces whose locality catalog is supplied AUTHORITATIVELY by a non-INDEC
 * source, so INDEC's own rows for them are noise at ANY granularity.
 *
 * Today there is exactly one: CABA is legally divided into 48 barrios (Ley CABA
 * 1.777, Comunas 2005), imported from the city's open-data portal as
 * `caba_open_data` by scripts/import-caba-barrios.ts. Anything INDEC ships for
 * AR-C tiles the same city a second time, so a locality rollup that mixes the
 * two double-counts every pet in the city.
 *
 *   `source`      the catalog that owns the province
 *   `supersedes`  the sources it displaces — NOT "everything else". Curated
 *                 `manual` rows (the catalog carries one for AR-C, "Belgrano R")
 *                 are deliberate additions the barrio division does not name,
 *                 and a supersede rule is not a licence to delete them.
 *   `minimumRows` what the owning source owes. "No INDEC rows for AR-C" is
 *                 trivially true of an EMPTY AR-C catalog, which is a worse
 *                 state than the one being guarded against; the CI gate uses
 *                 this as its non-vacuity floor.
 */
export const ALT_SOURCE_PROVINCES = {
  "AR-C": {
    source: "caba_open_data",
    supersedes: ["indec_cppdyl"],
    minimumRows: 48,
    reason:
      "CABA is its 48 barrios (Ley CABA 1.777). INDEC ships the same city again — until 2026-08 as one department-less city-wide row, since then as 15 per-Comuna rows — and either shape double-counts the barrios tiling it.",
  },
} as const;

/**
 * True when a locality row belongs to a source that another source has
 * superseded for that province.
 *
 * WHY THIS IS NOT A SHAPE TEST, AND WHY THAT MATTERS. isWholeProvinceAggregate
 * above answers a question about a row's SHAPE: department-less, name equal to
 * its province. That was a faithful description of the only offender that
 * existed when it was written — and on 2026-08-19 INDEC replaced CABA's single
 * city-wide row with 15 per-Comuna rows, each carrying a departamento_id. The
 * predicate kept answering correctly and the catalog broke anyway: all 15
 * imported as active AR-C rows on every bootstrap, invisible to the CI gate,
 * because the gate was enumerating a FORM rather than the subject.
 *
 * This predicate names the subject. Whatever INDEC ships for AR-C next — barrio
 * rows, comuna rows, one city row, something new — the answer does not move.
 */
export function isSupersededByAltSource(row: { provinceCode: string; source: string }): boolean {
  const alt = ALT_SOURCE_PROVINCES[row.provinceCode as keyof typeof ALT_SOURCE_PROVINCES];
  if (alt === undefined) return false;
  return (alt.supersedes as readonly string[]).includes(row.source);
}
