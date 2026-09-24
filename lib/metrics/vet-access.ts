// lib/metrics/vet-access.ts — access-to-care signal: veterinary acts per 1k
// active pets by zone.
//
// Surfaces the veterinary event spine as a locality-level access-to-care
// projection on /gob/analytics AND as the panorama `acceso-veterinario`
// choropleth: veterinary acts per 1,000 active pets, grouped by the pet's home
// locality. Low per-1k localities mark care deserts (the CABA vs periphery
// inequity the PO wants visible).
//
// NUMERATOR WIDTH (2026-07-26). The numerator was `vet_visit_logged` ALONE —
// 85 rows in the entire database, against 29.123 vaccinations, 19.742 microchip
// implants and 17.817 sterilizations. Measured on that predicate the province
// choropleth returned exactly 0,0 for 23 of the 24 provinces and 14 for CABA:
// two values, no discrimination, and a flat map that reads as "no hay acceso en
// ninguna parte". Counting every act that REQUIRED A VETERINARY PROFESSIONAL
// (VET_ACTIVITY_EVENT_TYPES) moves it to 690,9 (Salta) → 1.997,9 (Mendoza)
// across all 24 provinces, with the same geography the desert layer shows.
//
// LOCALITY-GROUPED → k-ANONYMITY (k=5) IS MANDATORY. The denominator (active pets
// per locality) is the k-anon dimension: a locality with <5 active pets is
// suppressed so the row can never re-identify a household. Routed through
// suppressSmallCells (lib/metrics/anonymity.ts).
//
// SCOPE: vet_visit_logged carries a per-event jurisdiction snapshot in payload,
// but for consistency with every other non-outbreak fetcher (and to keep the
// numerator locality dimension identical to the denominator's) we scope AND group
// by the pet's HOME jurisdiction via petsScopeClause against the pets table.

import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { analyticsDb as db, petEvents, pets } from "@/db";

import { suppressSmallCells } from "./anonymity";
import type { ProjectionContext } from "./context";
import { KPI_CATALOG } from "./kpi-catalog";
import { activePetsCondition } from "./population";
import { petsScopeClause } from "./scope";

/**
 * The event types that constitute a VETERINARY ACT.
 *
 * Shared by BOTH access-to-care surfaces so they can never drift apart on the
 * definition: this fetcher (/gob/analytics + the `acceso-veterinario`
 * choropleth) and the panorama `desierto-veterinario` loader
 * (repository-choropleth.ts), which measures the complement — the share of pets
 * that received NONE of these.
 *
 * The rule is "did this act require a veterinary professional?", NOT "who typed
 * it in". `author_role` is the REPORTER, not the performer: 28.979 of the
 * 29.123 seeded vaccinations are owner-logged, so filtering on author_role='vet'
 * would measure vet-app adoption rather than veterinary activity. Justification
 * per member:
 *
 *   vet_visit_logged         — the clinical consult itself.
 *   vaccination_administered — the antirrábica must be applied by a licensed vet
 *                              (Ley 22.953); the act is veterinary whoever logs it.
 *   sterilization_performed  — surgery under anaesthesia; not owner-performable.
 *   microchip_implanted      — subcutaneous implant; a professional procedure.
 *   clinical_info_logged     — lab work / imaging / surgery / diagnosis records.
 *
 * DELIBERATELY EXCLUDED:
 *   deworming_administered — antiparasitics are sold over the counter and are
 *     routinely applied by the owner at home, so counting them would measure
 *     owner diligence, not access to professional service.
 *   weight_recorded, note_added — owner self-reports; measuring them would make
 *     the signal a proxy for registry engagement instead of veterinary access.
 */
export const VET_ACTIVITY_EVENT_TYPES = [
  "vet_visit_logged",
  "vaccination_administered",
  "sterilization_performed",
  "microchip_implanted",
  "clinical_info_logged",
] as const;

/** True when a govt actor has no assigned jurisdictions — queries return empty. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

/**
 * Veterinary acts per 1,000 active pets. Returns 0 when there is no active
 * population (an empty locality has no access signal, not an infinite one).
 * One-decimal precision, matching the rate convention across lib/metrics.
 */
export function perThousand(visits: number, activePets: number): number {
  if (activePets === 0) return 0;
  return Math.round((visits / activePets) * 1000 * 10) / 10;
}

// ---------------------------------------------------------------------------
// "Desierto de atención" — an ABSOLUTE band, not a position in a sorted list
// (external red-team 2026-07-30, H6).
//
// The /gob/analytics table sorted ascending and told the operator "las
// primeras filas son desiertos de atención". Live, the first row was Palermo
// at 1.286,8 actos / 1.000 activos — the LOWEST of the set and roughly 1,3
// veterinary acts per pet per year, which is not a desert of anything. A
// sanitary authority can allocate resources off that sentence; a relative
// order does not support an absolute claim, and the top of ANY ascending list
// is non-empty by construction.
//
// So the label needs a floor it can be measured against, and the floor has to
// be anchored in something real rather than picked to look decisive. The
// anchor used here is the ANNUAL ANTIRRÁBICA: Ley 22.953 makes one
// vet-administered rabies vaccination per dog per year obligatory, so one
// veterinary act per pet per year is the least a locality can register while
// still meeting the single legal contact the law already requires. Below it,
// "desierto de atención" is a defensible reading of the registry.
//
// PERIOD-NORMALISED, and that is not a detail. /gob/analytics has a period
// picker (7d / 30d / 90d / 12m / YTD / 3y / 5y / custom), so the per-1k figure
// on screen is a per-PERIOD rate. A fixed number-of-acts threshold would be
// correct on exactly one of those presets and wrong on the other seven — the
// same class of error this whole pass exists to remove. The threshold is
// therefore pro-rated to the visible window, and refuses to exist at all below
// VET_ACCESS_DESERT_MIN_PERIOD_DAYS: over a 7-day window the pro-rated floor
// is ~19 per 1.000 and a locality falls under it by coincidence, not by
// deprivation.
// ---------------------------------------------------------------------------

/** Veterinary acts per pet per YEAR below which a locality reads as a care
 *  desert — one act/pet/year is the annual antirrábica the law already
 *  mandates (Ley 22.953). Programmatic floor derived from a legal obligation,
 *  not a number the statute itself sets. */
export const VET_ACCESS_DESERT_ACTS_PER_PET_YEAR = 1;

/** Shortest window over which the absolute band is computed at all. Under a
 *  quarter, the pro-rated floor is small enough that ordinary lumpiness
 *  (one clinic closed a week) crosses it. */
export const VET_ACCESS_DESERT_MIN_PERIOD_DAYS = 90;

/** Active-pet floor under which the ratio is reported but never classified —
 *  read from the descriptor's `guards.smallN`, so the threshold lives in the
 *  catalog and this module cannot drift from it. */
export const VET_ACCESS_MIN_ACTIVE_PETS =
  KPI_CATALOG.vet_access_per_1k_locality.guards?.smallN?.min ?? 50;

const DAYS_PER_YEAR = 365;

/**
 * The per-1.000 figure below which a locality is a care desert, pro-rated to
 * the visible window. `null` when the window is too short to support the
 * claim (see VET_ACCESS_DESERT_MIN_PERIOD_DAYS) — a null threshold means "do
 * not classify", never "nothing is a desert".
 */
export function vetAccessDesertThresholdPer1k(periodDays: number): number | null {
  if (!Number.isFinite(periodDays) || periodDays < VET_ACCESS_DESERT_MIN_PERIOD_DAYS) return null;
  return (
    Math.round(((VET_ACCESS_DESERT_ACTS_PER_PET_YEAR * 1000 * periodDays) / DAYS_PER_YEAR) * 10) /
    10
  );
}

/**
 * What this row's rate can honestly be called.
 *
 *  - "small-sample": fewer than VET_ACCESS_MIN_ACTIVE_PETS active pets. The
 *    rate is arithmetically true and stays visible, but one act swings it too
 *    far to classify. Checked FIRST — a tiny locality reading 0 per 1.000 is
 *    the most tempting false desert on the whole table.
 *  - "desert": below the pro-rated absolute floor, over a big enough
 *    population and a long enough window.
 *  - "measured": everything else, INCLUDING the lowest row of the table when
 *    that row clears the floor. This is the branch Palermo lands in.
 *  - "unclassified": the window is too short for any absolute claim.
 */
export type VetAccessBand = "desert" | "small-sample" | "measured" | "unclassified";

export function classifyVetAccess(
  row: Pick<VetAccessRow, "per1k" | "activePets">,
  periodDays: number,
): VetAccessBand {
  if (row.activePets < VET_ACCESS_MIN_ACTIVE_PETS) return "small-sample";
  const threshold = vetAccessDesertThresholdPer1k(periodDays);
  if (threshold === null) return "unclassified";
  return row.per1k < threshold ? "desert" : "measured";
}

/** Whole days spanned by a ProjectionContext period — the input the absolute
 *  band is pro-rated over. */
export function periodDays(period: { since: Date; until: Date }): number {
  return (period.until.getTime() - period.since.getTime()) / (24 * 60 * 60 * 1000);
}

export type VetAccessRow = {
  /** Province name (pets.jurisdiction_province). */
  province: string;
  /** Locality name (pets.jurisdiction_locality). */
  locality: string;
  /**
   * VET_ACTIVITY_EVENT_TYPES events in the period whose pet is homed in this
   * locality. Named `visits` for the field's history; it counts every
   * veterinary ACT since 2026-07-26, not only logged consults.
   */
  visits: number;
  /** Active/lost pets homed in this locality (denominator + k-anon dimension). */
  activePets: number;
  /** Veterinary acts per 1,000 active pets, one decimal. */
  per1k: number;
  /** What this rate can honestly be CALLED — see classifyVetAccess. H6: the
   *  render site must never derive "desierto" from the row's position. */
  band: VetAccessBand;
};

export type VetAccessResult = {
  /**
   * Localities visible after k-anon suppression, sorted ASCENDING by per1k so
   * the lowest-access zones surface first. Lowest is a RELATIVE fact; whether
   * a row is a care desert is `row.band`, decided against an absolute floor.
   */
  localities: VetAccessRow[];
  /** Count of localities suppressed for having <5 active pets (privacy). */
  suppressedCount: number;
  /**
   * The absolute floor the bands were computed against, pro-rated to the
   * period — `null` when the window is too short to classify at all. The
   * render site shows this number so the claim is checkable instead of
   * asserted.
   */
  desertThresholdPer1k: number | null;
};

/**
 * KPI: vet_access_per_1k_locality (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT veterinary-act events (VET_ACTIVITY_EVENT_TYPES) in
 *              ctx.period whose pet is homed in the locality.
 * DENOMINATOR: COUNT active/lost pets homed in the locality, / 1,000.
 * SOURCE:      pets, pet_events (VET_ACTIVITY_EVENT_TYPES).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: k-anon (k=5) on the per-locality active-pet population — a
 *              locality with <5 active pets is dropped.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchVetAccessByLocality(ctx: ProjectionContext): Promise<VetAccessResult> {
  const days = periodDays(ctx.period);
  const desertThresholdPer1k = vetAccessDesertThresholdPer1k(days);
  const empty: VetAccessResult = { localities: [], suppressedCount: 0, desertThresholdPer1k };
  if (isEmptyScope(ctx)) return empty;

  const activeCond = activePetsCondition(ctx);
  const scope = petsScopeClause(ctx);

  // Denominator: active pets per (province, locality).
  const popRows = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      n: count(),
    })
    .from(pets)
    .where(and(activeCond, sql`${pets.jurisdictionLocality} IS NOT NULL`))
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality);

  // Numerator: veterinary-act events in the period, grouped by the pet's home
  // locality. Scoped by the pet JOIN + petsScopeClause (deworming-class scope).
  const visitConditions = [
    inArray(petEvents.eventType, VET_ACTIVITY_EVENT_TYPES),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
    sql`${pets.jurisdictionLocality} IS NOT NULL`,
  ];
  if (scope) visitConditions.push(sql`(${scope})`);

  const visitRows = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...visitConditions))
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality);

  const keyOf = (province: string, locality: string) => `${province}::${locality}`;
  const visitsByKey = new Map<string, number>();
  for (const r of visitRows) {
    if (r.province === null || r.locality === null) continue;
    visitsByKey.set(keyOf(r.province, r.locality), r.n);
  }

  // Build one row per locality that has an active population — that population is
  // the k-anon dimension. A locality with visits but 0 active pets (a stale
  // move) contributes no denominator and is intentionally not surfaced.
  const rows: VetAccessRow[] = popRows
    .filter(
      (r): r is typeof r & { province: string; locality: string } =>
        r.province !== null && r.locality !== null,
    )
    .map((r) => {
      const visits = visitsByKey.get(keyOf(r.province, r.locality)) ?? 0;
      const per1k = perThousand(visits, r.n);
      return {
        province: r.province,
        locality: r.locality,
        visits,
        activePets: r.n,
        per1k,
        band: classifyVetAccess({ per1k, activePets: r.n }, days),
      };
    });

  // k-anon on the active-pet population — suppress localities with <5 pets.
  const { visible, suppressedCount } = suppressSmallCells(rows, {
    count: (r) => r.activePets,
    key: (r) => keyOf(r.province, r.locality),
  });

  const localities = (visible as unknown as VetAccessRow[])
    .slice()
    .sort((a, b) => a.per1k - b.per1k);

  return { localities, suppressedCount, desertThresholdPer1k };
}
