// lib/campaign-metrics.ts — Campaign performance projections for /gob/campanas.
//
// Pure projection layer over the existing bookings (appointments) +
// attendance (appointments.status) + service_offerings data.
// NO schema changes. Builds on lib/metrics/ ProjectionContext primitives.
//
// Scope model:
//  - Admin → sees all offerings/appointments (no WHERE restriction).
//  - Govt → scoped to offerings where jurisdictionProvince/Locality matches
//    the operator's active govt_assignments.
//
// Terminology aligned with AGENTS.md § Dashboards › Sanitary authority:
//   enrollment  = bookings (appointments created, any non-cancelled status)
//   completion  = attended appointments (status='attended')
//   no_show     = appointments with status='no_show'
//   geo_reach   = distinct jurisdictionLocality values among attended appointments

import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates. supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { appointments, analyticsDb as db, petEvents, serviceOfferings } from "@/db";
import { type ProjectionContext, jurisdictionPairClause, suppressSmallCells } from "@/lib/metrics";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";

// ---------------------------------------------------------------------------
// Sanitary outcome event spine
// ---------------------------------------------------------------------------
//
// Enrollment/completion/no-show measure LOGISTICS (who booked, who showed up).
// They do NOT measure the sanitary RESULT. The result lives in the append-only
// pet_events spine: an attended appointment writes an immutable medical event
// and links it back via appointments.outcome_event_id (see
// src/modules/events/application/attendance/mark-appointment-attended.ts).
//
// Because that FK is a PRECISE per-appointment link, we compute EXACT
// attribution — not a jurisdiction/time-window proxy: each attended campaign
// appointment whose linked outcome event is a sanitary type counts as one real
// prestación delivered (dose in the arm / castración performed / dosis of
// dewormer administered). The conversion attended → prestación surfaces the gap
// between "marked attended" and "an immutable sanitary record actually exists".

/** pet_event types that represent a real sanitary prestación (the campaign RESULT). */
export const SANITARY_OUTCOME_EVENT_TYPES = [
  "vaccination_administered",
  "sterilization_performed",
  "deworming_administered",
] as const;

export type SanitaryOutcomeEventType = (typeof SANITARY_OUTCOME_EVENT_TYPES)[number];

/** Type guard: is this pet_event type a sanitary prestación we attribute to a campaign? */
export function isSanitaryOutcomeEvent(eventType: string): eventType is SanitaryOutcomeEventType {
  return (SANITARY_OUTCOME_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** One attended appointment joined to its linked outcome event (via outcome_event_id). */
export type CampaignOutcomeRow = {
  offeringId: string;
  /** pet_events.event_type of the linked outcome event. */
  eventType: string;
};

/**
 * Pure aggregation: fold linked outcome events into per-offering sanitary counts.
 *
 * Only rows whose linked event is a sanitary prestación are counted — a
 * vet_visit_logged fallback (e.g. a general-checkup offering, or a legacy
 * attended appointment without a sanitary event) is intentionally excluded, so
 * the count is the true number of sanitary records the campaign produced.
 *
 * Exported for unit testing against synthetic events without a database.
 */
export function aggregateCampaignOutcomes(rows: CampaignOutcomeRow[]): Map<string, number> {
  const byOffering = new Map<string, number>();
  for (const row of rows) {
    if (!isSanitaryOutcomeEvent(row.eventType)) continue;
    byOffering.set(row.offeringId, (byOffering.get(row.offeringId) ?? 0) + 1);
  }
  return byOffering;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-offering campaign performance aggregate. */
export type CampaignOfferingStats = {
  offeringId: string;
  offeringToken: string;
  displayName: string;
  serviceKind: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** Total confirmed + attended + no_show (cancelled excluded). */
  enrollment: number;
  /** Attended appointments. */
  completion: number;
  /** No-show appointments. */
  noShow: number;
  /** Completion rate 0–100 (null when enrollment=0). */
  completionRate: number | null;
  /** No-show rate 0–100 (null when enrollment=0). */
  noShowRate: number | null;
  /**
   * Real sanitary prestaciones delivered — attended appointments whose linked
   * outcome event (via appointments.outcome_event_id) is a sanitary type.
   * This is the campaign RESULT (doses/procedures), not the logistics.
   * Exact per-appointment attribution over the pet_events spine.
   */
  sanitaryOutcome: number;
  /**
   * Conversion attended → prestación, 0–100 (null when completion=0).
   * < 100 means some attended appointments have no immutable sanitary record.
   */
  outcomeConversionRate: number | null;
};

/** Geo reach: distinct localities where ≥1 attendance happened. */
export type CampaignGeoReach = {
  /** Locality name (from service_offering.jurisdiction_locality). */
  locality: string;
  /** Province name (from service_offering.jurisdiction_province). Null when not set. */
  province: string | null;
  /** Number of attended appointments in that locality. */
  attendedCount: number;
};

/**
 * k-anonymity-safe geo reach: the locality rows safe to display/export, plus
 * the number of localities withheld below the k threshold. Both the dashboard
 * table and the CSV export consume `rows` — there is no second, unsuppressed
 * query — so suppression holds on every surface.
 */
export type CampaignGeoReachResult = {
  /** Localities with ≥k attendances + one per-province privacy rollup row. */
  rows: CampaignGeoReach[];
  /** Number of localities hidden because their count was < k (k-anonimato). */
  suppressedCount: number;
};

/** Full campaign dashboard result for the page. */
export type CampaignDashboardData = {
  offerings: CampaignOfferingStats[];
  /** Sparkline totals for KPI trend (last 6 months of enrollment counts). */
  enrollmentSparkline: number[];
  /** Aggregated totals across all offerings in scope. */
  totals: {
    enrollment: number;
    completion: number;
    noShow: number;
    completionRate: number | null;
    noShowRate: number | null;
    /** Total real sanitary prestaciones delivered across offerings in scope. */
    sanitaryOutcome: number;
    /** Aggregate conversion attended → prestación, 0–100 (null when completion=0). */
    outcomeConversionRate: number | null;
  };
  /** Previous-period totals (for delta computation in OpKpi v2). */
  prevTotals: {
    enrollment: number;
    completion: number;
    noShow: number;
  };
  /** Geo reach data — k-anonymity suppressed (rows + hidden-cell count). */
  geoReach: CampaignGeoReachResult;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of service_offering IDs in scope for the given context.
 * Used to scope appointment queries without a JOIN that might fan out.
 *
 * `opts.serviceKind` (domain-axes work) narrows to offerings of a single
 * SERVICE_KINDS code (lib/reference/service-kinds.ts), e.g. "vaccination_rabies".
 * Because every downstream fetcher in this module (fetchOfferingStats,
 * fetchOfferingOutcomes, fetchGeoReach, fetchEnrollmentSparkline,
 * fetchPrevTotals) consumes this function's offeringIds output, narrowing HERE
 * cascades consistently to every KPI/tile on the page in one place — no other
 * query needs its own copy of the predicate.
 */
async function resolveOfferingIds(
  ctx: ProjectionContext,
  opts?: { serviceKind?: string; limit?: number },
): Promise<string[]> {
  if (ctx.scope.kind === "global") {
    // Admin: fetch all approved/active offerings, narrowed to ctx.adminProvince
    // when a Panorama-style drill-down is active (additive-only — mirrors
    // petsScopeClause's admin branch). Backward-compat: no ctx.adminProvince →
    // unrestricted, exactly as before.
    const conditions = [
      inArray(serviceOfferings.status, ["approved", "pending_approval", "paused", "archived"]),
    ];
    if (ctx.adminProvince) {
      conditions.push(eq(serviceOfferings.jurisdictionProvince, ctx.adminProvince));
      if (ctx.adminLocality) {
        conditions.push(eq(serviceOfferings.jurisdictionLocality, ctx.adminLocality));
      }
    }
    if (opts?.serviceKind) conditions.push(eq(serviceOfferings.serviceKind, opts.serviceKind));
    const query = db
      .select({ id: serviceOfferings.id })
      .from(serviceOfferings)
      .where(and(...conditions));
    const rows = opts?.limit !== undefined ? await query.limit(opts.limit) : await query;
    return rows.map((r) => r.id);
  }

  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return [];

  // jurisdictionPairClause applies whole-province subsumption — see
  // lib/metrics/scope.ts. Found via authz-subsumption fence hardening
  // (2026-07-22) — same bug class as commit 68501bb4.
  // synthetic: exempt — service_offerings carry no seed marker (T1-P1 report).
  const scopeClause =
    jurisdictionPairClause(
      [...jurisdictions],
      sql`${serviceOfferings.jurisdictionProvince}`,
      sql`${serviceOfferings.jurisdictionLocality}`,
      sql`${serviceOfferings.localityId}`,
    ) ?? sql`false`;

  const conditions = [
    inArray(serviceOfferings.status, ["approved", "pending_approval", "paused", "archived"]),
    scopeClause,
  ];
  if (opts?.serviceKind) conditions.push(eq(serviceOfferings.serviceKind, opts.serviceKind));

  const query = db
    .select({ id: serviceOfferings.id })
    .from(serviceOfferings)
    .where(and(...conditions));
  const rows = opts?.limit !== undefined ? await query.limit(opts.limit) : await query;

  return rows.map((r) => r.id);
}

/**
 * Existence check for the /gob first-run onboarding checklist (T4-O3, G3):
 * "does at least one campaign (service offering) exist in the operator's
 * jurisdiction scope". Reuses resolveOfferingIds' exact status/scope
 * predicate (lint:scope — a second hand-rolled copy of the same jurisdiction
 * predicate was flagged as scope-security drift, 2026-09-22) with `limit: 1`
 * so the checklist never materializes more than one row.
 */
export async function hasCampaignsInScope(ctx: ProjectionContext): Promise<boolean> {
  const ids = await resolveOfferingIds(ctx, { limit: 1 });
  return ids.length > 0;
}

// ---------------------------------------------------------------------------
// Per-offering stats
// ---------------------------------------------------------------------------

/**
 * Fetch per-offering enrollment/completion/no-show counts within the period.
 * Only counts non-cancelled appointments (confirmed + attended + no_show).
 */
async function fetchOfferingStats(
  offeringIds: string[],
  ctx: ProjectionContext,
): Promise<CampaignOfferingStats[]> {
  if (offeringIds.length === 0) return [];

  const { since, until } = ctx.period;

  // Aggregate appointments by offering + status within the period.
  const rows = await db
    .select({
      offeringId: serviceOfferings.id,
      offeringToken: serviceOfferings.publicToken,
      displayName: serviceOfferings.displayName,
      serviceKind: serviceOfferings.serviceKind,
      jurisdictionProvince: serviceOfferings.jurisdictionProvince,
      jurisdictionLocality: serviceOfferings.jurisdictionLocality,
      status: appointments.status,
      cnt: count(appointments.id),
    })
    .from(serviceOfferings)
    .leftJoin(
      appointments,
      and(
        eq(appointments.serviceOfferingId, serviceOfferings.id),
        gte(appointments.createdAt, since),
        lt(appointments.createdAt, until),
        inArray(appointments.status, ["confirmed", "attended", "no_show"]),
      ),
    )
    .where(inArray(serviceOfferings.id, offeringIds))
    .groupBy(
      serviceOfferings.id,
      serviceOfferings.publicToken,
      serviceOfferings.displayName,
      serviceOfferings.serviceKind,
      serviceOfferings.jurisdictionProvince,
      serviceOfferings.jurisdictionLocality,
      appointments.status,
    );

  // Group by offering.
  const byOffering = new Map<string, CampaignOfferingStats>();

  for (const row of rows) {
    const key = row.offeringId;
    if (!byOffering.has(key)) {
      byOffering.set(key, {
        offeringId: row.offeringId,
        offeringToken: row.offeringToken,
        displayName: row.displayName,
        serviceKind: row.serviceKind,
        jurisdictionProvince: row.jurisdictionProvince,
        jurisdictionLocality: row.jurisdictionLocality,
        enrollment: 0,
        completion: 0,
        noShow: 0,
        completionRate: null,
        noShowRate: null,
        sanitaryOutcome: 0,
        outcomeConversionRate: null,
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: key was just set above if missing
    const stat = byOffering.get(key)!;
    const n = Number(row.cnt);
    if (row.status === "attended") {
      stat.completion += n;
      stat.enrollment += n;
    } else if (row.status === "no_show") {
      stat.noShow += n;
      stat.enrollment += n;
    } else if (row.status === "confirmed") {
      stat.enrollment += n;
    }
  }

  // Compute rates.
  for (const stat of byOffering.values()) {
    if (stat.enrollment > 0) {
      stat.completionRate = Math.round((stat.completion / stat.enrollment) * 100);
      stat.noShowRate = Math.round((stat.noShow / stat.enrollment) * 100);
    }
  }

  return Array.from(byOffering.values());
}

// ---------------------------------------------------------------------------
// Sanitary outcome (event-spine projection)
// ---------------------------------------------------------------------------

/**
 * Projects the real sanitary result per offering over the pet_events spine.
 *
 * Joins attended appointments to their linked outcome event via
 * appointments.outcome_event_id (a precise per-appointment FK), keeping only
 * sanitary event types. Returns offeringId → count of sanitary prestaciones.
 * Scoped by the same appointment window as enrollment/completion so the
 * attended → prestación conversion is coherent (same denominator set).
 */
async function fetchOfferingOutcomes(
  offeringIds: string[],
  ctx: ProjectionContext,
): Promise<Map<string, number>> {
  if (offeringIds.length === 0) return new Map();

  const { since, until } = ctx.period;

  const rows = await db
    .select({
      offeringId: appointments.serviceOfferingId,
      eventType: petEvents.eventType,
    })
    .from(appointments)
    .innerJoin(petEvents, eq(petEvents.id, appointments.outcomeEventId))
    .where(
      and(
        inArray(appointments.serviceOfferingId, offeringIds),
        eq(appointments.status, "attended"),
        gte(appointments.createdAt, since),
        lt(appointments.createdAt, until),
        inArray(petEvents.eventType, SANITARY_OUTCOME_EVENT_TYPES as unknown as string[]),
      ),
    );

  return aggregateCampaignOutcomes(rows);
}

// ---------------------------------------------------------------------------
// Geo reach
// ---------------------------------------------------------------------------

/**
 * k-anonymity suppression for geo-reach cells (pure — no DB, unit-testable).
 *
 * A locality with a handful of vaccinated animals is individually identifiable,
 * so localities whose attendance count is below the shared ANONYMITY_K are
 * withheld and folded into ONE per-province "Otras localidades (privacidad)"
 * rollup row — the same pattern the mortality-by-locality projection uses
 * (lib/analytics/mortality-metrics.ts, `suppressSmallCells` + province rollup).
 * Because both the /gob/campanas table and its CSV export consume the SAME
 * suppressed rows, a fix here closes every surface at once.
 *
 * THE ROLLUP IS A CELL TOO, and k applies to it exactly as it applies to the
 * rows it replaces (closing report M5 / fix queue row 14, 2026-08-22). Until
 * then this claimed "the same proven-safe pattern" and did not use it: the fold
 * was built unconditionally, so a province contributing exactly ONE
 * sub-threshold locality printed that locality's exact count under the label
 * "(privacidad)" — republishing the protected number beside the word that
 * promises it is protected. The project had already been bitten by this on
 * /gob/mortalidad ("Tierra del Fuego (otras localidades) — 2", found live
 * 2026-07-28) and written the rule into `rollupSuppressedLocalities`; the fold
 * here was hand-rolled and never inherited the check.
 *
 * Below k the honest output is NO ROW. Nothing is lost to the reader:
 * `suppressedCount` still says how many localities were hidden, without saying
 * how many attendances they hold.
 */
export function suppressGeoReach(cells: CampaignGeoReach[]): CampaignGeoReachResult {
  const { visible, suppressed, suppressedCount } = suppressSmallCells<CampaignGeoReach>(cells, {
    count: (c) => c.attendedCount,
    key: (c) => c.locality,
  });

  // Fold every suppressed locality into a single rollup row per province.
  const rollupByProvince = new Map<string, CampaignGeoReach>();
  for (const c of suppressed) {
    const provinceKey = c.province ?? "—";
    const existing = rollupByProvince.get(provinceKey);
    if (existing) {
      existing.attendedCount += c.attendedCount;
    } else {
      rollupByProvince.set(provinceKey, {
        locality: "Otras localidades (privacidad)",
        province: c.province,
        attendedCount: c.attendedCount,
      });
    }
  }

  // A fold that stays under k is itself a sub-threshold cell — drop it rather
  // than print it under a privacy label. See the header.
  const publishableRollups = [...rollupByProvince.values()].filter(
    (r) => r.attendedCount >= ANONYMITY_K,
  );

  // `visible` is branded SuppressedCells at compile time; its runtime elements
  // are the CampaignGeoReach rows we passed in.
  const visibleRows = visible as unknown as CampaignGeoReach[];
  const rows = [...visibleRows, ...publishableRollups].sort(
    (a, b) => b.attendedCount - a.attendedCount,
  );

  return { rows, suppressedCount };
}

/**
 * Returns distinct localities where ≥1 attendance happened in the period.
 * Groups by jurisdiction_locality from service_offerings (no JSONB required),
 * then routes the result through k-anonymity suppression before returning.
 */
async function fetchGeoReach(
  offeringIds: string[],
  ctx: ProjectionContext,
): Promise<CampaignGeoReachResult> {
  if (offeringIds.length === 0) return { rows: [], suppressedCount: 0 };

  const { since, until } = ctx.period;

  const rows = await db
    .select({
      locality: serviceOfferings.jurisdictionLocality,
      province: serviceOfferings.jurisdictionProvince,
      attendedCount: count(appointments.id),
    })
    .from(serviceOfferings)
    .innerJoin(
      appointments,
      and(
        eq(appointments.serviceOfferingId, serviceOfferings.id),
        eq(appointments.status, "attended"),
        gte(appointments.createdAt, since),
        lt(appointments.createdAt, until),
      ),
    )
    .where(inArray(serviceOfferings.id, offeringIds))
    .groupBy(serviceOfferings.jurisdictionLocality, serviceOfferings.jurisdictionProvince);

  const cells = rows
    .filter(
      (r): r is { locality: string; province: string | null; attendedCount: number } =>
        r.locality !== null,
    )
    .map((r) => ({
      locality: r.locality,
      province: r.province,
      attendedCount: Number(r.attendedCount),
    }));

  return suppressGeoReach(cells);
}

// ---------------------------------------------------------------------------
// Enrollment sparkline (monthly, last 6 periods)
// ---------------------------------------------------------------------------

/**
 * Returns enrollment counts for the last 6 calendar months as a sparkline array.
 * Month 0 = oldest, Month 5 = current/most recent.
 */
async function fetchEnrollmentSparkline(offeringIds: string[]): Promise<number[]> {
  if (offeringIds.length === 0) return [0, 0, 0, 0, 0, 0];

  const rows = await db
    .select({
      month: sql<string>`to_char(${appointments.createdAt}, 'YYYY-MM')`,
      cnt: count(appointments.id),
    })
    .from(appointments)
    .where(
      and(
        inArray(appointments.serviceOfferingId, offeringIds),
        inArray(appointments.status, ["confirmed", "attended", "no_show"]),
        gte(appointments.createdAt, sql`now() - interval '6 months'`),
      ),
    )
    .groupBy(sql`to_char(${appointments.createdAt}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${appointments.createdAt}, 'YYYY-MM')`);

  // Build a 6-slot array from the last 6 months.
  const now = new Date();
  const result: number[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const row = rows.find((r) => r.month === key);
    result.push(row ? Number(row.cnt) : 0);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Previous-period totals
// ---------------------------------------------------------------------------

/**
 * Fetches enrollment/completion/no-show totals for the previous period
 * (same duration, immediately before ctx.period.since).
 * Used to compute delta for OpKpi v2 deltaV2 prop.
 */
async function fetchPrevTotals(
  offeringIds: string[],
  ctx: ProjectionContext,
): Promise<{ enrollment: number; completion: number; noShow: number }> {
  if (offeringIds.length === 0) return { enrollment: 0, completion: 0, noShow: 0 };

  const { since, until } = ctx.period;
  const duration = until.getTime() - since.getTime();
  const prevSince = new Date(since.getTime() - duration);
  const prevUntil = since;

  const rows = await db
    .select({
      status: appointments.status,
      cnt: count(appointments.id),
    })
    .from(appointments)
    .where(
      and(
        inArray(appointments.serviceOfferingId, offeringIds),
        inArray(appointments.status, ["confirmed", "attended", "no_show"]),
        gte(appointments.createdAt, prevSince),
        lt(appointments.createdAt, prevUntil),
      ),
    )
    .groupBy(appointments.status);

  let enrollment = 0;
  let completion = 0;
  let noShow = 0;
  for (const row of rows) {
    const n = Number(row.cnt);
    if (row.status === "attended") {
      completion += n;
      enrollment += n;
    } else if (row.status === "no_show") {
      noShow += n;
      enrollment += n;
    } else if (row.status === "confirmed") {
      enrollment += n;
    }
  }
  return { enrollment, completion, noShow };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetches all campaign performance data for the dashboard page.
 *
 * Returns per-offering stats, aggregated totals, previous-period totals
 * (for delta), enrollment sparkline, and geo reach for the choropleth.
 */
export async function fetchCampaignDashboard(
  ctx: ProjectionContext,
  opts?: { serviceKind?: string },
): Promise<CampaignDashboardData> {
  const offeringIds = await resolveOfferingIds(ctx, opts);

  if (offeringIds.length === 0) {
    return {
      offerings: [],
      enrollmentSparkline: [0, 0, 0, 0, 0, 0],
      totals: {
        enrollment: 0,
        completion: 0,
        noShow: 0,
        completionRate: null,
        noShowRate: null,
        sanitaryOutcome: 0,
        outcomeConversionRate: null,
      },
      prevTotals: { enrollment: 0, completion: 0, noShow: 0 },
      geoReach: { rows: [], suppressedCount: 0 },
    };
  }

  const [offerings, outcomesByOffering, geoReach, enrollmentSparkline, prevTotals] =
    await Promise.all([
      fetchOfferingStats(offeringIds, ctx),
      fetchOfferingOutcomes(offeringIds, ctx),
      fetchGeoReach(offeringIds, ctx),
      fetchEnrollmentSparkline(offeringIds),
      fetchPrevTotals(offeringIds, ctx),
    ]);

  // Fold the event-spine outcome counts into each offering + compute conversion.
  for (const o of offerings) {
    o.sanitaryOutcome = outcomesByOffering.get(o.offeringId) ?? 0;
    o.outcomeConversionRate =
      o.completion > 0 ? Math.round((o.sanitaryOutcome / o.completion) * 100) : null;
  }

  // Compute aggregated totals.
  let totalEnrollment = 0;
  let totalCompletion = 0;
  let totalNoShow = 0;
  let totalSanitaryOutcome = 0;
  for (const o of offerings) {
    totalEnrollment += o.enrollment;
    totalCompletion += o.completion;
    totalNoShow += o.noShow;
    totalSanitaryOutcome += o.sanitaryOutcome;
  }

  return {
    offerings,
    enrollmentSparkline,
    totals: {
      enrollment: totalEnrollment,
      completion: totalCompletion,
      noShow: totalNoShow,
      completionRate:
        totalEnrollment > 0 ? Math.round((totalCompletion / totalEnrollment) * 100) : null,
      noShowRate: totalEnrollment > 0 ? Math.round((totalNoShow / totalEnrollment) * 100) : null,
      sanitaryOutcome: totalSanitaryOutcome,
      outcomeConversionRate:
        totalCompletion > 0 ? Math.round((totalSanitaryOutcome / totalCompletion) * 100) : null,
    },
    prevTotals,
    geoReach,
  };
}

// ---------------------------------------------------------------------------
// Delta computation helper (pure, for tests)
// ---------------------------------------------------------------------------

/**
 * Computes the signed percentage point delta between current and previous values.
 * Returns null when the previous value is 0 (division undefined).
 */
export function computeDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Formats a delta value + period label for OpKpi v2 deltaV2 prop.
 * Returns null when the delta cannot be computed.
 */
export function formatDelta(
  current: number,
  previous: number,
  periodLabel: string,
): { value: number; period: string } | null {
  const delta = computeDelta(current, previous);
  if (delta === null) return null;
  return { value: delta, period: periodLabel };
}
