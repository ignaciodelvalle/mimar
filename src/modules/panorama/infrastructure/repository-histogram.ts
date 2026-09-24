// Panorama infrastructure — the TimeScrubber's scope-total daily histogram.
//
// Split out of repository-history.ts (2026-08-22) when the k-anon envelope
// pushed that file past the 1500-line limit. The split is not bookkeeping:
// the two halves shared only their scope helpers. This half answers ONE
// question — how many events per day, over this window, in this scope — and
// owns the suppression rule for it. The other half returns a per-unit
// catalogued event list. Every loader here is unchanged, only moved.

import { type SQL, and, count, countDistinct, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { analyticsDb as db, petEvents, pets, welfareReports } from "@/db";
import {
  hasNationalReadScope,
  isWholeProvinceAssignment,
} from "@/lib/domain/jurisdiction-canonical";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import type { LayerId } from "@/src/modules/panorama/domain/types";

import {
  biteIncidentProvinceSql,
  biteIncidentScope,
  eventWindowCol,
  jurisdictionColumnsScope,
  mordedurasEventPredicate,
  perdidasEventPredicate,
  petEventsScope,
  petsScope,
} from "./repository-scope";
// ---------------------------------------------------------------------------
// Scope-total daily event counts — the TimeScrubber histogram for AGGREGATE views.
//
// The client-side histogram (signal-histogram.ts) bins per-event timestamps that
// ALREADY reached the client — which only exist in POINTS mode (real dots). An
// aggregated bubble carries only a count, so the scrubber was blind at aggregate
// level. This returns per-DAY event counts over [since, until] for the active
// temporal layer, bounded to the SAME scope the aggregate map uses (govt
// jurisdictions + optional admin drill).
//
// PRIVACY — CORRECTED 2026-08-22 (closing report M3 / fix queue row 13). This
// header used to argue: "the counts are SCOPE-TOTAL, not per-unit; a scope total
// is strictly coarser than the per-unit aggregation k-anon already governs, so
// it reveals no suppressed cell — k-anon is therefore intentionally NOT applied
// here." That reasoning is what authorised the hole, so it is replaced rather
// than annotated: leaving it invites the next reader to remove the guard again.
//
// It is true only while the resolved scope holds MORE THAN ONE unit. Drill to a
// single locality and the scope total IS that unit's count — and this endpoint
// returns not just the number the map refused to show, but the exact DATE of
// every event behind it. Reproduced against real data: CABA / Retiro, layer
// `sintomas`, 4 observations (under k, so the map hatches the cell) came back as
// four dated buckets — 1895-09-08, 2017-03-15, 2022-01-20, 2024-12-08. That is
// MORE than the hatching was hiding, from a directly callable API.
//
// So: when the resolved scope is a single administrative unit AND the window
// total is below ANONYMITY_K, the result is suppressed — as a DECLARED envelope
// (`suppressed: true`), never a silent empty array. An empty array reads as "no
// data here", a different and false statement about a jurisdiction. The sibling
// loadUnitHistory below already works exactly this way (#40b); this is that same
// guard, at the same grain, on the loader that was missed.
//
// Mirrors each layer's By-Unit predicate + time column + scope helper EXACTLY
// (same source of truth), minus the per-unit GROUP BY and centroid join.
// ---------------------------------------------------------------------------

/** One day's scope-total event count for the scrubber histogram. */

export type ScopeDailyCount = { date: string; count: number };

/**
 * The histogram envelope. `suppressed` is DECLARED so the route — and the
 * console behind it — can say "protegido por privacidad" instead of drawing an
 * empty track that reads as "nothing happened here".
 */
export type ScopeDailyHistogram = {
  /** True when a single-unit scope's window total fell below ANONYMITY_K. */
  suppressed: boolean;
  /** Per-day counts. ALWAYS empty when `suppressed`. */
  counts: ScopeDailyCount[];
};

/**
 * Does the scope this histogram covers resolve to ONE administrative unit?
 *
 * That is the condition under which "scope total" and "per-unit count" are the
 * same number — the premise the old privacy comment got wrong.
 *
 * Both drill parameters are server-resolved before they reach here: an admin
 * drills freely, a govt's drill is intersected DOWN with its assignments and
 * never widens them (see buildProjectionContext / metricsPetsScopeClause), so
 * reading them here cannot be tricked into claiming a narrower scope than the
 * query will actually run.
 *
 * A province counts as a unit. #40b retired the "province cells are large"
 * premise for the sibling unit-history guard and it is no truer here: a
 * province whose bubble the map HATCHES must not hand this endpoint its event
 * dates through a plain drill with no locality.
 */
export function scopeResolvesToSingleUnit(params: {
  actor: DashboardActor;
  jurisdictions: DashboardJurisdiction[];
  adminProvince?: string;
  adminLocality?: string;
}): boolean {
  const { actor, jurisdictions, adminProvince, adminLocality } = params;

  // A locality drill is one unit for either role. For a govt it is additionally
  // intersected with its assignments, which can only make the query narrower.
  if (adminLocality) return true;

  const unitKey = (j: DashboardJurisdiction): string =>
    isWholeProvinceAssignment(j) ? `${j.province}|` : `${j.province}|${j.locality}`;

  if (adminProvince) {
    if (hasNationalReadScope(actor.role)) return true;
    // A govt drilled to a province: the scope is that province INTERSECTED with
    // its assignments, so it is one unit only when the assignments inside that
    // province collapse to one.
    const inside = jurisdictions.filter((j) => j.province === adminProvince);
    return new Set(inside.map(unitKey)).size === 1;
  }

  // Admin / national with no drill is national — many units, and the total is
  // genuinely coarser than any of them.
  if (hasNationalReadScope(actor.role)) return false;

  // A govt with no assignments matches nothing; that is not "one unit".
  return new Set(jurisdictions.map(unitKey)).size === 1;
}

/**
 * Apply the histogram's k-anon rule to a finished per-day series.
 *
 * Pure and separated from the query on purpose: the loader below is DB-backed
 * and cannot be unit-tested in this Windows/Docker environment, and a privacy
 * rule that no test can execute is a privacy rule nobody can prove.
 *
 * An EMPTY window is reported as not suppressed. 0 is below k, but publishing
 * "nothing happened" discloses nobody — and flagging it as suppressed would
 * tell the operator there IS something hidden here, which is its own small leak.
 */
export function applyHistogramKAnon(
  counts: ScopeDailyCount[],
  singleUnitScope: boolean,
): ScopeDailyHistogram {
  if (!singleUnitScope || counts.length === 0) return { suppressed: false, counts };
  const windowTotal = counts.reduce((sum, r) => sum + r.count, 0);
  if (windowTotal >= ANONYMITY_K) return { suppressed: false, counts };
  return { suppressed: true, counts: [] };
}

export async function loadScopeDailyCounts(params: {
  layer: LayerId;
  actor: DashboardActor;
  jurisdictions: DashboardJurisdiction[];
  since: Date;
  until: Date;
  basis?: TimeBasis;
  adminProvince?: string;
  adminLocality?: string;
}): Promise<ScopeDailyHistogram> {
  const {
    layer,
    actor,
    jurisdictions,
    since,
    until,
    basis = "valid",
    adminProvince,
    adminLocality,
  } = params;

  const dayBucket = (tsCol: SQL) => sql<string>`to_char(date_trunc('day', ${tsCol}), 'YYYY-MM-DD')`;
  const tcol = eventWindowCol(basis);

  let rows: Array<{ day: string; n: number }> = [];

  switch (layer) {
    case "perdidas":
    case "mordeduras": {
      // A bite counts where it OCCURRED (biteIncidentScope, repository-scope.ts);
      // a lost pet still attributes to its home, as the perdidas map does.
      const isBite = layer === "mordeduras";
      const scope = isBite
        ? biteIncidentScope(actor, jurisdictions, adminProvince, adminLocality)
        : petsScope(actor, jurisdictions, adminProvince, adminLocality);
      const conditions: SQL[] = [
        isBite ? mordedurasEventPredicate() : perdidasEventPredicate(),
        gte(tcol, since),
        lte(tcol, until),
        isBite
          ? sql`${biteIncidentProvinceSql()} IS NOT NULL`
          : isNotNull(pets.jurisdictionProvince),
      ];
      if (scope) conditions.push(sql`(${scope})`);
      rows = await db
        .select({ day: dayBucket(sql`${tcol}`), n: countDistinct(petEvents.id) })
        .from(petEvents)
        .innerJoin(pets, eq(petEvents.petId, pets.id))
        .where(and(...conditions))
        .groupBy(dayBucket(sql`${tcol}`))
        .orderBy(dayBucket(sql`${tcol}`));
      break;
    }

    case "sintomas": {
      const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
      const conditions: SQL[] = [
        eq(petEvents.eventType, "symptom_observed"),
        gte(tcol, since),
        lte(tcol, until),
        isNotNull(pets.jurisdictionProvince),
      ];
      if (scope) conditions.push(sql`(${scope})`);
      rows = await db
        .select({ day: dayBucket(sql`${tcol}`), n: countDistinct(petEvents.id) })
        .from(petEvents)
        .innerJoin(pets, eq(petEvents.petId, pets.id))
        .where(and(...conditions))
        .groupBy(dayBucket(sql`${tcol}`))
        .orderBy(dayBucket(sql`${tcol}`));
      break;
    }

    case "zoonosis": {
      const scope = petEventsScope(actor, jurisdictions, adminProvince, adminLocality);
      const conditions: SQL[] = [
        eq(petEvents.eventType, "outbreak_signal"),
        gte(tcol, since),
        lte(tcol, until),
        isNotNull(sql`(${petEvents.payload}->>'pet_jurisdiction_province')`),
      ];
      if (scope) conditions.push(sql`(${scope})`);
      rows = await db
        .select({ day: dayBucket(sql`${tcol}`), n: countDistinct(petEvents.id) })
        .from(petEvents)
        .where(and(...conditions))
        .groupBy(dayBucket(sql`${tcol}`))
        .orderBy(dayBucket(sql`${tcol}`));
      break;
    }

    case "denuncias": {
      // Welfare reports window by createdAt (basis-agnostic, mirrors the By-Unit
      // loader), with the same moderation gate.
      const scope = jurisdictionColumnsScope(
        actor,
        jurisdictions,
        "welfareReports",
        adminProvince,
        adminLocality,
      );
      const conditions: SQL[] = [
        gte(welfareReports.createdAt, since),
        lte(welfareReports.createdAt, until),
        sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
        isNotNull(welfareReports.jurisdictionProvince),
      ];
      if (scope) conditions.push(sql`(${scope})`);
      rows = await db
        .select({ day: dayBucket(sql`${welfareReports.createdAt}`), n: count() })
        .from(welfareReports)
        .where(and(...conditions))
        .groupBy(dayBucket(sql`${welfareReports.createdAt}`))
        .orderBy(dayBucket(sql`${welfareReports.createdAt}`));
      break;
    }

    // reunificacion is a RATE (no meaningful per-day event volume); every other
    // layer is non-temporal or reference — no histogram.
    default:
      return { suppressed: false, counts: [] };
  }

  return applyHistogramKAnon(
    rows.map((r) => ({ date: r.day, count: r.n })),
    scopeResolvesToSingleUnit({ actor, jurisdictions, adminProvince, adminLocality }),
  );
}
