// ModeracionQueueScreen — jurisdiction-scoped denuncia moderation queue.
//
// F1 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/moderacion page.tsx, relocated so the Denuncias hub (app/gob/denuncias/
// page.tsx) can render it as its "Moderación" stage under ?etapa=moderacion.
// /gob/moderacion itself now only redirects here via the hub (see
// app/gob/moderacion/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic.
//
// Roadmap/spec: dim-interno:docs/design/handoffs/2026-07-07-govt-jurisdiction-moderation-sdd.md
//
// Shows the flagged anonymous denuncia queue FILTERED to the viewer's assigned
// localities. Mirrors /admin/moderacion but scoped: it reuses the shared
// buildModerationQueueConditions predicate + the welfare jurisdiction scope, so
// there is no forked query. Flagged reports with no/ambiguous jurisdiction never
// match a govt scope pair — they stay admin-only (/admin/moderacion), never
// invisible to everyone.
//
// Gated by requireDenunciaModerationPrincipal ('denuncia.moderate'): admin sees
// the queue universally (empty jurisdictions), govt sees only their assignments.
//
// Filter controls (consistency pass, 2026-07-19): the 3 filters were rendered
// as loose hand-rolled <select>s in their own <form>. Status keeps its real
// (non-"all") default "pending" — a workflow lens, same role as /gob/perdidas'
// status tabs — so it moves to UrlTabs, not an OpFilterBar axis (whose
// null-default "Todas" semantics don't fit a filter whose default is a real
// subset). Kind/severity genuinely default to "no filter" (blank = "Todos"/
// "Todas"), the exact shape OpFilterBar axes were built for (mirrors
// /gob/maltrato's kind/severity axes) — those two move into the bar. Behavior
// preserved: same params, same defaults, same query.

import { Suspense } from "react";

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import {
  CsvExportLink,
  OpCard,
  OpCardBody,
  type OpFilterAxis,
  OpFilterBar,
  OpPill,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db, welfareReports } from "@/db";
import {
  type ModerationQueueStatus,
  buildModerationQueueConditions,
} from "@/lib/analytics/govt-dashboards";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireDenunciaModerationPrincipal } from "@/lib/infra/auth-guards";
import { type FlagReason, reasonLabel } from "@/lib/infra/welfare-moderation";
import { formatDate, formatDateTime, todayIsoInAr } from "@/lib/utils/format";
import { decodeCursor, keysetWhere, newerHref, olderHref } from "@/lib/utils/keyset-pagination";
import {
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SEVERITIES,
  type WelfareReportKind,
  type WelfareReportSeverity,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
} from "@/src/modules/welfare/domain/types";
import { and, desc } from "drizzle-orm";

type SeverityTone = "danger" | "open" | "neutral";

const SEVERITY_PILL: Record<string, SeverityTone> = {
  critical: "danger",
  high: "open",
  medium: "open",
  low: "neutral",
};

const STATUS_TABS: UrlTabItem[] = [
  { value: "pending", label: "Pendientes" },
  { value: "resolved", label: "Resueltas" },
  { value: "all", label: "Todas" },
];

const KIND_OPTIONS = WELFARE_REPORT_KINDS.map((k) => ({
  value: k,
  label: welfareReportKindLabel(k),
}));
const SEVERITY_OPTIONS = WELFARE_REPORT_SEVERITIES.map((s) => ({
  value: s,
  label: welfareReportSeverityLabel(s),
}));

const PAGE_SIZE = 50;

export type ModeracionQueueScreenProps = {
  searchParams: {
    status?: string;
    kind?: string;
    severity?: string;
    cursor?: string;
  };
  /**
   * True when rendered as the Denuncias hub's "Moderación" tab
   * (app/gob/denuncias/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

/**
 * Role-aware subtitle scope (red-team-admin #5c): a national admin sees this
 * shared queue universally, so "de tus localidades" (mandate wording) is wrong
 * for them. Module-level so the branch does not add to the screen's cognitive
 * complexity budget.
 */
function moderationScopePhrase(role: string): string {
  return hasNationalReadScope(role) ? "de todo el país" : "de tus localidades";
}

/**
 * Q1 (CSV export parity) — the CSV projection of the rendered moderation page:
 * exactly the page rows, same label registries the cards render with. This
 * queue counts no filtered total (only a hasMore probe), so the page
 * disclosure is phrased without one instead of inventing a number the query
 * never produced. Module-level so the screen's own cognitive complexity stays
 * under the lint budget (same rationale as moderationScopePhrase above).
 */
function buildModeracionCsv(
  rows: Array<{
    referenceCode: string;
    kind: WelfareReportKind;
    severity: WelfareReportSeverity;
    flagReasons: unknown;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    flaggedAt: Date | null;
    moderationResolvedAt: Date | null;
  }>,
  statusFilter: ModerationQueueStatus,
  hasMore: boolean,
): { columns: string[]; rows: string[][]; contextLines: string[] } {
  return {
    columns: [
      "Referencia",
      "Tipo",
      "Severidad",
      "Motivos de revisión",
      "Jurisdicción",
      "Marcada",
      "Resuelta",
    ],
    rows: rows.map((r) => [
      r.referenceCode,
      welfareReportKindLabel(r.kind),
      welfareReportSeverityLabel(r.severity),
      ((r.flagReasons as string[]) ?? [])
        .map((reason) => reasonLabel(reason as FlagReason))
        .join("; "),
      [r.jurisdictionLocality, r.jurisdictionProvince].filter(Boolean).join(", "),
      r.flaggedAt ? formatDateTime(r.flaggedAt) : "",
      r.moderationResolvedAt ? formatDate(r.moderationResolvedAt) : "",
    ]),
    contextLines: [
      `miMAR · Moderación de denuncias — estado: ${
        STATUS_TABS.find((t) => t.value === statusFilter)?.label ?? statusFilter
      }`,
      ...(hasMore
        ? [
            `# Exportando la página visible: ${rows.length.toLocaleString("es-AR")} ${rows.length === 1 ? "fila" : "filas"} — hay más resultados, paginá para exportar el resto`,
          ]
        : []),
    ],
  };
}

export async function ModeracionQueueScreen({
  searchParams: sp,
  underHub = false,
}: ModeracionQueueScreenProps) {
  const { profile, jurisdictions } = await requireDenunciaModerationPrincipal();
  const actor = { role: profile.role };

  const statusFilter: ModerationQueueStatus =
    sp.status === "resolved" || sp.status === "all" ? sp.status : "pending";
  const kindFilter =
    sp.kind && (WELFARE_REPORT_KINDS as readonly string[]).includes(sp.kind)
      ? (sp.kind as WelfareReportKind)
      : null;
  const severityFilter =
    sp.severity && (WELFARE_REPORT_SEVERITIES as readonly string[]).includes(sp.severity)
      ? (sp.severity as WelfareReportSeverity)
      : null;

  const noScope = profile.role === "govt" && jurisdictions.length === 0;
  const scopePhrase = moderationScopePhrase(profile.role);

  // Shared moderation predicate + jurisdiction scope (govt sees only their
  // localities; admin universal). Returns sql`false` for a govt with no scope.
  const baseWhere = buildModerationQueueConditions({
    actor,
    jurisdictions,
    status: statusFilter,
    kind: kindFilter,
    severity: severityFilter,
    // REGRESSION FIX (prepush-review-3 2026-07-23): /admin/moderacion was THE
    // escalation inbox (includeEscalated: true — see welfare.ts's own header)
    // before the F1 fusion turned it into a redirect to this screen. Without
    // this role-derived flag, escalated-to-admin denuncias became invisible to
    // EVERYONE: govt correctly excludes them, and the admin inbox was gone.
    // Admin viewing this screen keeps the escalation-inbox semantics; govt
    // keeps the pre-escalation view.
    includeEscalated: hasNationalReadScope(profile.role),
  });

  // Keyset (seek) pagination — same contract as /admin/moderacion:
  // DESC on (flaggedAt, id); flaggedAt is non-null by the query predicate.
  const cursorClause = keysetWhere(
    welfareReports.flaggedAt,
    welfareReports.id,
    decodeCursor(sp.cursor),
  );
  const rowsWhere = cursorClause ? and(baseWhere, cursorClause) : baseWhere;

  const rawRows = await db
    .select()
    .from(welfareReports)
    .where(rowsWhere)
    .orderBy(desc(welfareReports.flaggedAt), desc(welfareReports.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = rawRows.length > PAGE_SIZE;
  const rows = hasMore ? rawRows.slice(0, PAGE_SIZE) : rawRows;

  // Pagination links point at the HUB route (etapa=moderacion), not the old
  // standalone /gob/moderacion path — this screen is rendered under
  // /gob/denuncias now; hardcoding the old path would just cost every click
  // a needless redirect bounce (the old route still 308s there, but there is
  // no reason to pay that hop from inside the hub itself).
  const filterParams: Record<string, string | undefined> = {
    etapa: "moderacion",
    ...(statusFilter !== "pending" ? { status: statusFilter } : {}),
    ...(kindFilter ? { kind: kindFilter } : {}),
    ...(severityFilter ? { severity: severityFilter } : {}),
  };
  const lastRow = rows.at(-1);
  const olderLink =
    hasMore && lastRow?.flaggedAt
      ? olderHref("/gob/denuncias", filterParams, { ts: lastRow.flaggedAt, id: lastRow.id })
      : null;
  const newerLink = sp.cursor ? newerHref("/gob/denuncias", filterParams) : null;

  const csv = buildModeracionCsv(rows, statusFilter, hasMore);

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        eyebrow="Moderación"
        title="Moderación de denuncias"
        subtitle={
          <p className="text-md text-ln-op-ink-2">
            Denuncias anónimas {scopePhrase} que las heurísticas marcaron para revisión, antes de
            que entren a la cola de triage. Aprobalas para pasarlas a triage, rechazalas como abuso,
            o escalalas al equipo de plataforma. Las denuncias sin jurisdicción clara las modera el
            equipo de plataforma.
          </p>
        }
      />

      {noScope && (
        <div className="rounded-[var(--radius-md)] border border-ln-op-warn-bd border-l-[4px] border-l-ln-op-warn bg-ln-op-warn-bg px-4 py-3 text-sm text-ln-op-warn">
          Tu cuenta no tiene localidades asignadas. Pedí a un administrador que te asigne al menos
          una para ver las denuncias de tu jurisdicción.
        </div>
      )}

      {/* Domain filters — kind + severity (genuine "no filter" defaults). No
          period/jurisdiction control here: this queue has neither today. */}
      <OpFilterBar
        showPeriod={false}
        resetParamsOnChange={["cursor"]}
        actions={
          <CsvExportLink
            filename={`moderacion-denuncias-${todayIsoInAr()}`}
            columns={csv.columns}
            rows={csv.rows}
            contextLines={csv.contextLines}
          />
        }
        axes={
          [
            {
              id: "kind",
              label: "Tipo de denuncia",
              paramKey: "kind",
              options: KIND_OPTIONS,
              current: kindFilter,
              allLabel: "Todos los tipos",
            },
            {
              id: "severity",
              label: "Severidad",
              paramKey: "severity",
              options: SEVERITY_OPTIONS,
              current: severityFilter,
              allLabel: "Todas las severidades",
            },
          ] satisfies OpFilterAxis[]
        }
      />

      {/* Status — a workflow lens with a real ("pending") default, not a
          "show all" axis, so it stays a tab control (same idiom as /gob/perdidas
          and /gob/servicios). The single content region below always matches
          the current tab (the query is already server-filtered by statusFilter). */}
      <Suspense>
        <UrlTabs
          paramKey="status"
          defaultValue="pending"
          tabs={STATUS_TABS}
          aria-label="Filtrar por estado de moderación"
        >
          <UrlTabsContent value={statusFilter}>
            <div className="mt-4 space-y-6">
              {rows.length === 0 ? (
                // Empty-state consistency (sweep 2026-07-23): page-level empty
                // results render the shared LnEmptyState, not an OpCallout.
                <LnEmptyState
                  title={statusFilter === "pending" ? "Cola vacía" : "Sin resultados"}
                  description={
                    statusFilter === "pending"
                      ? `No hay denuncias pendientes de moderación ${scopePhrase}.`
                      : "No hay denuncias que coincidan con los filtros aplicados."
                  }
                />
              ) : (
                <ul className="space-y-2">
                  {rows.map((r) => {
                    const reasons = (r.flagReasons as string[]) ?? [];
                    const severityTone: SeverityTone = SEVERITY_PILL[r.severity] ?? "neutral";
                    return (
                      <li key={r.id}>
                        <OpCard accent="warn">
                          <Link
                            href={`/gob/moderacion/${r.referenceCode}`}
                            className="block no-underline transition-colors hover:bg-ln-op-stripe"
                          >
                            <OpCardBody>
                              <div className="flex items-baseline justify-between gap-3">
                                <div className="min-w-0 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-md font-semibold text-ln-op-ink">
                                      {welfareReportKindLabel(r.kind)}
                                    </p>
                                    <OpPill tone={severityTone}>
                                      {welfareReportSeverityLabel(r.severity)}
                                    </OpPill>
                                  </div>
                                  <ul className="space-y-0.5">
                                    {reasons.map((reason) => (
                                      <li key={reason} className="text-sm text-ln-op-warn">
                                        {"• "}
                                        {reasonLabel(reason as FlagReason)}
                                      </li>
                                    ))}
                                  </ul>
                                  <p className="font-ln-mono text-xs text-ln-op-faint">
                                    {r.referenceCode}
                                    {" · "}
                                    {[r.jurisdictionLocality, r.jurisdictionProvince]
                                      .filter(Boolean)
                                      .join(", ")}
                                    {" · "}
                                    {r.flaggedAt && formatDateTime(r.flaggedAt)}
                                    {r.moderationResolvedAt && (
                                      <span className="ml-2 inline-flex items-center gap-1 text-ln-op-ok">
                                        <Icon name="check" size={13} decorative /> resuelta{" "}
                                        {formatDate(r.moderationResolvedAt)}
                                      </span>
                                    )}
                                  </p>
                                </div>
                                <span className="text-sm font-semibold text-ln-op-azul">{"→"}</span>
                              </div>
                            </OpCardBody>
                          </Link>
                        </OpCard>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Pagination footer — keyset (seek) links preserve active filters. */}
              {(newerLink || olderLink) && (
                <nav
                  aria-label="Paginación de moderación"
                  className="flex items-center justify-between gap-4 border-t border-ln-op-line pt-4"
                >
                  <div>
                    {newerLink && (
                      <Link
                        href={newerLink}
                        className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
                      >
                        ← Más recientes
                      </Link>
                    )}
                  </div>
                  <div>
                    {olderLink && (
                      <Link
                        href={olderLink}
                        className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
                      >
                        Ver más antiguas →
                      </Link>
                    )}
                  </div>
                </nav>
              )}
            </div>
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
