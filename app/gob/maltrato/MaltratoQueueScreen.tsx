// MaltratoQueueScreen — jurisdiction-scoped welfare (maltrato) triage queue,
// Ley 14.346.
//
// F1 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/maltrato page.tsx, relocated so the Denuncias hub (app/gob/denuncias/
// page.tsx) can render it as its "Triage (Ley 14.346)" stage under
// ?etapa=triage. /gob/maltrato itself now only redirects here via the hub
// (see app/gob/maltrato/page.tsx) — this is a RELOCATION, not a redesign:
// same searchParams contract (queue/?panel=/?caso=/&mascota= all still work,
// read client-side via useSearchParams by InspectorMounter regardless of the
// parent route), same auth guard, same query logic, same C6c workqueue
// grammar (TomarButton/ActuarButton, tomar/actuar/cerrar).

import { type ReactNode, Suspense } from "react";

import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  CsvExportLink,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpKpi,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db, profiles, welfareReports } from "@/db";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  type MaltratoQueue,
  type WelfareMetrics,
  type WelfareMetricsFilters,
  buildMaltratoListConditions,
  fetchWelfareMetrics,
} from "@/lib/analytics/govt-dashboards";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { buildProjectionContext } from "@/lib/metrics";
import type { KpiId } from "@/lib/metrics/kpi-catalog";
import { isKpiPeriodInvariant } from "@/lib/metrics/kpi-period-invariance";
import { windows } from "@/lib/metrics/period";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { newerHref } from "@/lib/utils/keyset-pagination";
import {
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SEVERITIES,
  WELFARE_REPORT_STATUSES,
  type WelfareReportKind,
  type WelfareReportSeverity,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportStatusLabel,
} from "@/src/modules/welfare/domain/types";
import { type SQL, and, asc, count, inArray, sql } from "drizzle-orm";

import { csvPageDisclosure } from "@/lib/ui/csv-export";
import { formatCount, formatDateTime, todayIsoInAr } from "@/lib/utils/format";
import { type QueueChipItem, QueueFilterChips } from "./_components/QueueFilterChips";
import { WelfareDenunciaRow } from "./_components/WelfareDenunciaRow";
import { InspectorMounter } from "./_inspector/InspectorMounter";
import { decodeRiskCursor, encodeRiskCursor, severityRank } from "./_lib/welfare-sla";

const PAGE_SIZE = 50;
// Order is the rendered order of the chip row (see QueueFilterChips) — daily
// work first, audit lens last.
const VALID_QUEUES: MaltratoQueue[] = [
  "urgent",
  "unassigned",
  "mine",
  "all",
  "overdue",
  // D.11 audit lens — denuncias whose jurisdiction was recovered from the form
  // text after a geocoder failure. They stay in every other queue too; this only
  // isolates them.
  "unverified",
];

/**
 * ONE label vocabulary for the queue lens — read by the chip row AND by the CSV
 * export's "cola de trabajo:" disclosure line, so an export can never name a
 * queue differently from the control that selected it.
 */
const QUEUE_LABELS: Record<MaltratoQueue, string> = {
  urgent: "Urgentes",
  unassigned: "Sin asignar",
  mine: "Mías",
  all: "Todas",
  overdue: "Atrasadas",
  unverified: "Sin verificar",
};

// Default queue (C2 language contract, 2026-07-22 — PO-locked: "sin asignar
// abiertas", not "Todas"). "Todas" as a landing view buries the actionable
// triage work under every terminal/closed/historical row ever filed — the
// exact "default 'Todas' in maltrato" symptom named by S6 in the plan-maestro
// audit. `unassigned` already means "no operator assigned AND not terminal"
// (buildMaltratoListConditions), i.e. exactly "sin asignar abiertas".
const DEFAULT_QUEUE: MaltratoQueue = "unassigned";

/**
 * The 3 of the 4 triage stat tiles that are "now" stocks (see the KPI grid
 * below) — hoisted to module scope (not recomputed per render) so the
 * group-level "no varía con el período" footnote's guard doesn't add to the
 * component's cognitive complexity. Static: derived purely from the catalog,
 * not from any request/render data.
 */
const TRIAGE_PERIOD_INVARIANT_TILE_IDS: KpiId[] = [
  "maltrato_unassigned_count",
  "maltrato_assigned_to_me_count",
  "maltrato_in_progress_count",
];
const TRIAGE_HAS_PERIOD_INVARIANT_TILE =
  TRIAGE_PERIOD_INVARIANT_TILE_IDS.some(isKpiPeriodInvariant);

/**
 * Extracted as its own component (not an inline `&&` in the screen's JSX) so
 * the conditional lives in ITS OWN function's cognitive-complexity budget
 * rather than MaltratoQueueScreen's already-dense one.
 */
function TriagePeriodInvariantFootnote() {
  if (!TRIAGE_HAS_PERIOD_INVARIANT_TILE) return null;
  return (
    <p className="text-xs font-medium uppercase tracking-[0.06em] text-ln-op-faint">
      Sin asignar / Mías / {welfareReportStatusLabel("in_progress")}: no varían con el período.
    </p>
  );
}

const PAGE_LINK_CLASS =
  "rounded border border-ln-op-line px-3 py-1 text-ln-op-ink hover:bg-ln-op-stripe";

/**
 * Keyset pagination footer for the denuncias list.
 *
 * Extracted for the same reason as TriagePeriodInvariantFootnote above: its
 * three conditionals now live in ITS OWN cognitive-complexity budget. They used
 * to sit inside the queue tabs' `TABS.map` callback — a separate function
 * scope, which paid for them. With the tabs demoted to chips (M5) the card
 * renders once, directly in the screen body, so the nav needs its own function
 * or the screen inherits that cost.
 */
function QueuePaginationNav({
  totalCount,
  newerLink,
  olderLink,
}: {
  totalCount: number;
  newerLink: string | null;
  olderLink: string | null;
}) {
  if (!newerLink && !olderLink) return null;
  return (
    <nav
      aria-label="Paginación de denuncias"
      className="mt-4 flex items-center justify-between gap-2 text-sm"
    >
      <span className="text-ln-op-mute">{totalCount} denuncias en total</span>
      <div className="flex gap-2">
        {newerLink ? (
          <a href={newerLink} className={PAGE_LINK_CLASS}>
            ← Volver al inicio
          </a>
        ) : null}
        {olderLink ? (
          <a href={olderLink} className={PAGE_LINK_CLASS}>
            Ver más →
          </a>
        ) : null}
      </div>
    </nav>
  );
}

function parseQueue(raw: string | undefined): MaltratoQueue {
  if (!raw) return DEFAULT_QUEUE;
  return (VALID_QUEUES as string[]).includes(raw) ? (raw as MaltratoQueue) : DEFAULT_QUEUE;
}

function parseKind(raw: string | undefined): WelfareReportKind | null {
  if (!raw) return null;
  return (WELFARE_REPORT_KINDS as readonly string[]).includes(raw)
    ? (raw as WelfareReportKind)
    : null;
}

function parseSeverity(raw: string | undefined): WelfareReportSeverity | null {
  if (!raw) return null;
  return (WELFARE_REPORT_SEVERITIES as readonly string[]).includes(raw)
    ? (raw as WelfareReportSeverity)
    : null;
}

function parseStatus(raw: string | undefined): string | null {
  if (!raw) return null;
  return (WELFARE_REPORT_STATUSES as readonly string[]).includes(raw) ? raw : null;
}

// Domain-axis options for the filter bar. buildMaltratoListConditions already
// applies kind/severity/status; these surface the previously-invisible controls.
// Labels come from the SAME domain registry the rows/KPIs use (one vocabulary).
const KIND_OPTIONS = WELFARE_REPORT_KINDS.map((k) => ({
  value: k,
  label: welfareReportKindLabel(k),
}));
const SEVERITY_OPTIONS = WELFARE_REPORT_SEVERITIES.map((s) => ({
  value: s,
  label: welfareReportSeverityLabel(s),
}));
const STATUS_OPTIONS = WELFARE_REPORT_STATUSES.map((s) => ({
  value: s,
  label: welfareReportStatusLabel(s),
}));

/**
 * Counters shown inside the chips.
 *
 * ONLY the two queues whose exact row set the page ALREADY counts get one:
 * `fetchWelfareMetrics.unassignedCount` and `.myCount` are built from the
 * IDENTICAL predicates `buildMaltratoListConditions` applies for
 * `queue=unassigned` / `queue=mine` (assignee + non-terminal + the same
 * scope/domain/moderation conditions — see lib/analytics/dashboards/welfare.ts,
 * where both pairs are commented as deliberately mirrored). So these numbers
 * are free AND honest.
 *
 * The other four (urgent / all / overdue / unverified) have NO precomputed
 * count, and each would cost its own COUNT(*) on every render of a live triage
 * queue. A chip with no counter is the correct answer there — a number that
 * expensive is not worth a chip's worth of information, and a WRONG number
 * (e.g. reusing `inProgressCount` for `all`) would be worse than none.
 */
function queueCount(queue: MaltratoQueue, metrics: WelfareMetrics): number | undefined {
  if (queue === "unassigned") return metrics.unassignedCount;
  if (queue === "mine") return metrics.myCount;
  return undefined;
}

/**
 * Href that selects `queue`, preserving the domain + jurisdiction filters and
 * DROPPING the keyset `cursor` (a queue change invalidates the current page) —
 * the same `resetParamsOnChange={["cursor"]}` contract OpFilterBar applies to
 * every other control on this screen.
 *
 * The inspector's `?caso=` / `&mascota=` are not carried: they are written by
 * shallow history from the client (InspectorMounter), so a server-rendered link
 * cannot see them in the first place, and a case selected under one queue need
 * not exist under the next. Same posture the hub's `etapa` tabs already take.
 */
function queueHref(sp: MaltratoQueueScreenProps["searchParams"], queue: MaltratoQueue): string {
  const params = new URLSearchParams();
  params.set("etapa", "triage");
  params.set("queue", queue);
  for (const [key, value] of [
    ["kind", sp.kind],
    ["severity", sp.severity],
    ["status", sp.status],
    ["province", sp.province],
    ["locality", sp.locality],
  ] as const) {
    if (value) params.set(key, value);
  }
  return `/gob/denuncias?${params.toString()}`;
}

/**
 * The queue lens, as chips (UI review M5, 2026-08-06 — see
 * ./_components/QueueFilterChips for why these stopped being tabs). Built at
 * module scope, like TriagePeriodInvariantFootnote above and for the same
 * reason: the `.map` would otherwise spend from MaltratoQueueScreen's already
 * exhausted cognitive-complexity budget.
 *
 * D.11's "Sin verificar" comes last (VALID_QUEUES order): it is an audit lens,
 * not a daily queue, and every row it holds is already visible — and
 * pill-marked — in the chips to its left.
 */
function buildQueueChips(
  sp: MaltratoQueueScreenProps["searchParams"],
  metrics: WelfareMetrics,
): QueueChipItem[] {
  return VALID_QUEUES.map((queue) => ({
    value: queue,
    label: QUEUE_LABELS[queue],
    href: queueHref(sp, queue),
    count: queueCount(queue, metrics),
  }));
}

export type MaltratoQueueScreenProps = {
  searchParams: {
    period?: string;
    from?: string;
    to?: string;
    queue?: string;
    kind?: string;
    severity?: string;
    province?: string;
    locality?: string;
    cursor?: string;
    status?: string;
  };
  /**
   * True when rendered as the Denuncias hub's "Triage" stage
   * (app/gob/denuncias/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

/**
 * The screen's three-way fetch, BOUNDED and lifted out of the component.
 *
 * Bounded because this screen renders as the Triage tab INSIDE /gob/denuncias,
 * whose badge counts were bounded in the same outage pass while this body — the
 * part an operator actually works in — was left unbounded. Fixing the
 * decoration and leaving the queue able to hang is worse than fixing neither:
 * the hub would look healthy while its main surface never painted.
 *
 * Lifted out because adding the guard pushed the component past the
 * cognitive-complexity fence. Extracting the fetch is the honest way to pay
 * that down — the branch stays, the component just stops also owning the query
 * construction.
 */
/**
 * Display names for the assignees on this page, or an empty map when there are
 * none.
 *
 * Extracted for the same reason as TriagePeriodInvariantFootnote and
 * QueuePaginationNav above: its branch and loop now live in their own
 * cognitive-complexity budget instead of the screen's. That budget is real —
 * the screen sits just under the 25 limit, and adding ONE guard (the
 * loadWithTimeout degrade path) tipped it over.
 */
async function fetchAssigneeNames(assigneeIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (assigneeIds.length === 0) return names;
  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, assigneeIds));
  for (const a of rows) names.set(a.id, a.displayName);
  return names;
}

/** The keyset "Ver más" href, or null when this is the last page. */
function buildOlderLink(
  lastRow: { severity: WelfareReportSeverity; createdAt: Date; id: string } | undefined,
  filterParams: Record<string, string | undefined>,
): string | null {
  if (!lastRow) return null;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filterParams)) {
    if (v !== undefined) params.set(k, v);
  }
  params.set(
    "cursor",
    encodeRiskCursor(severityRank(lastRow.severity), lastRow.createdAt, lastRow.id),
  );
  return `/gob/denuncias?${params.toString()}`;
}

async function loadTriageData(args: {
  actor: Parameters<typeof fetchWelfareMetrics>[0];
  filteredJurisdictions: Parameters<typeof fetchWelfareMetrics>[1];
  userId: string;
  filters: WelfareMetricsFilters;
  rowsWhereCondition: SQL | undefined;
  whereCondition: SQL | undefined;
  severityRankSql: SQL;
}) {
  return loadWithTimeout(
    Promise.all([
      fetchWelfareMetrics(args.actor, args.filteredJurisdictions, args.userId, args.filters),
      db
        .select()
        .from(welfareReports)
        .where(args.rowsWhereCondition)
        // Deterministic ORDER BY matches the 3-part risk keyset.
        .orderBy(
          sql`${args.severityRankSql} DESC`,
          asc(welfareReports.createdAt),
          asc(welfareReports.id),
        )
        // limit+1 probe row detects hasMore without a second query.
        .limit(PAGE_SIZE + 1),
      // Total count still reflects ALL filtered rows (not just this page),
      // kept for the "(N denuncias)" header.
      db
        .select({ n: count() })
        .from(welfareReports)
        .where(args.whereCondition),
    ]),
  );
}

export async function MaltratoQueueScreen({
  searchParams: sp,
  underHub = false,
}: MaltratoQueueScreenProps) {
  const { profile, jurisdictions, user } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role };

  const activeQueue = parseQueue(sp.queue);
  const activeKind = parseKind(sp.kind);
  const activeSeverity = parseSeverity(sp.severity);
  const activeStatus = parseStatus(sp.status);

  const noScope = profile.role === "govt" && jurisdictions.length === 0;

  // THE FENCE + switcher inputs, resolved once. filteredJurisdictions carries the
  // govt scope (assignments ∩ URL selection); adminSelectedProvince/Locality are
  // the admin-only SQL-drill names (null for govt — govt scope is already enforced
  // by filteredJurisdictions, so passing them for govt would be a widening vector).
  const {
    filteredJurisdictions,
    localities,
    allowedProvinces,
    adminSelectedProvince,
    adminSelectedLocality,
  } = await resolveJurisdictionScope({
    role: profile.role,
    jurisdictions,
    params: { province: sp.province, locality: sp.locality },
  });

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince: adminSelectedProvince ?? undefined,
    adminLocality: adminSelectedLocality ?? undefined,
  });

  const whereCondition = buildMaltratoListConditions({
    actor,
    filteredJurisdictions,
    queue: activeQueue,
    kind: activeKind,
    severity: activeSeverity,
    status: activeStatus,
    selectedProvince: adminSelectedProvince,
    selectedLocality: adminSelectedLocality,
    currentUserId: user.id,
  });

  // Build a ctx for the freshness footer (jurisdiction-scoped, trailing 30d window).
  const freshnessCtx = buildProjectionContext(actor, filteredJurisdictions, windows.trailing30d());

  // Default order = RISK + SLA, not date (UI/UX audit 2026-07): severity DESC
  // first (critical → low), then AGE DESC within a tier (oldest first — age is
  // the SLA pressure), id ASC as the deterministic tiebreak. The rank values
  // and the SLA tiers live in ./_lib/welfare-sla.ts so the ORDER BY, the row
  // badge and the cursor can never disagree.
  const severityRankSql = sql<number>`(CASE ${welfareReports.severity}
    WHEN 'critical' THEN 3
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 1
    WHEN 'low' THEN 0
    ELSE -1 END)`;

  // Keyset (seek) pagination — perf/scale review 2026-07-04 P1 posture kept
  // (no OFFSET), but on the risk ordering's 3-part key: (rank DESC,
  // createdAt ASC, id ASC). The shared (ts,id) cursor of
  // lib/utils/keyset-pagination.ts encodes a plain createdAt-DESC contract, so
  // this page carries its own rank|ts|id cursor (./_lib/welfare-sla.ts); a
  // legacy 2-part cursor decodes to null → page 1.
  const riskCursor = decodeRiskCursor(sp.cursor);
  const cursorClause = riskCursor
    ? sql`(${severityRankSql} < ${riskCursor.rank}
        OR (${severityRankSql} = ${riskCursor.rank}
          AND (${welfareReports.createdAt} > ${riskCursor.ts}::timestamptz
            OR (${welfareReports.createdAt} = ${riskCursor.ts}::timestamptz
              AND ${welfareReports.id} > ${riskCursor.id}::uuid))))`
    : undefined;
  const rowsWhereCondition = cursorClause ? and(whereCondition, cursorClause) : whereCondition;

  // Header, no-scope warning and filter bar render in BOTH the data and the
  // degraded branch (same shape as app/gob/censo/CensoScreen.tsx). None of them
  // depends on loadTriageData: the bar is built from allowedProvinces/
  // localities, already resolved above. This is the surface an operator
  // actually works in, so a bare fallback left them with no way to narrow the
  // query that timed out — and "Reintentar" re-issues the identical one.
  //
  // `actions` is a parameter because the CSV link is the one part that DOES
  // depend on the fetched rows; the degraded branch renders the bar without it
  // rather than offering an export of nothing.
  const shell = (actions?: ReactNode) => (
    <>
      {/* Page header */}
      <ScreenHeader
        underHub={underHub}
        title="Denuncias de maltrato"
        subtitle={
          <>
            <p className="text-md text-ln-op-mute">
              Cola de triage bajo Ley Nacional 14.346.{" "}
              {/* The universal claim yields to the narrowed-view caption (never both). */}
              {hasNationalReadScope(profile.role)
                ? narrowedView
                  ? null
                  : "Vista universal — todas las jurisdicciones."
                : "Filtradas por tu jurisdicción."}
            </p>
            <ViewScopeCaption scope={narrowedView} />
          </>
        }
      />

      {/* No-scope warning */}
      {noScope && (
        <div className="rounded-[var(--radius-md)] border border-ln-op-warn-bd border-l-[4px] border-l-ln-op-warn bg-ln-op-warn-bg px-4 py-3 text-sm text-ln-op-warn">
          Tu cuenta no tiene localidades asignadas. Pedí a un administrador que te asigne al menos
          una.
        </div>
      )}

      {/* Unified filter bar — jurisdiction + kind/severity/status axes +
          active-filter chips. Period is OMITTED: /gob/maltrato is a
          period-agnostic live triage queue (PO decision 2026-07) — the
          period param drove nothing downstream, so the control is dropped
          rather than left as a dead affordance. The kind/severity/status
          axes were always wired (buildMaltratoListConditions applies them)
          but had no visible control. A filter change drops the keyset
          `cursor` (page 1). The queue TABS are a separate concept (workflow
          lens) and keep their own control below. */}
      <OpFilterBar
        showPeriod={false}
        jurisdiction={{ allowedProvinces, localities }}
        resetParamsOnChange={["cursor"]}
        savedViewsKey="op-saved-views:maltrato:v1"
        actions={actions}
        axes={
          [
            {
              id: "kind",
              label: "Tipo",
              paramKey: "kind",
              options: KIND_OPTIONS,
              current: activeKind,
              allLabel: "Todos",
            },
            {
              id: "severity",
              label: "Severidad",
              paramKey: "severity",
              options: SEVERITY_OPTIONS,
              current: activeSeverity,
              allLabel: "Todas",
            },
            {
              id: "status",
              label: "Estado",
              paramKey: "status",
              options: STATUS_OPTIONS,
              current: activeStatus,
              allLabel: "Todos",
            },
          ] satisfies OpFilterAxis[]
        }
      />
    </>
  );

  // Fetch metrics and paginated report list in parallel. The KPI tiles mirror
  // the SAME domain filters (kind/severity/status + scope) the list applies
  // via buildMaltratoListConditions — never the `queue` workflow lens — so a
  // filtered list and its "totals" tiles always agree (filter-honesty fix
  // 2026-07).
  // BOUNDED — see loadTriageData below.
  const load = await loadTriageData({
    actor,
    filteredJurisdictions,
    userId: user.id,
    filters: {
      kind: activeKind,
      severity: activeSeverity,
      status: activeStatus,
      selectedProvince: adminSelectedProvince,
      selectedLocality: adminSelectedLocality,
    },
    rowsWhereCondition,
    whereCondition,
    severityRankSql,
  });

  if (!load.ok) {
    return (
      <div className="space-y-6">
        {shell()}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/denuncias", { ...sp, etapa: "triage" })}
        />
      </div>
    );
  }
  const [metrics, rawRows, [totalRow]] = load.value;

  const totalCount = totalRow?.n ?? 0;
  const hasMore = rawRows.length > PAGE_SIZE;
  const rows = hasMore ? rawRows.slice(0, PAGE_SIZE) : rawRows;

  // C6c workqueue grammar — batch-resolve assignee display names for THIS
  // page's rows only (never per-row queries). Mirrors the detail page's
  // actorNames pattern (app/gob/maltrato/[id]/page.tsx) at list scale: one
  // extra query, bounded by PAGE_SIZE distinct assignees.
  const assigneeIds = [
    ...new Set(rows.map((r) => r.assignedToUserId).filter((id): id is string => id !== null)),
  ];
  const assigneeNames = await fetchAssigneeNames(assigneeIds);

  // Filter params preserved across cursor links — never includes `cursor`
  // itself, which olderHref/newerHref set/strip. Points at the HUB route
  // (etapa=triage), not the old standalone /gob/maltrato path — this screen
  // is rendered under /gob/denuncias now; hardcoding the old path would just
  // cost every click a needless redirect bounce.
  const filterParams: Record<string, string | undefined> = {
    etapa: "triage",
    queue: sp.queue,
    kind: sp.kind,
    severity: sp.severity,
    status: sp.status,
    province: sp.province,
    locality: sp.locality,
  };
  const olderLink = buildOlderLink(hasMore ? rows.at(-1) : undefined, filterParams);
  const newerLink = sp.cursor ? newerHref("/gob/denuncias", filterParams) : null;

  const queueChips = buildQueueChips(sp, metrics);

  // Q1 (CSV export parity) — export EXACTLY the rendered page: same rows,
  // same label vocabulary the list renders with (kind/severity/status label
  // registries, batch-resolved assignee names). The `#` block declares the
  // active workflow lens and, via csvPageDisclosure, that a keyset page is a
  // page — never a silently-partial "todas".
  const csvColumns = [
    "Referencia",
    "Tipo",
    "Severidad",
    "Estado",
    "Jurisdicción",
    "Creada",
    "Asignada a",
  ];
  const csvRows = rows.map((r) => [
    r.referenceCode,
    welfareReportKindLabel(r.kind),
    welfareReportSeverityLabel(r.severity),
    welfareReportStatusLabel(r.status),
    [r.jurisdictionLocality, r.jurisdictionProvince].filter(Boolean).join(", "),
    formatDateTime(r.createdAt),
    r.assignedToUserId ? (assigneeNames.get(r.assignedToUserId) ?? "un agente") : "Sin asignar",
  ]);
  const csvPageLine = csvPageDisclosure(rows.length, totalCount);
  const csvContextLines = [
    `miMAR · Denuncias de maltrato (Ley 14.346) — cola de trabajo: ${QUEUE_LABELS[activeQueue]}`,
    ...(csvPageLine ? [csvPageLine] : []),
  ];

  return (
    <div className="flex flex-col gap-6 lg:h-full lg:min-h-0">
      {/* Top section — pinned above the master/detail split (full width) */}
      <div className="space-y-6 lg:flex-shrink-0">
        {/* Header, no-scope warning and filter bar — hoisted above the load so
            the degraded branch keeps them (see the `shell` definition). Only
            the CSV action, built from the fetched rows, is added here. */}
        {shell(
          <CsvExportLink
            filename={`denuncias-maltrato-${todayIsoInAr()}`}
            columns={csvColumns}
            rows={csvRows}
            contextLines={csvContextLines}
          />,
        )}

        {/* 4 metric KPI tiles. S5 (copy audit 2026-08-06): 3 of the 4
            descriptors are "now" stocks (isKpiPeriodInvariant), so each tile
            suppresses its OWN "no varía con el período" tag
            (hideOwnPeriodInvariantTag) and the group renders it ONCE below
            instead of repeating it per-card — the ⓘ popover on each tile still
            carries the true per-KPI value for ProvenanceCard. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <OpKpi
            label="Sin asignar"
            value={formatCount(metrics.unassignedCount)}
            tone={metrics.unassignedCount > 0 ? "warn" : "neutral"}
            href="/gob/denuncias?etapa=triage&queue=unassigned"
            info={{
              definition:
                "Denuncias de maltrato sin ningún operador asignado (assignedToId IS NULL). Requieren triage inmediato.",
              formula: "COUNT(welfare_reports WHERE assigned_to_id IS NULL AND status != 'closed')",
            }}
            descriptorId="maltrato_unassigned_count"
            hideOwnPeriodInvariantTag
          />
          <OpKpi
            label="Mías"
            value={formatCount(metrics.myCount)}
            tone="blue"
            href="/gob/denuncias?etapa=triage&queue=mine"
            info={{
              definition: "Denuncias de maltrato asignadas al usuario actual que están en curso.",
              formula:
                "COUNT(welfare_reports WHERE assigned_to_id = current_user AND status = 'in_progress')",
            }}
            descriptorId="maltrato_assigned_to_me_count"
            hideOwnPeriodInvariantTag
          />
          <OpKpi
            // ONE status vocabulary (UI/UX audit 2026-07): the tile label comes
            // from the SAME domain label registry the rows render with
            // (welfareReportStatusLabel), so the stat can never say
            // "En investigación" while the row pill says "En curso" for the
            // same status='in_progress'. Never an inline synonym here.
            label={welfareReportStatusLabel("in_progress")}
            value={formatCount(metrics.inProgressCount)}
            tone="neutral"
            info={{
              definition:
                "Total de denuncias con estado 'in_progress' en la jurisdicción del operador (asignadas a alguien).",
              formula: "COUNT(welfare_reports WHERE status = 'in_progress') scoped",
            }}
            descriptorId="maltrato_in_progress_count"
            hideOwnPeriodInvariantTag
          />
          <OpKpi
            label="Cerradas (30d)"
            value={formatCount(metrics.closedMonth)}
            tone="ok"
            info={{
              definition:
                "Denuncias cerradas (status='closed') en los últimos 30 días en la jurisdicción.",
              formula:
                "COUNT(welfare_reports WHERE status='closed' AND closed_at >= 30d ago) scoped",
            }}
            descriptorId="maltrato_closed_30d_count"
          />
        </div>
        {/* Group-level footnote (S5) — replaces the per-tile tags suppressed
            above. Only rendered when at least one tile in the row actually is
            period-invariant, so this line never appears for a hypothetical
            future 4-flow-metric variant of this row. */}
        <TriagePeriodInvariantFootnote />
      </div>

      {/* Master / detail split — list (~40%) + inspector (~60%). On lg each
          column owns its scroll; below lg they stack and the inspector flips to
          an overlay drawer (InspectorMounter container classes). */}
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
        {/* Master — queue chips + list (own scroll on lg) */}
        <div className="flex min-w-0 flex-col lg:w-2/5 lg:min-h-0 lg:overflow-y-auto">
          {/* Queue ≠ status: the chips are a workflow lens (urgentes / sin asignar /
              mías…), NOT the "Estado" filter (that lives in the bar above). */}
          <p className="mb-1.5 text-sm font-semibold uppercase tracking-[0.08em] text-ln-op-mute">
            Cola de trabajo
          </p>
          <QueueFilterChips
            items={queueChips}
            activeValue={activeQueue}
            ariaLabel="Cola de denuncias"
          />
          <OpCard className="mt-4">
            {/* "(N en total)" — not a bare "(N)" (UI/UX audit 2026-07,
                number coherence): under "Todas" this count includes
                TERMINAL rows (cerrada/duplicada/sin sustento), so a bare
                number read as if it were the dashboard's "denuncias
                activas" figure (which counts non-terminal only) and the
                two "disagreed". The count must keep matching the list it
                heads (which legitimately shows closed rows), so we label
                it with the SAME "en total" vocabulary the pagination
                footer inside this card already uses, instead of
                narrowing it to active-only and desyncing it from the
                rows below. */}
            <OpCardHead title={`Denuncias (${totalCount} en total)`} />
            <OpCardBody>
              {rows.length === 0 ? (
                <LnEmptyState
                  icon="denuncia"
                  title="Sin denuncias"
                  description="No hay denuncias que coincidan con los filtros seleccionados."
                />
              ) : (
                <ul className="space-y-2">
                  {rows.map((r) => (
                    <WelfareDenunciaRow
                      key={r.id}
                      report={r}
                      assignedToName={
                        r.assignedToUserId ? (assigneeNames.get(r.assignedToUserId) ?? null) : null
                      }
                      currentUserId={user.id}
                    />
                  ))}
                </ul>
              )}
              <QueuePaginationNav
                totalCount={totalCount}
                newerLink={newerLink}
                olderLink={olderLink}
              />
            </OpCardBody>
          </OpCard>

          <div className="mt-4">
            <DashboardFreshnessFooter ctx={freshnessCtx} />
          </div>
        </div>

        {/* Detail — the inspector reacts to ?caso= / &mascota= (shallow history) */}
        <div className="lg:w-3/5 lg:min-h-0 lg:overflow-y-auto">
          <Suspense>
            <InspectorMounter />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
