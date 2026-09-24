// Province-choropleth data shaping — shared by the /gob/* jurisdiction
// dashboards that feed <MapChoroplethDynamic> a province-keyed cell list
// (task #31c dedup: this shaping was re-derived nearly identically at four
// call sites — /gob/poblacion, /gob/censo, /gob/perdidas, /gob/vigilancia).
//
// Two genuinely different shapes existed, so two small functions, not one
// forced-generic one:
//   toChoroplethData      — one row per province already (poblacion, censo):
//                            straight 1:1 map, unknown provinces fall back to
//                            their raw name as the "code" (never dropped).
//   aggregateChoroplethData — raw rows that may repeat a province and must be
//                            summed into one cell per code (perdidas,
//                            vigilancia): rows whose code can't be resolved
//                            are dropped, not fallen back.
//
// Pure — no DB, no React/next imports. See choropleth-data.test.ts.

import { type GeoLevel, isCABA } from "@/lib/infra/geo-join";
import { complementarySuppress, suppressSmallCells } from "@/lib/metrics";
import { pluralizeEs } from "@/lib/utils/format";
import { PROVINCE_ISO_MAP } from "./govt-dashboards";
import type { SubregionCaseCount, SubregionResidual } from "./subregion-redaction";

/**
 * ISO code → canonical province display name. The exact inverse of
 * PROVINCE_ISO_MAP, derived from it (never re-typed) so the two cannot drift.
 *
 * `label` IS THE PLACE NAME — every consumer treats it that way. MapChoropleth
 * renders it as the popup's place line and as the "Región" cell of the "Ver
 * datos" a11y table; `toChoroplethData` and `scopedChoroplethProps` have always
 * passed the province / department / barrio NAME. `aggregateChoroplethData` was
 * the one fold that instead passed a caller-supplied `labelFor(value)` string,
 * which on both of its call sites spells the COUNT out in words.
 *
 * Two live consequences, both found 2026-08-01 on /gob/vigilancia:
 *  - the a11y table — the ONLY way to read exact values off a WebGL canvas, and
 *    the path for an operator who cannot see the map at all — listed 24 rows
 *    whose Región column read "18 casos abiertos", "78 casos abiertos", "32
 *    casos abiertos". No province was named anywhere, so "which province has
 *    78?" had no answer on the page.
 *  - a suppressed cell had to be special-cased back onto this map to avoid
 *    publishing the very count the hatch was hiding — the leak wearing the
 *    hatch. That special case is now simply what every cell does.
 */
const PROVINCE_NAME_BY_ISO: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCE_ISO_MAP).map(([name, code]) => [code, name]),
);

/**
 * The complementary-suppression group for the province tier: the whole country
 * — identical rationale (and identical value) to `NATIONAL_GROUP` in
 * lib/open-data/province-suppression.ts. The published aggregate one level
 * coarser than a province cell is the national/scope total, so that is the
 * group across which a single hidden cell must not be isolable by subtraction.
 */
const NATIONAL_GROUP = "AR";

/**
 * {code, value, label} triple consumed by MapChoropleth's `data` prop
 * (components/charts/MapChoropleth.tsx `ChoroplethRegionDatum`). Declared
 * locally — structurally identical — so this lib module stays framework-free.
 */
export type ChoroplethCell = {
  code: string;
  value: number;
  label: string;
  /** True when the cell's value was WITHHELD by k-anon. MapChoropleth reads this
   *  flag before any code path that could paint a number, so `value` is inert. */
  suppressed?: boolean;
};

/** A ChoroplethCell that may carry the k-anon suppressed flag (department/barrio drill). */
export type ScopedChoroplethCell = Pick<ChoroplethCell, "code" | "value"> & {
  label?: string;
  suppressed?: boolean;
};

/**
 * Maps rows that already carry one entry per province straight to choropleth
 * cells — no aggregation. Province names absent from PROVINCE_ISO_MAP fall
 * back to the raw name as the code (matches the pre-extraction behavior at
 * both call sites: a row is never silently dropped here). The label is
 * always the raw province name.
 *
 * Shared by /gob/poblacion (`coverage.byProvince`, value = `ratePct`) and
 * /gob/censo (`provinceRows`, value = `count`).
 *
 * NULL IS THE WITHHELD SIGNAL. `getValue` returning null means the row's value
 * was suppressed upstream (k-anon — the fetchers now hand back `number | null`
 * exactly so the absence survives the mapping). Such a cell is still EMITTED,
 * carrying `suppressed: true`, because a cell that DISAPPEARS at k makes absence
 * the disclosure channel and the map would stipple it "sin datos" — false, and a
 * tell that this province is different. Its `value: 0` is a placeholder the
 * renderer never reaches: MapChoropleth branches on the flag first.
 */
export function toChoroplethData<T extends { province: string }>(
  rows: T[],
  getValue: (row: T) => number | null,
): ChoroplethCell[] {
  return rows.map((r) => {
    const code = PROVINCE_ISO_MAP[r.province] ?? r.province;
    const value = getValue(r);
    return value === null
      ? { code, value: 0, suppressed: true, label: r.province }
      : { code, value, label: r.province };
  });
}

/**
 * Aggregates rows into one cell per resolved code, summing `getValue` for
 * rows that share a code. Rows whose `keyOf` resolves to a falsy code
 * (no province, or a province absent from PROVINCE_ISO_MAP) are dropped —
 * unlike `toChoroplethData`, there is no raw-name fallback here.
 *
 * Every cell is labelled with its PROVINCE NAME (see PROVINCE_NAME_BY_ISO above
 * for the defect that taking a caller-supplied count string here caused). There
 * is no `labelFor` parameter: the value is already carried by `value`, and the
 * one field a map has for saying WHERE cannot be spent on saying how many.
 *
 * Shared by /gob/perdidas (`aggregateLostByProvince`: counts lost pets per
 * province, keyOf resolves the raw province name through PROVINCE_ISO_MAP)
 * and /gob/vigilancia (`provinceChoroplethData`: sums per-locality case
 * counts that already carry a resolved `code` up to province level).
 *
 * ---------------------------------------------------------------------------
 * k-ANONYMITY AT THE PROVINCE TIER (RA-3 C5, 2026-07-31).
 * ---------------------------------------------------------------------------
 * Both callers used to hand MapChoropleth raw sums, so a province with ONE open
 * case painted a coloured polygon, a "1 caso abierto" tooltip and a bare `1` in
 * the "Ver datos" a11y table. The DEPARTMENT drill of those same two screens has
 * been suppressed since the scoped-drill work (`redactSmallSubregionCells`);
 * only the province tier was naked. Suppression now happens HERE, inside the
 * shared fold, for the same reason `suppressSmallCells` is the only constructor
 * of `SuppressedCells`: a boundary a caller can forget is not a boundary.
 *
 * THERE IS DELIBERATELY NO OPT-OUT PARAMETER. A per-caller `skipSuppression`
 * flag would be the same defect RA-3 C1 names one row above — "a suppression
 * anyone can switch off is not a suppression".
 *
 * Two passes, both from lib/metrics/anonymity.ts, no third mechanism and no
 * second k:
 *  1. PRIMARY `suppressSmallCells` at ANONYMITY_K (the default; not re-typed).
 *  2. COMPLEMENTARY `complementarySuppress` grouped NATIONALLY. Required here
 *     and not on the sibling tables: /gob/perdidas publishes the scope total
 *     (`lostPets.length`) in the list header AND feeds it to the map's
 *     `scopeAggregate` notice, so a LONE hidden province is recoverable by
 *     `total − Σ(visible provinces)`. National is the right group for the same
 *     reason `lib/open-data/province-suppression.ts` uses NATIONAL_GROUP: the
 *     published aggregate one level above a province row is the country.
 *
 * A suppressed cell keeps `value: 0` ONLY as an inert placeholder — the same
 * contract `toChoroplethData` above documents, and MapChoropleth honours it on
 * every read path (`!f.suppressed` before the domain, `choropleth_suppressed`
 * before the fill, the popup, the bin filter and the a11y table all branch on
 * the flag first). The cell is EMITTED rather than dropped because a province
 * that disappears at k makes absence the disclosure channel and the map would
 * stipple it "sin datos" — false, and a tell.
 *
 * /gob/perdidas got the identical treatment rather than an exemption. Yes, lost
 * episodes are owner-published and the page lists them per-animal below the map,
 * so the privacy GAIN there is close to zero. But the exemption would have to be
 * a product decision, not an agent's: this repo has no "already public
 * elsewhere" carve-out (its two public-facing modules suppress MORE, not less),
 * this screen's own department tier already hatches, and un-suppressing later is
 * a one-line change while shipping the naked tier is not reversible. Flagged for
 * PO ratification instead of decided here.
 */
export function aggregateChoroplethData<T>(
  rows: T[],
  keyOf: (row: T) => string | null | undefined,
  getValue: (row: T) => number,
): ChoroplethCell[] {
  const codeToValue = new Map<string, number>();
  for (const row of rows) {
    const code = keyOf(row);
    if (!code) continue;
    codeToValue.set(code, (codeToValue.get(code) ?? 0) + getValue(row));
  }
  const cells = Array.from(codeToValue.entries()).map(([code, value]) => ({ code, value }));

  // Zero-count cells are not protected (an empty group re-identifies no one —
  // the same "zero nuance" suppressDelta documents) and are not produced by
  // this fold anyway: a province with no rows never enters the map.
  const { visible, suppressed } = suppressSmallCells(
    cells.filter((c) => c.value > 0),
    { count: (c) => c.value, key: (c) => c.code },
  );
  const { suppressed: allSuppressed } = complementarySuppress(
    visible as unknown as ReadonlyArray<{ code: string; value: number }>,
    suppressed,
    { group: () => NATIONAL_GROUP, count: (c) => c.value },
  );
  const suppressedCodes = new Set(allSuppressed.map((c) => c.code));

  return cells.map((c) => {
    const label = PROVINCE_NAME_BY_ISO[c.code] ?? c.code;
    return suppressedCodes.has(c.code)
      ? { code: c.code, value: 0, suppressed: true, label }
      : { code: c.code, value: c.value, label };
  });
}

/** GeoJSON URL per drill-down level — mirrors MapChoropleth's own GEOJSON_BY_LEVEL. */
const SUBREGION_GEOJSON_URL: Record<"department" | "barrio", string> = {
  department: "/geo/ar-departments.geojson",
  barrio: "/geo/caba-barrios.geojson",
};

export type ScopedChoroplethProps = {
  level: GeoLevel;
  geojsonUrl?: string;
  visibleCodes?: string[];
  data: ScopedChoroplethCell[];
};

/**
 * Reusable scope-aware choropleth drill (design/scoped-choropleth-drill,
 * engram #1481): builds the `{level, geojsonUrl, visibleCodes, data}` bundle
 * to spread straight into `<MapChoroplethDynamic {...props} />`, auto-drilling
 * from province to department (or barrio, for CABA) grain the moment the
 * screen's jurisdiction filter selects a province.
 *
 * - No province selected, or `subregionCells` not available yet (null) →
 *   national view unchanged: `level: "province"`, the screen's own
 *   `provinceCells` (from `toChoroplethData`/`aggregateChoroplethData`), no
 *   geojsonUrl/visibleCodes override (MapChoropleth's province-level defaults
 *   already apply).
 * - Province selected → `level: "department"` (`"barrio"` for CABA, AR-C),
 *   the matching GeoJSON, `visibleCodes` = every sub-region of that province
 *   (zooms the map + filters the GeoJSON to just that province — see
 *   MapChoropleth's `visibleCodes` contract), and `data` built from
 *   `subregionCells`: k-anon-suppressed cells pass through with `value: 0,
 *   suppressed: true` (MapChoropleth already renders the hatch + tooltip +
 *   empty-state copy generically off that flag — no count is ever exposed
 *   here); zero-count non-suppressed cells are dropped so they render as
 *   "sin datos" (grey) instead of the lightest data color.
 *
 * Reusable by ANY /gob screen with a jurisdiction filter: pass the screen's
 * own province-level cells and its own `subregionCells` (built via
 * `aggregateRowsByDepartment`, lib/analytics/subregion-aggregate.ts) — this
 * function does no fetching and no aggregation, only prop-shaping, so it is
 * pure and framework-free like the rest of this module.
 */
export function scopedChoroplethProps(
  provinceCells: ChoroplethCell[],
  selectedProvinceIso: string | null | undefined,
  subregionCells: SubregionCaseCount[] | null | undefined,
): ScopedChoroplethProps {
  if (!selectedProvinceIso || !subregionCells) {
    return { level: "province", data: provinceCells };
  }

  const level: "department" | "barrio" = isCABA(selectedProvinceIso) ? "barrio" : "department";
  const data: ScopedChoroplethCell[] = subregionCells
    .filter((c) => c.count > 0 || c.suppressed)
    .map((c) =>
      c.suppressed
        ? { code: c.code, value: 0, suppressed: true, label: c.name }
        : { code: c.code, value: c.count, label: c.name },
    );

  return {
    level,
    geojsonUrl: SUBREGION_GEOJSON_URL[level],
    visibleCodes: subregionCells.map((c) => c.code),
    data,
  };
}

/**
 * The line printed under a drilled /gob map for the fold's residual (L1·1 of
 * the locality plan): how many rows the map could not place in any department
 * or barrio. Null when there is nothing to say.
 *
 * A suppressed residual (k-anonymity, including a complementary promotion) is
 * confessed WITHOUT a number — "hay … sin ubicar" — because saying nothing
 * would bring back the silent map/table disagreement this line exists to end,
 * and a number would undo the protection.
 */
export function sinUbicacionNote(
  residual: SubregionResidual | null | undefined,
  noun: { singular: string; plural: string },
): string | null {
  if (!residual) return null;
  if (residual.suppressed) {
    return `Hay ${noun.plural} sin ubicar que no aparecen en el mapa (cantidad protegida por privacidad).`;
  }
  if (residual.count <= 0) return null;
  const n = residual.count;
  return `${n.toLocaleString("es-AR")} ${pluralizeEs(n, noun.singular, noun.plural)} sin ubicar: no tienen una localidad del catálogo y no aparecen en el mapa.`;
}
