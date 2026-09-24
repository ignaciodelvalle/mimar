// govt-queue-aging — the two SLA-bearing /gob home queues, aged.
//
// D-4 (Lote D, 2026-08-16). The home's "Cola operativa" tiles showed a bare
// count. /gob/acciones already ranks the SAME rows by deadline, but it does so
// by FETCHING them (up to 700 across three domains, 6s budget each) — far too
// heavy for a landing page that already fans out twenty aggregates. So this
// module answers the same two questions with ONE cheap grouped aggregate per
// domain: how many rows are past their own SLA, and how old is the oldest one.
//
// REUSE, NOT RE-DERIVATION — every predicate here comes from the module that
// already owns it:
//   - scope:      welfare → buildMaltratoListConditions (the maltrato queue's
//                 own condition builder, incl. the C3 ONE-VIEWSCOPE clause);
//                 casos → buildGovtCaseWhereClause / buildAdminCaseFilterClauses
//                 (the same builders countCasesForGovt / countCasesForAdmin use,
//                 so the tile's count and its aging describe ONE row set).
//   - SLA tiers:  WELFARE_SLA_DAYS / slaDaysForSeverity, CASE_SLA_WARNING_DAYS.
//                 A cutoff is computed per severity in TS and pushed into the
//                 filtered COUNT — the numbers are never retyped here.
//   - day math:   ageInDays (lib/domain/queue-aging) → calendarDaysAgoInAr, the
//                 same AR calendar the worklist badges speak.
//
// The overdue predicate is a millisecond compare against a TS-computed cutoff,
// matching computeDueInfo's "overdue is a millisecond fact" posture exactly —
// a row is overdue here iff /gob/acciones would badge it "Venció".

import { and, eq, inArray, isNull, lt, not, or, sql } from "drizzle-orm";

import { WELFARE_SLA_DAYS } from "@/app/gob/maltrato/_lib/welfare-sla";
import { cases, analyticsDb as db, welfareReports } from "@/db";
import { buildMaltratoListConditions } from "@/lib/analytics/dashboards/welfare";
import { type GobReadRole, hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { type QueueAging, ageInDays } from "@/lib/domain/queue-aging";
import { buildAdminCaseFilterClauses, buildGovtCaseWhereClause } from "@/lib/infra/case-queries";
import type { DashboardJurisdiction } from "@/lib/metrics";
import type { CaseKind } from "@/src/modules/cases/domain/case-kinds";
import { CASE_SLA_WARNING_DAYS } from "@/src/modules/cases/domain/case-sla";
import { WELFARE_REPORT_SEVERITIES } from "@/src/modules/welfare/domain/types";
import { TERMINAL_STATUSES } from "@/src/modules/welfare/domain/welfare-status-rules";

const MS_PER_DAY = 86_400_000;

/**
 * Row shape both aggregates return. `oldest` is null on an empty queue.
 *
 * It is typed as a STRING, not a Date, and that is the whole point.
 * drizzle-orm's postgres-js driver installs identity ("transparent") parsers for
 * every timestamp OID — 1082/1083/1114/1184 and their array twins — so that its
 * own COLUMN mappers own the conversion (drizzle-orm/postgres-js/driver.cjs).
 * A raw `sql` fragment has no column mapper, so `min(created_at)` arrives as the
 * wire text postgres sent — "2024-01-01 00:00:00+00" — and `sql<Date>` there is
 * a compile-time claim the runtime never honours. TypeScript then vouches for
 * the lie all the way down to the formatter.
 *
 * This is the SECOND surface it took down. First /admin/sistema (digest
 * 1282362471 — see the same warning over `lastAt` in lib/analytics/
 * admin-metrics.ts), then /gob (RangeError: Invalid time value, correlationId
 * 063a76c4): ageInDays → calendarDaysAgoInAr → Intl.DateTimeFormat.format(str)
 * coerces the text with ToNumber, gets NaN, and throws — which the briefing's
 * loadWithTimeout caught as a whole-page degrade, chrome and all.
 *
 * Note which state is the dangerous one: an EMPTY queue returns null and is
 * perfectly safe. The crash needs ROWS. That is why every local suite stayed
 * green (the page test mocks this module, and the pure day-math test feeds it
 * real Dates) while a jurisdiction with real denuncias fell over.
 */
type AgingRow = { oldest: string | Date | null; overdue: number };

/**
 * Turn the driver's raw aggregate value into the Date the rest of this module
 * assumes. Accepts a Date as well as the string postgres-js actually returns, so
 * a future driver — or a caller that maps the column itself — needs no second
 * fix; this is the posture lib/analytics/org-dashboard.ts's `toSignal` already
 * takes over the identical MIN aggregate.
 *
 * The NaN branch is a fail-safe, not the fix: a MIN over a timestamptz column
 * emits either NULL or parseable text, never garbage. The fix is the parse.
 */
function coerceAggregateDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toAging(row: AgingRow | undefined, now: Date): QueueAging {
  const oldest = coerceAggregateDate(row?.oldest);
  return {
    oldestAgeDays: oldest === null ? null : ageInDays(oldest, now),
    overdueCount: Number(row?.overdue ?? 0),
  };
}

/** Actor shape the welfare condition builder needs — mirrors the page's. */
export type GovtQueueActor = { role: GobReadRole };

/**
 * Aging of the OPEN welfare (maltrato) queue in the caller's scope.
 *
 * Each severity carries its own SLA tier, so "overdue" is a per-severity cutoff,
 * not one global age threshold — a `low` denuncia at 20 days may be perfectly in
 * time while a `critical` one at 3 days is already breached. The cutoffs are
 * computed here and pushed into a single filtered COUNT, so the whole answer is
 * one aggregate over an already-indexed predicate.
 */
export async function fetchWelfareQueueAging(
  actor: GovtQueueActor,
  filteredJurisdictions: readonly DashboardJurisdiction[],
  currentUserId: string,
  opts: { selectedProvince?: string | null; selectedLocality?: string | null } = {},
  now: Date = new Date(),
): Promise<QueueAging> {
  // The SAME condition builder the maltrato queue uses, with queue "all" (no
  // workflow lens) — identical to how worklist-io.ts calls it.
  const universal = hasNationalReadScope(actor.role);
  const scope = buildMaltratoListConditions({
    actor: { role: actor.role },
    filteredJurisdictions: universal ? [] : [...filteredJurisdictions],
    queue: "all",
    selectedProvince: universal ? (opts.selectedProvince ?? null) : null,
    selectedLocality: universal ? (opts.selectedLocality ?? null) : null,
    currentUserId,
  });

  // A closed/duplicate/invalid denuncia has no deadline left to miss — the same
  // non-terminal predicate worklist-io.ts applies.
  const stillOpen = not(inArray(welfareReports.status, [...TERMINAL_STATUSES]));

  // Per-severity cutoff: created before it ⇒ already past this severity's tier.
  const overdueClause = or(
    ...WELFARE_REPORT_SEVERITIES.map((severity) =>
      and(
        eq(welfareReports.severity, severity),
        lt(
          welfareReports.createdAt,
          new Date(now.getTime() - WELFARE_SLA_DAYS[severity] * MS_PER_DAY),
        ),
      ),
    ),
  );

  const [row] = await db
    .select({
      // sql<string | null>, never sql<Date>: see AgingRow above.
      oldest: sql<string | null>`min(${welfareReports.createdAt})`,
      overdue: sql<number>`count(*) filter (where ${overdueClause})::int`,
    })
    .from(welfareReports)
    .where(and(scope, stillOpen));

  return toAging(row, now);
}

/**
 * Aging of the OPEN regulatory-cases queue in the caller's scope.
 *
 * One global cutoff here (CASE_SLA_WARNING_DAYS), because cases carry a single
 * SLA window rather than per-severity tiers — caseSlaDueAt's rule, expressed as
 * the cutoff its inverse implies.
 */
export async function fetchCasesQueueAging(
  scope:
    | { role: "govt"; jurisdictions: readonly DashboardJurisdiction[] }
    | { role: "admin"; province: string | null; locality: string | null },
  filters: { excludeKinds?: readonly CaseKind[] },
  now: Date = new Date(),
): Promise<QueueAging> {
  // A govt operator with zero assignments sees zero rows — fail closed WITHOUT
  // a query, the same short-circuit countCasesForGovt applies.
  if (scope.role === "govt" && scope.jurisdictions.length === 0) {
    return { oldestAgeDays: null, overdueCount: 0 };
  }

  const cutoff = new Date(now.getTime() - CASE_SLA_WARNING_DAYS * MS_PER_DAY);
  const overdueClause = lt(cases.openedAt, cutoff);

  const where =
    scope.role === "govt"
      ? buildGovtCaseWhereClause([...scope.jurisdictions], {
          status: "open",
          excludeKinds: filters.excludeKinds,
        })
      : and(
          ...buildAdminCaseFilterClauses({
            status: "open",
            excludeKinds: filters.excludeKinds,
            province: scope.province,
            locality: scope.locality,
          }),
        );

  const [row] = await db
    .select({
      // sql<string | null>, never sql<Date>: see AgingRow above.
      oldest: sql<string | null>`min(${cases.openedAt})`,
      overdue: sql<number>`count(*) filter (where ${overdueClause})::int`,
    })
    .from(cases)
    // `status: "open"` already lands as closedAt IS NULL inside the shared
    // builders; the explicit clause is belt-and-braces against a builder whose
    // status vocabulary later grows a third value.
    .where(and(where, isNull(cases.closedAt)));

  return toAging(row, now);
}
