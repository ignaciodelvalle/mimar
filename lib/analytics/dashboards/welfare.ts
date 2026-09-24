// Maltrato (welfare_reports) dashboard fetchers — E4.
// Split out of lib/analytics/govt-dashboards.ts (engram refactor/govt-dashboards-split).

import {
  type SQL,
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  not,
  sql,
} from "drizzle-orm";

import { WELFARE_SLA_DAYS } from "@/app/gob/maltrato/_lib/welfare-sla";
import { caseEvents, cases, analyticsDb as db, petEvents, profiles, welfareReports } from "@/db";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { TERMINAL_STATUSES } from "@/src/modules/welfare/domain/welfare-status-rules";
import { DAY_MS, welfareReportsScopeClause } from "./_scope";

// welfareReportsScopeClause now lives in ./_scope alongside every other
// dashboard scope helper (C3, ONE VIEWSCOPE). Re-exported here so the maltrato
// list page, the govt-dashboards barrel and their tests keep their import path.
export { welfareReportsScopeClause };

// ============================================================================
// Moderation queue WHERE-clause builder (jurisdiction denuncia moderation)
//
// The flagged-denuncia moderation queue. /admin/moderacion sees it universally
// (includeEscalated: true — it's the escalation inbox); /gob/moderacion sees
// ONLY the viewer's assigned localities (govt) with includeEscalated omitted
// (false) — its "pending" excludes reports already escalated to admin. Both
// pages call this ONE builder + the jurisdiction scope clause, so there is no
// forked query — only the includeEscalated flag differs. A flagged report
// with no/ambiguous jurisdiction never matches a govt scope pair, so it stays
// admin-only (never invisible to everyone).
// ============================================================================

export type ModerationQueueStatus = "pending" | "resolved" | "all";

export type ModerationQueueFilters = {
  actor: DashboardActor;
  /** The viewer's active jurisdiction assignments (empty for admin = universal). */
  jurisdictions: DashboardJurisdiction[];
  /** pending = actionable (unresolved, not escalated unless includeEscalated); resolved; all = every flagged row in scope. */
  status: ModerationQueueStatus;
  kind?: string | null;
  severity?: string | null;
  /**
   * `false` (default) = govt actionable-queue semantics: "pending" excludes
   * reports already escalated to admin (moderationEscalatedAt IS NOT NULL) —
   * they've left the govt queue.
   * `true` = admin escalation-inbox semantics: "pending" INCLUDES escalated-
   * but-unresolved reports, because escalation is append-only (does NOT set
   * moderationResolvedAt — see escalate-moderation-to-admin.ts) and
   * /admin/moderacion is the receiving end of that hand-off.
   */
  includeEscalated?: boolean;
};

/**
 * Returns a Drizzle SQL condition for the flagged-denuncia moderation queue,
 * scoped to the viewer:
 *   - Only flagged rows (flaggedAt IS NOT NULL).
 *   - Jurisdiction scope (govt: assignment pairs; admin: universal). Rows with
 *     no jurisdiction never match a govt pair, so they stay admin-only.
 *   - status: pending = unresolved (and, unless includeEscalated, not
 *     escalated) — the actionable queue; resolved = moderation already
 *     resolved; all = every flagged row in scope.
 *   - Optional kind / severity narrow filters.
 *
 * Returns `sql\`false\`` when a govt viewer has no jurisdiction assignments.
 */
export function buildModerationQueueConditions(filters: ModerationQueueFilters): SQL {
  const { actor, jurisdictions, status, kind, severity, includeEscalated = false } = filters;

  // Short-circuit: a govt with no assignments can never see any flagged row.
  if (actor.role === "govt" && jurisdictions.length === 0) {
    return sql`false`;
  }

  const conditions: SQL[] = [isNotNull(welfareReports.flaggedAt) as SQL];

  // Jurisdiction scope (govt only — admin is unscoped/universal).
  const scope = welfareReportsScopeClause(actor, jurisdictions);
  if (scope) conditions.push(sql`(${scope})`);

  // Status bucket.
  if (status === "pending") {
    // Actionable queue: not yet resolved.
    conditions.push(sql`(${welfareReports.moderationResolvedAt} IS NULL)`);
    if (!includeEscalated) {
      // Govt queue: also exclude reports already handed off to admin.
      conditions.push(sql`(${welfareReports.moderationEscalatedAt} IS NULL)`);
    }
  } else if (status === "resolved") {
    conditions.push(sql`(${welfareReports.moderationResolvedAt} IS NOT NULL)`);
  }
  // "all" = every flagged row in scope (no extra clause).

  if (kind) conditions.push(eq(welfareReports.kind, kind as never) as SQL);
  if (severity) conditions.push(eq(welfareReports.severity, severity as never) as SQL);

  return and(...conditions) as SQL;
}

// TERMINAL_STATUSES (closed | invalid | duplicate) is imported from the welfare
// domain — the single source of truth shared with govt-home-kpis and
// owner-dashboard so every welfare count treats "terminal" identically (C4).

// ============================================================================
// Maltrato list WHERE-clause builder (E4 followup)
//
// Consolidates every filter that was previously applied in JS post-fetch into
// a composable Drizzle WHERE condition. Exported to allow unit testing without
// a full DB round-trip.
// ============================================================================

export type MaltratoQueue = "urgent" | "mine" | "all" | "overdue" | "unassigned" | "unverified";

export type MaltratoListFilters = {
  actor: DashboardActor;
  /** Intersected (assignment ∩ UI selection) jurisdiction set from the page. */
  filteredJurisdictions: DashboardJurisdiction[];
  queue: MaltratoQueue;
  kind?: string | null;
  severity?: string | null;
  /** Status narrow filter — restores parity with the old JS ?status= param handling. */
  status?: string | null;
  /**
   * For ADMIN only: canonical province name selected in the URL (?province=).
   * Govt callers must NOT pass this — their scope is already enforced by
   * filteredJurisdictions; passing selectedProvince for govt could widen the scope.
   */
  selectedProvince?: string | null;
  /**
   * For ADMIN only: canonical locality name selected in the URL (?locality=).
   * See selectedProvince. Ignored unless selectedProvince is also set.
   */
  selectedLocality?: string | null;
  currentUserId: string;
};

/**
 * SQL form of `isSlaBreached` (app/gob/maltrato/_lib/welfare-sla.ts): a report
 * is overdue when its age exceeds the window ITS OWN severity earns.
 *
 * Built FROM the shared WELFARE_SLA_DAYS map rather than repeating the numbers,
 * so a tier change moves the badge, the ORDER BY and this filter together. An
 * unknown/legacy severity falls back to the loosest tier — the same direction
 * the pure predicate takes, so a bad value can never manufacture a breach.
 *
 * Terminal statuses are excluded by the caller (nothing left to escalate).
 */
function slaBreachedClause(): SQL {
  // Every parameter carries an explicit cast. Without them Postgres cannot infer
  // a type for a bare `$n` inside CASE, nor multiply the result by an INTERVAL,
  // and the query fails at execution rather than at build — the SQL LOOKS right
  // in the condition tree, which is why the unit test alone did not catch it.
  const branches = Object.entries(WELFARE_SLA_DAYS).map(
    ([severity, days]) => sql`WHEN ${severity}::text THEN ${days}::int`,
  );
  const loosest = Math.max(...Object.values(WELFARE_SLA_DAYS));
  const window = sql`(CASE ${welfareReports.severity}::text ${sql.join(branches, sql` `)} ELSE ${loosest}::int END)`;
  return sql`${welfareReports.createdAt} < now() - (${window} * INTERVAL '1 day')`;
}

/**
 * Returns a Drizzle SQL condition that encodes every filter for the maltrato
 * triage list:
 *   - Jurisdiction scope (intersected assignments — never widens beyond them)
 *   - Moderation exclusion (flagged but not yet admin-resolved)
 *   - Kind / severity narrow filters
 *   - Queue predicate (urgent / mine / overdue / all)
 *
 * Returns `sql\`false\`` when a govt user has no jurisdiction assignments so
 * the query will always produce zero rows.
 */
export function buildMaltratoListConditions(filters: MaltratoListFilters) {
  const {
    actor,
    filteredJurisdictions,
    queue,
    kind,
    severity,
    status,
    selectedProvince,
    selectedLocality,
    currentUserId,
  } = filters;

  // Short-circuit: govt with no assignments can never see any row.
  if (actor.role === "govt" && filteredJurisdictions.length === 0) {
    return sql`false`;
  }

  const conditions = [];

  // 1. Jurisdiction scope — govt jurisdiction pairs, OR the admin's URL
  //    province/locality selection (?province= / ?locality=) as a drill
  //    predicate. ONE helper resolves both (C3, ONE VIEWSCOPE), so this list
  //    and fetchWelfareMetrics' KPI tiles cannot drift apart on scope. Govt
  //    users must NOT pass selectedProvince/selectedLocality; their scope is
  //    already enforced by filteredJurisdictions (assignments ∩ URL selection,
  //    computed in the page layer) and the helper ignores them for govt.
  const scope = welfareReportsScopeClause(
    actor,
    filteredJurisdictions,
    selectedProvince ?? undefined,
    selectedLocality ?? undefined,
  );
  if (scope) conditions.push(sql`(${scope})`);

  // 2. Moderation exclusion — hide flagged rows awaiting admin review.
  conditions.push(
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
  );

  // 3. Kind narrow filter.
  if (kind) conditions.push(eq(welfareReports.kind, kind as never));

  // 4. Severity narrow filter.
  if (severity) conditions.push(eq(welfareReports.severity, severity as never));

  // 5. Status narrow filter — restores parity with the old ?status= JS filtering.
  if (status) conditions.push(eq(welfareReports.status, status as never));

  // 6. Queue predicate.
  switch (queue) {
    case "urgent":
      // Critical or high severity, not yet in a terminal status.
      // S-1: if severity is set to a non-(critical|high) value AND queue=urgent,
      // the AND of these two conditions is always false — contradictory filter → no rows by design.
      conditions.push(inArray(welfareReports.severity, ["critical", "high"]));
      conditions.push(not(inArray(welfareReports.status, [...TERMINAL_STATUSES])));
      break;
    case "mine":
      // Assigned to the current user, non-terminal status only — the exact
      // predicate behind the "Mías" KPI (fetchWelfareMetrics.myCount /
      // fetchMyAssignedWelfareCount). Before this fix the terminal exclusion
      // was documented in this comment but NEVER applied to the query, so the
      // "Mías" KPI tile (which DOES exclude closed/invalid/duplicate) and the
      // list its href drills into (?queue=mine, which showed EVERY status)
      // silently disagreed — the KPI↔list parity bug class this module's own
      // docblock warns about (see "KPI↔list parity" note below), just never
      // covered by a test for this queue. C6c workqueue-grammar fix.
      conditions.push(eq(welfareReports.assignedToUserId, currentUserId));
      conditions.push(not(inArray(welfareReports.status, [...TERMINAL_STATUSES])));
      break;
    case "unassigned":
      // No operator assigned yet AND not in a terminal status — the exact
      // predicate behind the "Sin asignar" KPI (fetchWelfareMetrics.unassignedCount).
      // Keeps the KPI tile's drill-down honest: the list it opens is the same
      // set the tile counts.
      conditions.push(isNull(welfareReports.assignedToUserId));
      conditions.push(not(inArray(welfareReports.status, [...TERMINAL_STATUSES])));
      break;
    case "overdue":
      // THE SAME RULE THE ROW BADGE USES — not a second one.
      //
      // This filter used to be `status = 'open' AND createdAt < now() - 7d`, a
      // flat window that predates the severity tiers. app/gob/maltrato/_lib/
      // welfare-sla.ts introduced 1/3/7/14 days by severity and says in its own
      // header that it exists "so the row badge, the ORDER BY rank and the
      // keyset cursor can never disagree on what breached means" — the tab was
      // the one caller nobody migrated, and it kept the 7-day number the module
      // had merely ADOPTED as its medium tier.
      //
      // Live review 2026-07-28 measured the cost: the tab said 5 while SEVEN
      // rows carried a VENCIDO badge, hiding a *crítica* report three days past
      // its 1-day SLA. It also went the other way — a row inside the tab
      // displayed "SIN SLA ACTIVO", because `open` is not the only non-terminal
      // status.
      conditions.push(not(inArray(welfareReports.status, [...TERMINAL_STATUSES])));
      conditions.push(slaBreachedClause());
      break;
    case "unverified":
      // D.11 (2026-07-31) — rows whose jurisdiction was recovered from the FORM
      // TEXT because the geocoder was down. They are NOT hidden from the other
      // tabs: every one of them also appears in the queue of the jurisdiction it
      // guessed, wearing a visible "Jurisdicción sin verificar" pill. This tab is
      // a LENS, the same kind `urgent`/`mine`/`overdue` already are — a way to
      // isolate the guesses for an audit pass, never the only place they live.
      //
      // Why not a separate bucket ONLY: nobody watches a bucket of maybes. That
      // reproduces the exact defect (invisible report) under a nicer name.
      // Why not the guessed queue ONLY: an operator who cannot separate guesses
      // from real workload stops trusting the whole queue. Both, therefore —
      // routed and marked by default, separable on demand.
      conditions.push(eq(welfareReports.jurisdictionUnverified, true));
      break;
    default:
      // "all" — no extra filter.
      break;
  }

  return and(...conditions);
}

export type WelfareMetrics = {
  /** Welfare reports in scope with assigned_to_user_id IS NULL AND status NOT in closed/invalid/duplicate. */
  unassignedCount: number;
  /** Welfare reports in scope assigned to currentUserId, status open|triaged|in_progress. */
  myCount: number;
  /** Welfare reports in scope with status='in_progress'. */
  inProgressCount: number;
  /** Welfare reports in scope closed in the last 30 days. */
  closedMonth: number;
};

// KPI↔list parity (filter-honesty fix 2026-07): the maltrato KPI tiles used to
// ignore kind/severity/status/admin-province entirely, so a filtered list
// (buildMaltratoListConditions) and its "totals" tiles disagreed. This mirrors
// ONLY the domain axes (kind/severity/status) + jurisdiction/admin scope —
// deliberately excludes `queue`, which is a WORKFLOW lens over the list, not a
// domain filter, and must never skew a KPI count.
export type WelfareMetricsFilters = Pick<
  MaltratoListFilters,
  "kind" | "severity" | "status" | "selectedProvince" | "selectedLocality"
>;

export async function fetchWelfareMetrics(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  currentUserId: string,
  filters?: WelfareMetricsFilters,
): Promise<WelfareMetrics> {
  if (actor.role === "govt" && jurisdictions.length === 0) {
    return { unassignedCount: 0, myCount: 0, inProgressCount: 0, closedMonth: 0 };
  }

  const since30d = new Date(Date.now() - 30 * DAY_MS);
  const { kind, severity, status, selectedProvince, selectedLocality } = filters ?? {};

  // Jurisdiction scope — the SAME helper call buildMaltratoListConditions makes,
  // admin drill included (C3, ONE VIEWSCOPE). This is what keeps a tile and the
  // list it drills into from disagreeing about which province they describe.
  const scope = welfareReportsScopeClause(
    actor,
    jurisdictions,
    selectedProvince ?? undefined,
    selectedLocality ?? undefined,
  );

  // Domain narrow filters — the SAME eq() clauses buildMaltratoListConditions
  // applies to the list (identical enums, identical scope logic), so a tile
  // and the list it drills into always agree under the same filter set.
  const domainConditions: SQL[] = [];
  if (scope) domainConditions.push(sql`(${scope})`);
  if (kind) domainConditions.push(eq(welfareReports.kind, kind as never) as SQL);
  if (severity) domainConditions.push(eq(welfareReports.severity, severity as never) as SQL);
  if (status) domainConditions.push(eq(welfareReports.status, status as never) as SQL);
  // Moderation-exclusion — mirror buildMaltratoListConditions exactly: a flagged
  // report stays OUT of the work queue until moderation resolves it, so the KPI
  // tiles must exclude it too. Without this a flagged-but-unresolved report is
  // counted by a tile but absent from the list it drills into — the very
  // KPI↔list divergence this parity fix exists to eliminate, on the moderation
  // axis instead of kind/severity/status.
  domainConditions.push(
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
  );

  // 1. Unassigned: assigned_to_user_id IS NULL AND status NOT IN terminal.
  const unassignedConditions = [
    isNull(welfareReports.assignedToUserId),
    not(inArray(welfareReports.status, [...TERMINAL_STATUSES])),
    ...domainConditions,
  ];

  // 2. Mine: assigned to currentUserId, status in non-terminal active states.
  const myConditions = [
    eq(welfareReports.assignedToUserId, currentUserId),
    not(inArray(welfareReports.status, [...TERMINAL_STATUSES])),
    ...domainConditions,
  ];

  // 3. In-progress: status='in_progress'.
  const inProgressConditions = [eq(welfareReports.status, "in_progress"), ...domainConditions];

  // 4. Closed in last 30 days: status='closed' AND closed_at >= 30d ago.
  const closedMonthConditions = [
    eq(welfareReports.status, "closed"),
    gte(welfareReports.closedAt, since30d),
    ...domainConditions,
  ];

  const [unassignedRows, myRows, inProgressRows, closedMonthRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(welfareReports)
      .where(and(...unassignedConditions)),
    db
      .select({ n: count() })
      .from(welfareReports)
      .where(and(...myConditions)),
    db
      .select({ n: count() })
      .from(welfareReports)
      .where(and(...inProgressConditions)),
    db
      .select({ n: count() })
      .from(welfareReports)
      .where(and(...closedMonthConditions)),
  ]);

  return {
    unassignedCount: unassignedRows[0]?.n ?? 0,
    myCount: myRows[0]?.n ?? 0,
    inProgressCount: inProgressRows[0]?.n ?? 0,
    closedMonth: closedMonthRows[0]?.n ?? 0,
  };
}

// ============================================================================
// C6b — THE BRIEFING's "Mi trabajo asignado" block (plan-maestro-integridad.md
// §C6). /gob/page.tsx needs ONLY a count (never the full 4-query
// fetchWelfareMetrics bundle above — that would add 3 unused queries to an
// already-heavy home-page fetch set, violating C6b's zero-new-fan-out rule).
// Mirrors fetchWelfareMetrics' `myConditions` bucket exactly (assigned to the
// viewer, non-terminal status) as a single standalone query, so the home
// count and /gob/maltrato's "mine" queue never drift apart in definition.
// ============================================================================

/** Count of welfare reports assigned to `currentUserId` that are still
 *  actionable (non-terminal status), in scope. ONE query — see module note
 *  above for why this isn't fetchWelfareMetrics.myCount reused wholesale. */
export async function fetchMyAssignedWelfareCount(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  currentUserId: string,
): Promise<number> {
  if (actor.role === "govt" && jurisdictions.length === 0) return 0;

  const scope = welfareReportsScopeClause(actor, jurisdictions);
  const conditions: SQL[] = [
    eq(welfareReports.assignedToUserId, currentUserId),
    not(inArray(welfareReports.status, [...TERMINAL_STATUSES])) as SQL,
    // Mirror fetchWelfareMetrics' moderation exclusion — a flagged-but-
    // unresolved report stays out of the operator's actionable count.
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
  ];
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({ n: count() })
    .from(welfareReports)
    .where(and(...conditions));
  return rows[0]?.n ?? 0;
}

// ============================================================================
// Welfare timeline — E4
// ============================================================================

export type TimelineEvent = {
  id: string;
  occurredAt: Date;
  /** e.g. 'created', 'triaged', 'assigned', 'in_progress', 'closed', 'invalid', 'duplicate', 'pet_event' */
  kind: string;
  actorName?: string;
  summary: string;
};

/**
 * Derives a chronological list of timeline events for a welfare report.
 *
 * Sources:
 *  1. Synthetic 'created' event from welfare_reports.created_at.
 *  2. Synthetic 'triaged' event from welfare_reports.triaged_at (if present).
 *  3. Synthetic 'closed' / status event from welfare_reports.closed_at + status.
 *  4. Synthetic 'assigned' event from welfare_reports.assigned_to_user_id (if set).
 *  5. pet_events linked via welfare_reports.case_id → cases → pet_events (optional enrichment).
 *
 * Actor names resolved from profiles in a single batch query.
 */
/**
 * Map a case_events row to a gov-timeline summary string. Returns null for
 * entry types that should NOT surface in the gov welfare timeline. The org
 * display name is read from the payload when present.
 *
 * Exported for testing (UI-7 Part C).
 */
export function caseEventTimelineSummary(
  entryType: string,
  notes: string | null,
  payload: unknown,
): string | null {
  const orgName =
    payload && typeof payload === "object" && "orgDisplayName" in payload
      ? String((payload as Record<string, unknown>).orgDisplayName)
      : null;
  const trimmedNotes = notes?.trim() ? notes.trim() : null;

  switch (entryType) {
    case "reporter_comment":
      return trimmedNotes
        ? `Comentario del denunciante: ${trimmedNotes}`
        : "El denunciante agregó un comentario.";
    case "org_intervention_taken":
      return orgName
        ? `${orgName} tomó la denuncia y está interviniendo.`
        : "La organización tomó la denuncia y está interviniendo.";
    case "org_intervention_note":
      return trimmedNotes
        ? `Nota de intervención${orgName ? ` (${orgName})` : ""}: ${trimmedNotes}`
        : "La organización agregó una nota de intervención.";
    case "org_intervention_return":
      return `${orgName ?? "La organización"} devolvió la denuncia${
        trimmedNotes ? `: ${trimmedNotes}` : "."
      }`;
    default:
      return null;
  }
}

export async function fetchWelfareTimeline(reportId: string): Promise<TimelineEvent[]> {
  const [report] = await db
    .select()
    .from(welfareReports)
    .where(eq(welfareReports.id, reportId))
    .limit(1);

  if (!report) return [];

  const events: TimelineEvent[] = [];

  // Collect actor IDs to batch-resolve display names.
  const actorIdSet = new Set<string>();
  if (report.reporterUserId) actorIdSet.add(report.reporterUserId);
  if (report.triagedByUserId) actorIdSet.add(report.triagedByUserId);
  if (report.assignedToUserId) actorIdSet.add(report.assignedToUserId);

  // Pull pet_events linked via the case if available.
  let linkedPetEvents: Array<{
    id: string;
    eventType: string;
    occurredAt: Date;
    recordedByUserId: string | null;
  }> = [];
  // Pull case_events (reporter comments + org intervention notes) so the gov
  // timeline shows them. These live in case_events, NOT welfare_reports, so the
  // gov detail was previously blind to them (UI-7 Part C).
  let linkedCaseEvents: Array<{
    id: string;
    entryType: string;
    occurredAt: Date;
    notes: string | null;
    payload: unknown;
    recordedByUserId: string | null;
  }> = [];
  if (report.caseId) {
    linkedCaseEvents = await db
      .select({
        id: caseEvents.id,
        entryType: caseEvents.entryType,
        occurredAt: caseEvents.occurredAt,
        notes: caseEvents.notes,
        payload: caseEvents.payload,
        recordedByUserId: caseEvents.recordedByUserId,
      })
      .from(caseEvents)
      .where(eq(caseEvents.caseId, report.caseId))
      .orderBy(desc(caseEvents.occurredAt))
      .limit(50);

    for (const e of linkedCaseEvents) {
      if (e.recordedByUserId) actorIdSet.add(e.recordedByUserId);
    }

    const [linkedCase] = await db
      .select({ primaryPetId: cases.primaryPetId })
      .from(cases)
      .where(eq(cases.id, report.caseId))
      .limit(1);

    if (linkedCase?.primaryPetId) {
      linkedPetEvents = await db
        .select({
          id: petEvents.id,
          eventType: petEvents.eventType,
          occurredAt: petEvents.occurredAt,
          recordedByUserId: petEvents.recordedByUserId,
        })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, linkedCase.primaryPetId),
            gte(petEvents.occurredAt, report.createdAt),
          ),
        )
        .orderBy(desc(petEvents.occurredAt))
        .limit(20);

      for (const e of linkedPetEvents) {
        if (e.recordedByUserId) actorIdSet.add(e.recordedByUserId);
      }
    }
  }

  // Batch-resolve actor names.
  const actorIds = [...actorIdSet];
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const nameRows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, actorIds));
    for (const r of nameRows) actorNames.set(r.id, r.displayName);
  }

  // 1. Created event.
  events.push({
    id: `created-${report.id}`,
    occurredAt: report.createdAt,
    kind: "created",
    actorName: report.reporterUserId
      ? (actorNames.get(report.reporterUserId) ?? undefined)
      : undefined,
    summary: "Denuncia registrada en el sistema.",
  });

  // 2. Triaged event.
  if (report.triagedAt) {
    events.push({
      id: `triaged-${report.id}`,
      occurredAt: report.triagedAt,
      kind: "triaged",
      actorName: report.triagedByUserId
        ? (actorNames.get(report.triagedByUserId) ?? undefined)
        : undefined,
      summary: "Denuncia revisada por la autoridad.",
    });
  }

  // 3. Assigned event (synthetic — we know it's assigned but not when; use triagedAt or now).
  if (report.assignedToUserId) {
    const assignedName = actorNames.get(report.assignedToUserId) ?? "un agente";
    events.push({
      id: `assigned-${report.id}`,
      occurredAt: report.triagedAt ?? report.createdAt,
      kind: "assigned",
      actorName: assignedName,
      summary: `Caso asignado a ${assignedName}.`,
    });
  }

  // 4. In-progress / closed / terminal status events.
  if (report.status === "in_progress" && report.triagedAt) {
    events.push({
      id: `in_progress-${report.id}`,
      occurredAt: report.triagedAt,
      kind: "in_progress",
      summary: "Seguimiento activo iniciado.",
    });
  }
  if (report.closedAt) {
    const closedKindLabel =
      report.status === "invalid"
        ? "Cerrada por falta de sustento."
        : report.status === "duplicate"
          ? "Marcada como duplicada."
          : "Denuncia cerrada con resolución.";
    events.push({
      id: `closed-${report.id}`,
      occurredAt: report.closedAt,
      kind: report.status,
      summary: closedKindLabel,
    });
  }

  // 5. Pet events linked via case.
  for (const e of linkedPetEvents) {
    events.push({
      id: `pet-event-${e.id}`,
      occurredAt: e.occurredAt,
      kind: "pet_event",
      actorName: e.recordedByUserId ? (actorNames.get(e.recordedByUserId) ?? undefined) : undefined,
      summary: `Evento de mascota: ${e.eventType.replace(/_/g, " ")}.`,
    });
  }

  // 6. Case events — reporter comments + org intervention notes (UI-7 Part C).
  // Surfaced to gov so the maltrato detail shows the full case conversation.
  for (const e of linkedCaseEvents) {
    const summary = caseEventTimelineSummary(e.entryType, e.notes, e.payload);
    if (!summary) continue; // skip unknown / internal entry types
    events.push({
      id: `case-event-${e.id}`,
      occurredAt: e.occurredAt,
      kind: e.entryType,
      actorName: e.recordedByUserId ? (actorNames.get(e.recordedByUserId) ?? undefined) : undefined,
      summary,
    });
  }

  // Sort chronologically.
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
