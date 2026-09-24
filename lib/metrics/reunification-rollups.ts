// Server-only: this module queries the DB. A client import is a hard build error.
import "server-only";

// lib/metrics/reunification-rollups.ts — D4 reunification rate, PER ADMINISTRATIVE
// UNIT (province or locality), feeding the Panorama `reunificacion` layer.
//
// Episode logic mirrors fetchReunificationRate in lib/analytics/compliance-metrics.ts
// EXACTLY (same lost/recovered definition — a single source of truth for the
// numerator/denominator semantics), but groups by the pet's home jurisdiction
// (province, or province+locality) instead of collapsing to one national number.
//
//   lost episode = a `status_changed` event to_status='lost' in scope + period.
//   recovered    = that pet's FIRST status transition strictly after the lost
//                   event is to_status='active'. Deceased excluded (not counted
//                   as recovered, same as the national fetcher).
//
// PRIVACY (k-anonymity): a unit's ratePct is a signal over a population as small
// as ONE pet — suppression MUST key off the DENOMINATOR (lostEpisodes), never off
// ratePct itself. A unit with 2 lost episodes and a 100% reunification rate is
// exactly as re-identifiable as one with 2 lost episodes and a 0% rate; a unit
// with 500 lost episodes and a 3% rate is not re-identifiable at all. Suppressing
// on ratePct (a stash bug this module deliberately does NOT reproduce) would get
// both of those backwards.
//
// BOTH GRAINS SUPPRESS (task #40b). This module used to exempt the PROVINCE level
// under the "province cells are large" premise. Task #40 retired that premise for
// the choropleth loaders and this module kept citing it: it was true of a
// province's POPULATION and false of its DENOMINATOR, which is what k-anonymity is
// about. On a RATE layer THE RATE REVEALS THE DENOMINATOR — a province with one
// lost episode and one recovery published "100%", describing a single identifiable
// animal. See src/modules/panorama/application/build-features.ts `provinceCell`
// for the same correction at the choropleth grain.

import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

// Heavy read-only analytics — routed through the ANALYTICS pool (matches the
// Panorama repository + lib/metrics/population-control.ts precedent).
import { arLocalities, analyticsDb as db, petEvents, pets } from "@/db";
import { type ProvinceCode, provinceByName } from "@/lib/reference/ar-provincias";

import { suppressSmallCells } from "./anonymity";
import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

/**
 * Locality-name fold for the ar_localities department join. Mirrors the
 * repository's `normNameSql` (NFD-strip accents, lowercase, drop dots, collapse
 * whitespace) so a pets.jurisdiction_locality free-text buckets to the SAME
 * ar_localities row the choropleth loaders match in SQL. Kept in JS here because
 * this module resolves the department map client-side (no per-episode SQL join —
 * that would fan-out and inflate the lost-episode count).
 */
function normLoc(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The province whose detail unit is the BARRIO (no ar_localities department) —
 * mirrors build-features.ts aggregateCellsToDepartment. */
const BARRIO_ONLY_PROVINCE = "CABA";

/** True when a govt actor has zero assigned jurisdictions → return zero shapes, no DB hit. */
function govtWithoutScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

/** Fraction → 0–100 percentage, one-decimal precision (matches
 * lib/analytics/compliance-metrics.ts pct — the shared convention across
 * every compliance/reunification rate in the codebase). */
function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

export type ReunificationByUnitRow = {
  province: string;
  /** null at PROVINCE level; at LOCALITY level the DETAIL-UNIT label — the
   * departamento/partido name (barrio in CABA) after the Option-A fold, NOT a
   * bare locality. */
  locality: string | null;
  /** % of lost episodes in this unit that returned to active. NULL when the unit
   * is k-anon suppressed — a protected cell has NO value, not a hidden one and
   * never a zero (a false zero reads as real data AND leaks a sub-k denominator).
   * Typed nullable on purpose: the compiler, not a reviewer, forces every consumer
   * to answer "what do I render for a protected unit?". */
  ratePct: number | null;
  /** LOCALITY level only: INDEC department code of the folded unit (null for CABA
   * barrios and localities that resolved no department). Threaded to the map's
   * departmentCode so a unit-history drill matches member localities by CODE. */
  departmentCode?: string | null;
  /** LOCALITY level only: the folded department centroid (average of member
   * locality centroids). Null when no member locality had a centroid. */
  centroidLat?: string | null;
  centroidLng?: string | null;
  /** True for a k-anon-suppressed cell, at EITHER grain (KA6 + #40b). The real
   * value never leaves this module — `ratePct` is null for these rows and the
   * loader emits a null-valued hatch cell. Emitting the suppressed unit (rather
   * than dropping it) keeps the "suppressed is always a distinct, visible
   * category" contract every other layer honors: a cell that VANISHES when it
   * crosses k makes absence itself the disclosure channel. */
  suppressed?: boolean;
};

export type ReunificationByUnitKpi = {
  /** Visible units PLUS k-anon-suppressed cells flagged `suppressed:true` (KA6) —
   * the suppressed rows carry `ratePct: null` so the loader can render them as the
   * honest hatch category instead of dropping them to plain no-data. The real value
   * never leaves this module. */
  byUnit: ReunificationByUnitRow[];
  /** Count of units suppressed below k=5 lostEpisodes, at EITHER grain (#40b).
   * THE DISCLOSURE: this is what the console's "N unidades suprimidas por
   * k-anonimato" line reports — suppressing cells while reporting 0 here would
   * hide data and tell nobody (#40's own follow-up finding). */
  suppressedCount: number;
};

/**
 * Per-unit reunification rate (D4), grouped by province or by (province,
 * locality). Feeds the Panorama `reunificacion` signal-point layer.
 *
 * Scope: govtWithoutScope(ctx) short-circuits to the empty shape (no DB hit).
 * Otherwise petsScopeClause(ctx) narrows the lost-episode query to the
 * viewer's jurisdiction (admin → universal; govt → intersect with assignments).
 */
export async function fetchReunificationByUnit(
  ctx: ProjectionContext,
  level: "province" | "locality",
): Promise<ReunificationByUnitKpi> {
  const empty: ReunificationByUnitKpi = { byUnit: [], suppressedCount: 0 };
  if (govtWithoutScope(ctx)) return empty;

  const scope = petsScopeClause(ctx);

  // All lost episodes in scope + period, attributed to the pet's HOME
  // jurisdiction (status_changed payloads carry no jurisdiction of their own —
  // same attribution rule the Panorama per-unit loaders use).
  const lostConditions: SQL[] = [
    eq(petEvents.eventType, "status_changed"),
    sql`(${petEvents.payload}->>'to_status') = 'lost'`,
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
    isNotNull(pets.jurisdictionProvince),
  ];
  if (level === "locality") lostConditions.push(isNotNull(pets.jurisdictionLocality));
  if (scope) lostConditions.push(sql`(${scope})`);

  const lostEvents = await db
    .select({
      petId: petEvents.petId,
      lostAt: petEvents.occurredAt,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...lostConditions))
    .orderBy(petEvents.occurredAt);

  if (lostEvents.length === 0) return empty;

  // For each lost episode, find the FIRST status transition strictly after the
  // lost event for that pet — same recovery rule as fetchReunificationRate.
  const petIds = [...new Set(lostEvents.map((e) => e.petId))];
  const transitions = await db
    .select({
      petId: petEvents.petId,
      toStatus: sql<string>`(${petEvents.payload}->>'to_status')`,
      at: petEvents.occurredAt,
    })
    .from(petEvents)
    .where(and(eq(petEvents.eventType, "status_changed"), inArray(petEvents.petId, petIds)))
    .orderBy(petEvents.occurredAt);

  const transitionsByPet = new Map<string, Array<{ toStatus: string; at: Date }>>();
  for (const t of transitions) {
    const arr = transitionsByPet.get(t.petId) ?? [];
    arr.push({ toStatus: t.toStatus, at: t.at });
    transitionsByPet.set(t.petId, arr);
  }

  type UnitAgg = {
    province: string;
    locality: string | null;
    lostEpisodes: number;
    recovered: number;
  };
  const unitByKey = new Map<string, UnitAgg>();

  for (const episode of lostEvents) {
    const province = episode.province as string;
    const locality = level === "locality" ? (episode.locality as string) : null;
    const key = level === "locality" ? `${province}|${locality}` : province;
    let agg = unitByKey.get(key);
    if (!agg) {
      agg = { province, locality, lostEpisodes: 0, recovered: 0 };
      unitByKey.set(key, agg);
    }
    agg.lostEpisodes += 1;

    const after = (transitionsByPet.get(episode.petId) ?? []).filter(
      (t) => t.at.getTime() > episode.lostAt.getTime(),
    );
    const next = after[0];
    if (next && next.toStatus === "active") agg.recovered += 1;
  }

  const units = [...unitByKey.values()];

  if (level === "province") {
    // k-anon on the PROVINCE-grain DENOMINATOR (lostEpisodes), never on ratePct —
    // the same rule, the same k, the same primitive as the locality branch below.
    // No complementary suppression here (unlike the COUNT rollups in
    // repository-by-unit.ts): counts sum, so a lone hidden count is recoverable
    // from a published group total by subtraction — RATES do not sum, and this
    // layer publishes no denominators, so there is no differencing channel to
    // close. Adding it would suppress a second province for nothing.
    const kanon = suppressSmallCells(units, {
      count: (u) => u.lostEpisodes,
      key: (u) => u.province,
    });
    const byUnit: ReunificationByUnitRow[] = (kanon.visible as unknown as UnitAgg[]).map((u) => ({
      province: u.province,
      locality: u.locality,
      ratePct: pct(u.recovered, u.lostEpisodes),
    }));
    for (const u of kanon.suppressed) {
      byUnit.push({
        province: u.province,
        locality: u.locality,
        ratePct: null,
        suppressed: true,
      });
    }
    return { byUnit, suppressedCount: kanon.suppressedCount };
  }

  // Locality level — FOLD the per-locality num/den up to the departamento/partido
  // (barrio in CABA) BEFORE the rate + k-anon (PO "Option A", the same fold every
  // other detail-tier layer applies via aggregateCellsToDepartment). The k-anon
  // then keys off the DEPARTMENT-grain DENOMINATOR, which clears k=5 far more
  // often (multiple localities per department) — so reunificacion, the last
  // locality-granularity holdout, joins the department tier. Folding a coarser
  // unit is strictly MORE anonymising, never less.

  // Resolve each locality's department + centroid from ar_localities (one grouped
  // read over the involved provinces; matched in JS by the same name-fold the SQL
  // choropleth loaders use). A per-episode SQL join would fan-out and inflate the
  // lost-episode count, so the mapping is resolved separately and folded in JS.
  const provinceCodes = [
    ...new Set(
      units
        .map((u) => provinceByName(u.province)?.code)
        .filter((c): c is ProvinceCode => Boolean(c)),
    ),
  ];
  type LocInfo = {
    code: string | null;
    name: string | null;
    lat: string | null;
    lng: string | null;
  };
  const locInfo = new Map<string, LocInfo>();
  if (provinceCodes.length > 0) {
    const rows = await db
      .select({
        provinceCode: arLocalities.provinceCode,
        localityName: arLocalities.localityName,
        departmentCode: arLocalities.departmentCode,
        departmentName: arLocalities.departmentName,
        latitude: arLocalities.latitude,
        longitude: arLocalities.longitude,
      })
      .from(arLocalities)
      .where(
        and(inArray(arLocalities.provinceCode, provinceCodes), isNull(arLocalities.removedAt)),
      );
    // Independent MIN per column (mirrors the loaders' MIN() aggregates: a known
    // dev-only mislabel caveat when a (province, locality) is ambiguous — the same
    // tradeoff aggregateCellsToDepartment carries).
    for (const r of rows) {
      const key = `${r.provinceCode}|${normLoc(r.localityName)}`;
      const cur = locInfo.get(key) ?? { code: null, name: null, lat: null, lng: null };
      if (r.departmentCode != null && (cur.code == null || r.departmentCode < cur.code)) {
        cur.code = r.departmentCode;
      }
      if (r.departmentName != null && (cur.name == null || r.departmentName < cur.name)) {
        cur.name = r.departmentName;
      }
      if (r.latitude != null && (cur.lat == null || Number(r.latitude) < Number(cur.lat))) {
        cur.lat = r.latitude;
      }
      if (r.longitude != null && (cur.lng == null || Number(r.longitude) < Number(cur.lng))) {
        cur.lng = r.longitude;
      }
      locInfo.set(key, cur);
    }
  }

  type DeptAgg = {
    province: string;
    label: string;
    departmentCode: string | null;
    lostEpisodes: number;
    recovered: number;
    latSum: number;
    lngSum: number;
    centroidN: number;
  };
  const byDept = new Map<string, DeptAgg>();
  for (const u of units) {
    const provCode = provinceByName(u.province)?.code ?? "";
    const info = locInfo.get(`${provCode}|${normLoc(u.locality ?? "")}`);
    const isBarrio = u.province === BARRIO_ONLY_PROVINCE;
    const deptCode = isBarrio ? null : (info?.code ?? null);
    // CABA folds to the barrio (its own locality); elsewhere to the department
    // code, or the locality's own bucket when no department resolved (never drop
    // it — preserves the province-total reconciliation invariant).
    const unitCode = isBarrio
      ? `barrio:${u.locality}`
      : deptCode
        ? `dept:${deptCode}`
        : `loc:${u.locality}`;
    const key = `${u.province}|${unitCode}`;
    let agg = byDept.get(key);
    if (!agg) {
      agg = {
        province: u.province,
        label: isBarrio ? (u.locality ?? "") : (info?.name ?? u.locality ?? ""),
        departmentCode: deptCode,
        lostEpisodes: 0,
        recovered: 0,
        latSum: 0,
        lngSum: 0,
        centroidN: 0,
      };
      byDept.set(key, agg);
    }
    agg.lostEpisodes += u.lostEpisodes;
    agg.recovered += u.recovered;
    const lat = info?.lat != null ? Number(info.lat) : Number.NaN;
    const lng = info?.lng != null ? Number(info.lng) : Number.NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      agg.latSum += lat;
      agg.lngSum += lng;
      agg.centroidN += 1;
    }
  }

  // k-anon on the DEPARTMENT-grain DENOMINATOR (lostEpisodes), never on ratePct.
  const { visible, suppressed, suppressedCount } = suppressSmallCells([...byDept.values()], {
    count: (u) => u.lostEpisodes,
    key: (u) => `${u.province}|${u.label}`,
  });
  const centroid = (u: DeptAgg) => ({
    centroidLat: u.centroidN > 0 ? String(u.latSum / u.centroidN) : null,
    centroidLng: u.centroidN > 0 ? String(u.lngSum / u.centroidN) : null,
  });
  const byUnit: ReunificationByUnitRow[] = (visible as unknown as DeptAgg[]).map((u) => ({
    province: u.province,
    locality: u.label,
    ratePct: pct(u.recovered, u.lostEpisodes),
    departmentCode: u.departmentCode,
    ...centroid(u),
  }));
  // KA6: emit suppressed department cells as `suppressed:true` with a NULL ratePct
  // (never a 0 placeholder — a false zero asserts "0% recuperadas", which is both a
  // lie and indistinguishable from real data) so they render as the honest hatch
  // category every other layer uses, not silently dropped to plain no-data.
  for (const u of suppressed) {
    byUnit.push({
      province: u.province,
      locality: u.label,
      ratePct: null,
      departmentCode: u.departmentCode,
      ...centroid(u),
      suppressed: true,
    });
  }
  return { byUnit, suppressedCount };
}
