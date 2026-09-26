// Surveillance metrics hardening (Item 3) — read-time projections for
// /gob/vigilancia that turn "we detected signals" into "we are demonstrably
// discharging the legal surveillance obligations a sanitary authority is
// audited on".
//
// Spec: docs/superpowers/specs/2026-06-18-surveillance-metrics-hardening-design.md
// Umbrella: dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md (§3/§5/§7)
//
// Metrics implemented (all shippable-now per the spec catalog):
//   A7      ENO-notification SLA   — event_notification_outbox (target_kind='eno_authority')
//   A8/A9   Rabies 10-day compliance — rabies_observation_started/_ended + pets.rabies_observation_status
//   A12     AMR / antimicrobial density — medication_started + isAntimicrobial (lib/drugs.ts)
//   A6      Reportable-disease incidence — disease_reported + death_recorded.is_reportable
//   A10     Lab-confirmation rate  — *.confirmed_by_lab
//
// Pattern B (umbrella): population-level SQL aggregates, jurisdiction-scoped,
// period-aware, k-anonymity enforced. Every fetcher accepts a single
// ProjectionContext built at the page boundary via buildProjectionContext().
//
// Privacy: locality-grouped output (A6 incidence-by-locality, A12-by-locality)
// routes through lib/metrics/anonymity.ts `suppressSmallCells` (k=5). This item
// does NOT introduce its own anonymity helper — the boundary lives in Item 0
// (lib/metrics/anonymity.ts) and is consumed here. (The spec text mentions an
// older "lib/anonymity.ts" plan; that was reconciled into lib/metrics in Item 0.)
//
// Scope note: death_recorded events do NOT carry jurisdiction in their JSONB
// payload, so reportable-incidence fetchers (A6/A10) scope via an inner join to
// pets + petsScopeClause (pets.jurisdiction* columns). disease_reported uses the
// same pets-join path for consistency. A7 scopes on the outbox row's own
// target_jurisdiction_province/locality snapshot.

import { and, count, eq, gte, lte, ne, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates (fetchEnoSla feeds /admin/programa +
// /gob/programa). supavisor transaction mode (6543) has a measured >100x pathology for
// this fan-out shape (db/index.ts); session mode serves it normally. Locally analyticsDb
// falls back to DATABASE_URL (identical dev/test).
import { analyticsDb as db, eventNotificationOutbox, pets } from "@/db";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { safePayloadUuid } from "@/lib/infra/sql-fragments";
import {
  type ProjectionContext,
  cachedActivePetCount,
  jurisdictionPairClause,
  petsScopeClause,
  suppressedMetric,
  withoutSyntheticRows,
} from "@/lib/metrics";
import type { Cell, MetricResult, SuppressedCells } from "@/lib/metrics";
import { openObservationStatusSql } from "@/lib/metrics/observation-status";
import { DRUG_CATALOG, isAntimicrobial, isClassifiedDrug } from "@/lib/reference/drugs";

// Re-export the context type so callers can import everything from one place.
export type { ProjectionContext } from "@/lib/metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Legal rabies-observation window: 10 calendar days (Ord. CABA 41.831 art. 9,
 * Decreto 4669/1973 PBA) — the DEFAULT tier of the `rabies_observation_window`
 * business rule (admin-rules-console, promoted from this literal constant).
 * This is a CLINICAL window (the rule deadline), NOT a reporting window, so
 * it's documented here next to the metric that uses it, mirroring the
 * comment in lib/metrics/period.ts. Live resolution goes through
 * resolveBusinessRule("rabies_observation_window", ...) inside
 * fetchRabiesObservationCompliance below — this constant is kept only as a
 * readable anchor for the legal citation.
 */
export const RABIES_OBSERVATION_WINDOW_DAYS = 10;

// ---------------------------------------------------------------------------
// Shared scope helper — outbox rows carry their own jurisdiction snapshot.
// ---------------------------------------------------------------------------

function outboxScopeClause(ctx: ProjectionContext) {
  // T1-P1: an outbox row whose source event is about a synthetic pet is synthetic.
  return withoutSyntheticRows(ctx.actor.role, "outbox", outboxJurisdictionClause(ctx));
}

function outboxJurisdictionClause(ctx: ProjectionContext) {
  if (ctx.scope.kind === "global") {
    // Admin province drill-down (Panorama-style), mirroring petsScopeClause /
    // petEventsScopeClause (lib/metrics/scope.ts). Backward-compat: no
    // ctx.adminProvince → null (unrestricted), exactly as before.
    if (!ctx.adminProvince) return null;
    if (ctx.adminLocality) {
      return and(
        eq(eventNotificationOutbox.targetJurisdictionProvince, ctx.adminProvince),
        eq(eventNotificationOutbox.targetJurisdictionLocality, ctx.adminLocality),
      );
    }
    return eq(eventNotificationOutbox.targetJurisdictionProvince, ctx.adminProvince);
  }
  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return sql`false`;
  // Whole-province subsumption (jurisdictionPairClause): a whole-CABA operator
  // must see CABA-barrio-scoped (and null-locality CABA) outbox rows too, not
  // only rows whose locality string exactly equals the whole-province name.
  // Previously this hand-rolled an exact (province AND locality) pair, so the
  // SLA tile read "sin entregas" for deliveries the operator legitimately owns.
  // synthetic: covered — outboxScopeClause wraps this with withoutSyntheticRows.
  return jurisdictionPairClause(
    jurisdictions,
    sql`${eventNotificationOutbox.targetJurisdictionProvince}`,
    sql`${eventNotificationOutbox.targetJurisdictionLocality}`,
  );
}

function hasNoScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

// ===========================================================================
// A7 — ENO-notification SLA
// ===========================================================================

export type EnoSlaMetric = {
  /** Outbox rows (target_kind='eno_authority') in scope, created within the period. */
  total: number;
  /** Delivered rows whose delivered_at <= sla_due_at. */
  onTime: number;
  /**
   * % of delivered rows that met the SLA. null when there are no delivered
   * rows (the UI shows "—" rather than a misleading 0%/100%).
   */
  onTimePct: number | null;
  /** Currently breached rows: status='pending' AND sla_due_at < now. (live A7 breach) */
  breachedOpen: number;
  /**
   * Median delivery latency in hours (delivered_at - created_at) across
   * delivered rows. null when there are no delivered rows.
   */
  medianLatencyHours: number | null;
};

/**
 * A7 — measures OUR ENO notification pipeline, not external delivery (D1,
 * umbrella §6). Reads event_notification_outbox rows with target_kind =
 * 'eno_authority':
 *   - onTimePct: of delivered rows, the share delivered on/before sla_due_at.
 *   - breachedOpen: pending rows already past their SLA deadline (live breach).
 *   - medianLatencyHours: median (delivered_at - created_at) over delivered rows.
 *
 * Period: `total`/`onTime`/median are computed over rows CREATED within
 * ctx.period; breachedOpen is a live "now" figure (any pending+overdue row).
 */
export async function fetchEnoSla(ctx: ProjectionContext): Promise<EnoSlaMetric> {
  if (hasNoScope(ctx)) {
    return { total: 0, onTime: 0, onTimePct: null, breachedOpen: 0, medianLatencyHours: null };
  }

  const scope = outboxScopeClause(ctx);
  const { since, until } = ctx.period;

  const periodConditions = [
    eq(eventNotificationOutbox.targetKind, "eno_authority"),
    gte(eventNotificationOutbox.createdAt, since),
    lte(eventNotificationOutbox.createdAt, until),
    // A merged legacy duplicate (migration 0247) is not a notification of its
    // own — counting it would inflate `total` with a row nobody sends.
    ne(eventNotificationOutbox.status, "merged"),
  ];
  if (scope) periodConditions.push(sql`(${scope})`);

  // Live breach: pending rows past SLA, regardless of created-at window.
  const breachConditions = [
    eq(eventNotificationOutbox.targetKind, "eno_authority"),
    eq(eventNotificationOutbox.status, "pending"),
    sql`${eventNotificationOutbox.slaDueAt} < now()`,
  ];
  if (scope) breachConditions.push(sql`(${scope})`);

  const [aggRows, breachRows] = await Promise.all([
    db
      .select({
        total: count(),
        delivered: sql<number>`COUNT(*) FILTER (WHERE ${eventNotificationOutbox.status} = 'delivered')`,
        onTime: sql<number>`COUNT(*) FILTER (WHERE ${eventNotificationOutbox.status} = 'delivered' AND ${eventNotificationOutbox.deliveredAt} <= ${eventNotificationOutbox.slaDueAt})`,
        // Median latency in hours over delivered rows. percentile_cont ignores
        // NULL inputs, so non-delivered rows contribute nothing.
        medianHours: sql<string | null>`percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (${eventNotificationOutbox.deliveredAt} - ${eventNotificationOutbox.createdAt})) / 3600.0
        ) FILTER (WHERE ${eventNotificationOutbox.status} = 'delivered')`,
      })
      .from(eventNotificationOutbox)
      .where(and(...periodConditions)),
    db
      .select({ n: count() })
      .from(eventNotificationOutbox)
      .where(and(...breachConditions)),
  ]);

  const total = aggRows[0]?.total ?? 0;
  const delivered = Number(aggRows[0]?.delivered ?? 0);
  const onTime = Number(aggRows[0]?.onTime ?? 0);
  const medianRaw = aggRows[0]?.medianHours;
  const breachedOpen = breachRows[0]?.n ?? 0;

  return {
    total,
    onTime,
    onTimePct: delivered > 0 ? Math.round((onTime / delivered) * 1000) / 10 : null,
    breachedOpen,
    medianLatencyHours: medianRaw !== null && medianRaw !== undefined ? Number(medianRaw) : null,
  };
}

// ===========================================================================
// A8 / A9 — Rabies-observation 10-day compliance
// ===========================================================================

export type RabiesComplianceMetric = {
  /** Observations that have a closing (rabies_observation_ended) event in the period. */
  closed: number;
  /** Of those closed, how many closed within the 10-day legal window. */
  closedWithinWindow: number;
  /**
   * % of closed observations that met the 10-day window. null when no
   * observations were closed in the period.
   */
  compliancePct: number | null;
  /** A9: observations still open (no ended event) and started > 10 days ago. */
  openBreaches: number;
};

/**
 * A8/A9 — reads the existing rabies-observation event pair (D2). "Within
 * window" means the closing event occurred within 10 calendar days of the
 * start. A9 "breach" = a started observation with no matching ended event whose
 * start is already past the 10-day deadline (a live OpBreach on the page).
 *
 * Scope: rabies events do not reliably carry jurisdiction in their payload, so
 * we inner-join pets and scope on pets.jurisdiction* (petsScopeClause).
 *
 * Pairing: each rabies_observation_ended row references its start via
 * payload.observation_started_event_id; the elapsed time is derived from the
 * two events' occurred_at. Observations are pet-scoped and a pet can be
 * observed more than once, so we pair on the explicit start id, not by pet.
 */
/**
 * Runs the closed/breach rabies queries for a single scope fragment + a
 * single resolved window-days value. Extracted so the caller can either run
 * it ONCE (global scope, country-level window) or once PER jurisdiction
 * (govt scope — each jurisdiction may have its own override, design ADR-4
 * item 1) and sum the partial results.
 */
async function fetchRabiesComplianceForScope(
  scopeFragment: ReturnType<typeof sql>,
  sinceIso: string,
  untilIso: string,
  windowDays: number,
): Promise<{ closed: number; closedWithinWindow: number; openBreaches: number }> {
  const closedRows = await db.execute<{ closed: string; within: string }>(sql`
    SELECT
      COUNT(*)::text AS closed,
      COUNT(*) FILTER (
        WHERE (ended.occurred_at - started.occurred_at) <= INTERVAL '${sql.raw(String(windowDays))} days'
      )::text AS within
    FROM pet_events ended
    JOIN pet_events started
      ON started.id = ${safePayloadUuid(sql`ended.payload->>'observation_started_event_id'`)}
    JOIN pets ON pets.id = ended.pet_id
    WHERE ended.event_type = 'rabies_observation_ended'
      AND ended.occurred_at >= ${sinceIso}::timestamptz
      AND ended.occurred_at <= ${untilIso}::timestamptz
      ${scopeFragment}
  `);

  // A9 live breaches: started observations with NO ending event, started more
  // than `windowDays` days ago.
  //
  // SUBSET INVARIANT (cursor UX G1, verified 2026-07-23): a live breach is by
  // definition an observation that is STILL OPEN, so openBreaches must be a
  // subset of the open-observations KPI (pets.rabies_observation_status =
  // 'in_progress' — the projection fetchOpenRabiesObservations reads). The
  // event-pairing predicate alone can violate that: an ended event written
  // WITHOUT observation_started_event_id (a seed script did exactly this)
  // leaves a phantom "unclosed" start, and the panel then shows a legal-breach
  // alert next to a KPI reading 0 — a trust-destroying contradiction where the
  // ALERT is the false positive. Requiring the projection to agree restores
  // breaches ⊆ open by construction; a pairing bug can then only ever
  // UNDER-count closures on a pet that is genuinely still in progress.
  const breachCutoffIso = new Date(Date.now() - windowDays * DAY_MS).toISOString();
  const breachRows = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM pet_events started
    JOIN pets ON pets.id = started.pet_id
    WHERE started.event_type = 'rabies_observation_started'
      AND started.occurred_at < ${breachCutoffIso}::timestamptz
      AND ${openObservationStatusSql()}
      AND NOT EXISTS (
        SELECT 1 FROM pet_events ended
        WHERE ended.event_type = 'rabies_observation_ended'
          AND ${safePayloadUuid(sql`ended.payload->>'observation_started_event_id'`)} = started.id
      )
      ${scopeFragment}
  `);

  return {
    closed: Number(closedRows[0]?.closed ?? 0),
    closedWithinWindow: Number(closedRows[0]?.within ?? 0),
    openBreaches: Number(breachRows[0]?.n ?? 0),
  };
}

/**
 * A8/A9 — reads the existing rabies-observation event pair (D2). "Within
 * window" means the closing event occurred within the resolved
 * `rabies_observation_window` (default 10 calendar days) of the start. A9
 * "breach" = a started observation with no matching ended event whose start
 * is already past the deadline (a live OpBreach on the page).
 *
 * Jurisdiction resolution (design ADR-4 item 1 — jurisdiction-flavored, CABA
 * vs PBA legal windows differ): a cross-jurisdiction admin aggregate
 * (scope.kind==='global') cannot honor per-province overrides in one number,
 * so it resolves the window ONCE at country level (AR default). A govt
 * scope resolves the window PER assigned jurisdiction and sums the partial
 * results — each jurisdiction's own override (or fallback) applies to its
 * own observations.
 *
 * Scope: rabies events do not reliably carry jurisdiction in their payload, so
 * we inner-join pets and scope on pets.jurisdiction* (petsScopeClause /
 * jurisdictionPairClause).
 *
 * Pairing: each rabies_observation_ended row references its start via
 * payload.observation_started_event_id; the elapsed time is derived from the
 * two events' occurred_at. Observations are pet-scoped and a pet can be
 * observed more than once, so we pair on the explicit start id, not by pet.
 */
export async function fetchRabiesObservationCompliance(
  ctx: ProjectionContext,
): Promise<RabiesComplianceMetric> {
  if (hasNoScope(ctx)) {
    return { closed: 0, closedWithinWindow: 0, compliancePct: null, openBreaches: 0 };
  }

  const sinceIso = ctx.period.since.toISOString();
  const untilIso = ctx.period.until.toISOString();

  let closed = 0;
  let closedWithinWindow = 0;
  let openBreaches = 0;

  if (ctx.scope.kind === "global") {
    // No single jurisdiction to resolve against — country-level fallback.
    const rule = await resolveBusinessRule("rabies_observation_window", { country: "AR" });
    const scope = petsScopeClause(ctx);
    const scopeFragment = scope ? sql` AND (${scope})` : sql``;
    const partial = await fetchRabiesComplianceForScope(
      scopeFragment,
      sinceIso,
      untilIso,
      rule.payload.days,
    );
    closed = partial.closed;
    closedWithinWindow = partial.closedWithinWindow;
    openBreaches = partial.openBreaches;
  } else {
    // Resolve + query per assigned jurisdiction, sum the partials.
    for (const j of ctx.scope.jurisdictions) {
      const rule = await resolveBusinessRule("rabies_observation_window", {
        country: "AR",
        province: j.province,
        locality: j.locality,
      });
      // T1-P1: per-jurisdiction partials carry the synthetic exclusion too.
      const pairClause = withoutSyntheticRows(
        ctx.actor.role,
        "pets",
        jurisdictionPairClause(
          [j],
          sql`${pets.jurisdictionProvince}`,
          sql`${pets.jurisdictionLocality}`,
        ),
      );
      const scopeFragment = pairClause ? sql` AND (${pairClause})` : sql``;
      const partial = await fetchRabiesComplianceForScope(
        scopeFragment,
        sinceIso,
        untilIso,
        rule.payload.days,
      );
      closed += partial.closed;
      closedWithinWindow += partial.closedWithinWindow;
      openBreaches += partial.openBreaches;
    }
  }

  return {
    closed,
    closedWithinWindow,
    compliancePct: closed > 0 ? Math.round((closedWithinWindow / closed) * 1000) / 10 : null,
    openBreaches,
  };
}

// ===========================================================================
// A12 — AMR / antimicrobial-use density
// ===========================================================================

export type AmrDensityMetric = {
  /** Antimicrobial medication_started events (known antibiotics) in the period. */
  antimicrobialCount: number;
  /** Active pets in scope (denominator). */
  activePets: number;
  /**
   * Antimicrobial starts per 1,000 active pets in the period. null when there
   * are no active pets in scope (avoids divide-by-zero).
   */
  per1000: number | null;
  /**
   * medication_started events whose drug_code is NOT in the curated catalog and
   * therefore cannot be classified confidently. Reported as a provisional raw
   * count, NOT folded into the rate (umbrella §7). > 0 → UI shows a
   * "clasificación provisional" note.
   */
  provisionalUnclassified: number;
};

/**
 * A12 — antimicrobial-use density (D3, umbrella §7). Counts medication_started
 * events whose drug_code classifies as antimicrobial (isAntimicrobial over the
 * curated DRUG_CATALOG) and expresses the result per 1,000 active pets over the
 * period. Codes not present in the catalog are counted separately as a
 * provisional raw count rather than guessed into the rate.
 *
 * Scope: medication_started does not carry jurisdiction in its payload, so we
 * inner-join pets and scope on pets.jurisdiction*.
 *
 * Classification is done in SQL via an inlined allow-list of antimicrobial drug
 * codes derived from DRUG_CATALOG at module load, keeping the truth source in
 * lib/drugs.ts. The full set of known codes drives the provisional-vs-confident
 * split.
 */
const ANTIMICROBIAL_CODES: readonly string[] = DRUG_CATALOG.filter((d) =>
  isAntimicrobial(d.code),
).map((d) => d.code);

const KNOWN_DRUG_CODES: readonly string[] = DRUG_CATALOG.filter((d) =>
  isClassifiedDrug(d.code),
).map((d) => d.code);

export async function fetchAmrDensity(ctx: ProjectionContext): Promise<AmrDensityMetric> {
  if (hasNoScope(ctx)) {
    return { antimicrobialCount: 0, activePets: 0, per1000: null, provisionalUnclassified: 0 };
  }

  const scope = petsScopeClause(ctx);
  const scopeFragment = scope ? sql` AND (${scope})` : sql``;
  // ISO + ::timestamptz cast — see fetchRabiesObservationCompliance comment.
  const sinceIso = ctx.period.since.toISOString();
  const untilIso = ctx.period.until.toISOString();

  const amrList = sql.join(
    ANTIMICROBIAL_CODES.map((c) => sql`${c}`),
    sql`, `,
  );
  const knownList = sql.join(
    KNOWN_DRUG_CODES.map((c) => sql`${c}`),
    sql`, `,
  );

  // drug_code is amendable (medication_started): a prescription corrected
  // from amoxicillin to meloxicam must leave the antimicrobial numerator.
  // amendedPayloadText is a correlated scalar subquery (latest event_amended,
  // LATERAL over its changes[]) — inlining it three times below made Postgres
  // prove the same correction three times per row. A LATERAL join computes it
  // ONCE per row (`dc.value`) and every FILTER below just reads that column
  // (fresh performance review, 2026-09-22).
  const drugCode = amendedPayloadText("drug_code", {
    id: sql`med.id`,
    payload: sql`med.payload`,
    petId: sql`med.pet_id`,
  });

  const [rows, activePets] = await Promise.all([
    db.execute<{ antimicrobial: string; unclassified: string }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE dc.value IN (${amrList})
        )::text AS antimicrobial,
        COUNT(*) FILTER (
          WHERE dc.value IS NULL
             OR dc.value NOT IN (${knownList})
        )::text AS unclassified
      FROM pet_events med
      JOIN pets ON pets.id = med.pet_id
      CROSS JOIN LATERAL (SELECT (${drugCode}) AS value) dc
      WHERE med.event_type = 'medication_started'
        AND med.occurred_at >= ${sinceIso}::timestamptz
        AND med.occurred_at <= ${untilIso}::timestamptz
        -- NUMERATOR ⊆ DENOMINATOR: the rate below divides by
        -- cachedActivePetCount(ctx), which counts status IN ('active','lost').
        -- Without this filter a prescription written for a pet that later died
        -- kept counting on top while the pet left the bottom, inflating
        -- doses-per-1000. Same class as the rabies-coverage numerator.
        AND pets.status IN ('active', 'lost')
        ${scopeFragment}
    `),
    cachedActivePetCount(ctx),
  ]);

  const antimicrobialCount = Number(rows[0]?.antimicrobial ?? 0);
  const provisionalUnclassified = Number(rows[0]?.unclassified ?? 0);
  const per1000 =
    activePets > 0 ? Math.round((antimicrobialCount / activePets) * 1000 * 10) / 10 : null;

  return { antimicrobialCount, activePets, per1000, provisionalUnclassified };
}

// ===========================================================================
// A6 / A10 — Reportable-disease incidence + lab-confirmation rate
// ===========================================================================

export type ReportableIncidenceRow = Cell & {
  /** Disease key (disease_reported.payload.disease or death_recorded.disease_code). */
  key: string;
  /** Total reportable events for this disease in the period. */
  count: number;
  /** How many of those were lab-confirmed. */
  confirmed: number;
};

export type ReportableIncidenceMetric = {
  /** Per-disease incidence, k-anonymity suppressed (cells with count < 5 hidden). */
  byDisease: MetricResult<SuppressedCells>;
  /** Total reportable events across all diseases (raw, for the headline number). */
  totalReportable: number;
  /** Total lab-confirmed reportable events. */
  totalConfirmed: number;
  /**
   * A10: % of reportable events confirmed by lab. null when there are no
   * reportable events in the period.
   */
  labConfirmationPct: number | null;
};

/**
 * A6 (incidence) + A10 (lab-confirmation rate) — reads the existing reportable
 * sources (D4): disease_reported events (payload.disease + payload.confirmed_by_lab)
 * and death_recorded events flagged payload.is_reportable=true (payload.disease_code
 * + payload.confirmed_by_lab). No new disease codes are introduced.
 *
 * Per-disease counts are k-anonymity suppressed (suppressSmallCells, k=5) since
 * a disease cell is effectively a small locality-style cell — a count of 1–4 in
 * a narrow jurisdiction could re-identify. The headline totals are unsuppressed
 * aggregate counts (no per-pet attribution).
 *
 * Scope: both sources scope via an inner join to pets + petsScopeClause, because
 * death_recorded carries no jurisdiction in its payload.
 */
export async function fetchReportableIncidence(
  ctx: ProjectionContext,
): Promise<ReportableIncidenceMetric> {
  if (hasNoScope(ctx)) {
    return {
      byDisease: suppressedMetric<ReportableIncidenceRow>([], {
        count: (r) => r.count,
        key: (r) => r.key,
      }),
      totalReportable: 0,
      totalConfirmed: 0,
      labConfirmationPct: null,
    };
  }

  const scope = petsScopeClause(ctx);
  const scopeFragment = scope ? sql` AND (${scope})` : sql``;
  // ISO + ::timestamptz cast — see fetchRabiesObservationCompliance comment.
  const sinceIso = ctx.period.since.toISOString();
  const untilIso = ctx.period.until.toISOString();

  // Union both reportable sources into one (disease, confirmed) stream, then
  // aggregate per disease. death_recorded only counts when is_reportable=true.
  const rows = await db.execute<{ disease: string; n: string; confirmed: string }>(sql`
    WITH reportable AS (
      SELECT
        COALESCE(NULLIF(dr.payload->>'disease', ''), 'other') AS disease,
        (dr.payload->>'confirmed_by_lab') = 'true' AS confirmed
      FROM pet_events dr
      JOIN pets ON pets.id = dr.pet_id
      WHERE dr.event_type = 'disease_reported'
        AND dr.occurred_at >= ${sinceIso}::timestamptz
        AND dr.occurred_at <= ${untilIso}::timestamptz
        ${scopeFragment}

      UNION ALL

      SELECT
        COALESCE(NULLIF(de.payload->>'disease_code', ''), 'other') AS disease,
        (de.payload->>'confirmed_by_lab') = 'true' AS confirmed
      FROM pet_events de
      JOIN pets ON pets.id = de.pet_id
      WHERE de.event_type = 'death_recorded'
        AND (de.payload->>'is_reportable') = 'true'
        AND de.occurred_at >= ${sinceIso}::timestamptz
        AND de.occurred_at <= ${untilIso}::timestamptz
        ${scopeFragment}
    )
    SELECT
      disease,
      COUNT(*)::text AS n,
      COUNT(*) FILTER (WHERE confirmed)::text AS confirmed
    FROM reportable
    GROUP BY disease
    ORDER BY COUNT(*) DESC
  `);

  const perDisease: ReportableIncidenceRow[] = rows.map((r) => ({
    key: r.disease,
    count: Number(r.n),
    confirmed: Number(r.confirmed),
  }));

  const totalReportable = perDisease.reduce((s, r) => s + r.count, 0);
  const totalConfirmed = perDisease.reduce((s, r) => s + r.confirmed, 0);

  const byDisease = suppressedMetric<ReportableIncidenceRow>(perDisease, {
    count: (r) => r.count,
    key: (r) => r.key,
  });

  return {
    byDisease,
    totalReportable,
    totalConfirmed,
    labConfirmationPct:
      totalReportable > 0 ? Math.round((totalConfirmed / totalReportable) * 1000) / 10 : null,
  };
}

// ===========================================================================
// Aggregate — one call for the whole compliance panel set.
// ===========================================================================

export type SurveillanceCompliance = {
  enoSla: EnoSlaMetric;
  rabiesCompliance: RabiesComplianceMetric;
  amrDensity: AmrDensityMetric;
  reportableIncidence: ReportableIncidenceMetric;
};

/**
 * Convenience aggregate that fetches every Item 3 sub-metric in parallel for a
 * single ProjectionContext. The page builds the context once and renders each
 * sub-metric into its own Op* card / breach panel.
 */
export async function fetchSurveillanceCompliance(
  ctx: ProjectionContext,
): Promise<SurveillanceCompliance> {
  const [enoSla, rabiesCompliance, amrDensity, reportableIncidence] = await Promise.all([
    fetchEnoSla(ctx),
    fetchRabiesObservationCompliance(ctx),
    fetchAmrDensity(ctx),
    fetchReportableIncidence(ctx),
  ]);
  return { enoSla, rabiesCompliance, amrDensity, reportableIncidence };
}
