// /gob/historial — jurisdiction-scoped audit trail (Wave C, gob-audit-inventory).
//
// BEFORE: self-scoped only ("Mi actividad" — actorUserId = viewer). Could not
// answer "who did what in MY jurisdiction", even though audit_log already
// carries ~90 action types across the whole platform.
//
// AFTER: govt operators see every audit row whose actor shares an ACTIVE
// govt_assignment with them (peer accountability within the same territory —
// audit_log has no jurisdiction column of its own, see
// lib/infra/govt-audit-scope.ts for why the scope is actor-derived, not
// stored). Admins keep universal scope (parity with /admin/auditoria).
// "Mi actividad" survives as an actor-filter preset, not a separate mode.
//
// Filters (all via URL params so links/bookmarks are shareable):
//   action        — one or more AuditLogAction codes, comma-separated
//                   (dropdown of known labels; an aliased label selects
//                   every code it groups)
//   actor         — exact user id, constrained to the jurisdiction scope by
//                   the SQL AND (a stale/foreign id in the URL just yields
//                   zero rows — never a scope bypass)
//   period/from/to — the shared <PeriodPicker> date-range control (same
//                   param names + resolveAnalyticsPeriod resolver every
//                   other /gob dashboard uses — see
//                   lib/analytics/analytics-period.ts). Absent `period` and
//                   `from` defaults to trailing 12 months
//                   (DEFAULT_DASHBOARD_PRESET), matching the chip
//                   PeriodPicker highlights on first load (C32 convention) —
//                   this REPLACES the screen's former unbounded-by-default,
//                   AR-midnight-anchored bespoke parser (see git history);
//                   resolveAnalyticsPeriod's custom-range parsing anchors on
//                   UTC midnight, not AR midnight, same as every sibling.
//   cursor        — keyset pagination (performed_at, id), same helper as
//                   /admin/*
//
// PII note: pii_queried rows carry a free-text `query` field (whatever the
// operator searched — may itself be a citizen's name/DNI). Now that the view
// spans multiple operators in the same jurisdiction, that free-text detail is
// shown ONLY for the viewer's own rows; peer rows show action + result count
// but not the raw query string (accountability without leaking what a
// colleague searched for).

import { desc, inArray } from "drizzle-orm";
import Link from "next/link";

import {
  AuditMineToggle,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpPill,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { approvalRequests, auditLog, db, profiles } from "@/db";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import {
  type AuditHistoryScope,
  buildAuditHistoryWhere,
  resolveAuditHistoryActorOptions,
} from "@/lib/infra/audit-history-query";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { fetchJurisdictionActorIds } from "@/lib/infra/govt-audit-scope";
import { windows } from "@/lib/metrics";
import { DEFAULT_DASHBOARD_PRESET } from "@/lib/metrics/period-presets";
import { auditActionLabel } from "@/lib/ui/audit-action-labels";
import { buildAuditActionOptions, parseAuditActions } from "@/lib/ui/audit-filters";
import { groupConsecutiveAuditRows } from "@/lib/ui/audit-row-grouping";
import { buildTargetLinkInfo, businessRuleTargetSummary } from "@/lib/ui/audit-target-link";
import { formatDateTimeNumericAr, pluralizeEs } from "@/lib/utils/format";
import { decodeCursor, newerHref, olderHref } from "@/lib/utils/keyset-pagination";
import { trimmedSearchParam } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";

const GOB_HISTORIAL_PAGE_LIMIT = 100;

type GobHistorialQuery = {
  isAdmin: boolean;
  jurisdictions: Awaited<ReturnType<typeof requireGobReadAccessOrRedirect>>["jurisdictions"];
  actionFilters: ReturnType<typeof parseAuditActions>;
  actorFilter: string | null;
  fromDate: Date;
  toDate: Date;
  sp: { period?: string; from?: string; to?: string; cursor?: string };
};

// Every DB read this screen makes, in one function, so the page can race the
// whole group against ONE deadline (T1-L6). Before, these five awaits ran bare
// in the component body: a degraded pooler kept the skeleton up forever and
// took the filter bar down with it.
async function loadGobHistorial({
  isAdmin,
  jurisdictions,
  actionFilters,
  actorFilter,
  fromDate,
  toDate,
  sp,
}: GobHistorialQuery) {
  const rawCursor = sp.cursor;
  const cursor = decodeCursor(rawCursor);

  // Jurisdiction scope (govt only — admin keeps universal scope, same as
  // /admin/auditoria). Shared with admin/historial via lib/infra/audit-history-query
  // (#26 D1) — the scope predicate is the ONLY difference between the two
  // pages' queries; both call the same WHERE-clause builder.
  const scope: AuditHistoryScope = isAdmin
    ? { kind: "admin" }
    : { kind: "govt", actorIds: await fetchJurisdictionActorIds(jurisdictions) };

  const whereClause = buildAuditHistoryWhere(scope, {
    actionFilters,
    actorFilter,
    fromDate,
    toDate,
    cursor,
  });

  const rawEntries = await db
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      approvalRequestId: auditLog.approvalRequestId,
      targetUserId: auditLog.targetUserId,
      performedAt: auditLog.performedAt,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(whereClause)
    .orderBy(desc(auditLog.performedAt), desc(auditLog.id))
    .limit(GOB_HISTORIAL_PAGE_LIMIT + 1);

  const hasMore = rawEntries.length > GOB_HISTORIAL_PAGE_LIMIT;
  const entries = hasMore ? rawEntries.slice(0, GOB_HISTORIAL_PAGE_LIMIT) : rawEntries;

  // Pagination links — changing a filter resets cursor to page 1.
  const filterParams: Record<string, string | undefined> = {
    ...(actionFilters.length > 0 ? { action: actionFilters.join(",") } : {}),
    ...(actorFilter ? { actor: actorFilter } : {}),
    ...(sp.period ? { period: sp.period } : {}),
    ...(sp.from ? { from: sp.from } : {}),
    ...(sp.to ? { to: sp.to } : {}),
  };
  const lastEntry = entries.at(-1);
  const olderLink =
    hasMore && lastEntry
      ? olderHref("/gob/historial", filterParams, { ts: lastEntry.performedAt, id: lastEntry.id })
      : null;
  const newerLink = rawCursor ? newerHref("/gob/historial", filterParams) : null;

  // Batch-resolve approval request tokens (P2 audit action labels).
  const reqIds = entries.map((e) => e.approvalRequestId).filter((id): id is string => id !== null);
  const tokenByReqId = new Map<string, string>();
  if (reqIds.length > 0) {
    const reqRows = await db
      .select({ id: approvalRequests.id, publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(inArray(approvalRequests.id, reqIds));
    for (const r of reqRows) tokenByReqId.set(r.id, r.publicToken);
  }

  // Batch-resolve actor display names.
  const actorIds = Array.from(
    new Set(entries.map((e) => e.actorUserId).filter((id): id is string => id !== null)),
  );
  const namesById = new Map<string, string>();
  if (actorIds.length > 0) {
    const rows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, actorIds));
    for (const r of rows) namesById.set(r.id, r.displayName);
  }

  // Batch-resolve target display names + link hrefs (C12 pattern).
  const targetIds = Array.from(
    new Set(entries.map((e) => e.targetUserId).filter((id): id is string => id !== null)),
  );
  const targetsById = new Map<string, { displayName: string; href: string | null }>();
  if (targetIds.length > 0) {
    const targetRows = await db
      .select({ id: profiles.id, displayName: profiles.displayName, role: profiles.role })
      .from(profiles)
      .where(inArray(profiles.id, targetIds));
    for (const r of targetRows) {
      const info = buildTargetLinkInfo({ id: r.id, displayName: r.displayName, role: r.role });
      targetsById.set(r.id, { displayName: info.displayName, href: info.href });
    }
  }

  // Actor dropdown options — shared with admin/historial via
  // resolveAuditHistoryActorOptions (#26 D1): govt lists every actor in
  // scope (bounded), admin derives from the current page + selected extra
  // (universal scope is unbounded — mirrors /admin/auditoria's approach).
  const actorOptions = await resolveAuditHistoryActorOptions(
    scope,
    actorIds,
    namesById,
    actorFilter,
  );

  return {
    entries,
    olderLink,
    newerLink,
    tokenByReqId,
    namesById,
    targetsById,
    actorOptions,
  };
}

type ActorOption = { value: string; label: string };

export default async function GobHistorialPage({
  searchParams,
}: {
  searchParams: Promise<{
    actor?: string;
    action?: string;
    period?: string;
    from?: string;
    to?: string;
    cursor?: string;
  }>;
}) {
  const { user, profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  // Universal READ scope (admin | national): the audit history's "admin" scope
  // kind means "every operator's actions", the "govt" kind means "the actors of
  // my mandate" — a scope question, so the read-only national role takes the
  // universal branch.
  const isAdmin = hasNationalReadScope(profile.role);

  const sp = await searchParams;
  // A single dropdown selection may carry more than one code when it lands on
  // an aliased option (buildAuditActionOptions groups codes that share a
  // label), so this parses a comma-separated list — same contract as
  // /admin/auditoria.
  const actionFilters = parseAuditActions(sp.action);
  // Q1: a repeated ?actor= hands Next a string[] — raw `.trim()` on that
  // throws (500).
  const actorFilter = trimmedSearchParam(sp.actor) ?? null;
  // Same conditional shape as /gob/vigilancia and /admin/programa: only ask
  // the resolver to parse when the picker actually set something, otherwise
  // fall back to the named trailing-12m window that DEFAULT_DASHBOARD_PRESET
  // (below) visually highlights — keeps the chip and the query in sync on a
  // bare first load.
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing12m();
  const fromDate = period.since;
  const toDate = period.until;

  // Deduped by visible label so aliased codes render one dropdown row each.
  const actionOptions = buildAuditActionOptions();
  // A single-code filter may belong to an aliased option (its `value` carries
  // every code sharing that label, comma-joined) — match by membership, not
  // equality, so the <select> still preselects the right row.
  const selectedActionOption =
    actionFilters.length === 1
      ? actionOptions.find((o) => o.value.split(",").includes(actionFilters[0]))
      : undefined;

  const isMineFilter = actorFilter === user.id;

  const scopeCopy = isAdmin
    ? "Vista universal — todas las jurisdicciones."
    : "Acciones de los operadores de gobierno asignados a tu jurisdicción.";

  const header = (
    <ScreenHeader
      className="space-y-2"
      eyebrow="Historial"
      title="Historial de auditoría"
      subtitle={<p className="text-md text-ln-op-mute">{scopeCopy}</p>}
    />
  );

  // Unified filter bar — Período (shared PeriodPicker, same param names and
  // default preset as before) + Acción/Actor as registered axes (both
  // no-param defaults are genuinely "todas/todos" — no blank-option trap).
  // "Ver solo mi actividad" is a TOGGLE (AuditMineToggle) in `children`, not
  // an axis: it defaults OFF ("todos los actores", the same default the Actor
  // axis already has) and just writes the SAME `actor` param the axis does —
  // mirrors the pre-migration page's two affordances (dropdown + quick link)
  // over one param (F-migration 2026-07-21, off the bespoke <form> +
  // hand-rolled Período row). A filter change drops the keyset `cursor` (page
  // 1); "Limpiar todo" covers period+action+actor in one click.
  //
  // Hoisted so the degraded branch keeps it: only the Actor axis's options
  // come from the database.
  const filterBar = (actorAxisOptions: ActorOption[]) => (
    <OpFilterBar
      period={{ defaultPreset: DEFAULT_DASHBOARD_PRESET }}
      resetParamsOnChange={["cursor"]}
      axes={
        [
          {
            id: "action",
            label: "Acción",
            paramKey: "action",
            options: actionOptions,
            current: selectedActionOption?.value ?? null,
            allLabel: "Todas las acciones",
          },
          {
            id: "actor",
            label: "Actor",
            paramKey: "actor",
            options: actorAxisOptions,
            current: actorFilter,
            allLabel: "Todos los actores",
          },
        ] satisfies OpFilterAxis[]
      }
    >
      <AuditMineToggle userId={user.id} isMine={isMineFilter} resetParamsOnChange={["cursor"]} />
    </OpFilterBar>
  );

  const load = await loadWithTimeout(
    loadGobHistorial({ isAdmin, jurisdictions, actionFilters, actorFilter, fromDate, toDate, sp }),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        {filterBar(
          // The actor names come from the load that just failed. Keep the
          // current selection selectable so the bar still reads back what is
          // applied, without inventing a name for it.
          actorFilter ? [{ value: actorFilter, label: "Actor seleccionado" }] : [],
        )}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/historial", sp)}
        />
      </div>
    );
  }
  const { entries, olderLink, newerLink, tokenByReqId, namesById, targetsById, actorOptions } =
    load.value;

  const groups = groupConsecutiveAuditRows(entries);

  const actorName = (uid: string | null) =>
    uid ? (namesById.get(uid) ?? "Desconocido") : "Usuario eliminado";

  const fmtTime = (d: Date) => formatDateTimeNumericAr(d);

  const runFilterHref = (action: string, uid: string | null) => {
    const params = new URLSearchParams({ action });
    if (uid) params.set("actor", uid);
    return `/gob/historial?${params.toString()}`;
  };

  // Shared row body — reused for standalone rows and expanded run children.
  const EntryBody = ({ entry }: { entry: (typeof entries)[number] }) => {
    const isOwnRow = entry.actorUserId === user.id;
    return (
      <>
        <div className="min-w-0 space-y-0.5">
          <p className="text-md font-medium text-ln-op-ink" title={entry.action}>
            {auditActionLabel(entry.action)}
          </p>
          <p className="text-sm text-ln-op-mute">
            {actorName(entry.actorUserId)}
            {entry.targetUserId &&
              (() => {
                const target = targetsById.get(entry.targetUserId);
                const targetName = target?.displayName ?? "Usuario eliminado";
                const targetHref = target?.href ?? null;
                return (
                  <>
                    {" "}
                    {"·"} sobre:{" "}
                    {targetHref ? (
                      <Link
                        href={targetHref}
                        className="underline underline-offset-2 hover:text-ln-op-ink"
                      >
                        {targetName}
                      </Link>
                    ) : (
                      <span>{targetName}</span>
                    )}
                  </>
                );
              })()}
            {entry.approvalRequestId &&
              (() => {
                const token = tokenByReqId.get(entry.approvalRequestId);
                return token ? (
                  <>
                    {" "}
                    {"·"}{" "}
                    <Link
                      href={`/gob/cola/${token}`}
                      className="underline underline-offset-2 hover:text-ln-op-ink"
                    >
                      Ver solicitud →
                    </Link>
                  </>
                ) : (
                  <>
                    {" "}
                    {"·"} req:{" "}
                    <span className="font-ln-mono">{entry.approvalRequestId.slice(0, 8)}…</span>
                  </>
                );
              })()}
            {(() => {
              const target = businessRuleTargetSummary(entry.action, entry.payload);
              return target ? (
                <>
                  {" "}
                  {"·"} sobre: <span className="font-ln-mono">{target}</span>
                </>
              ) : null;
            })()}
            {/* PII guard: the free-text search query is only shown for the
                viewer's OWN pii_queried rows — never for peer operators'
                rows, even within the same jurisdiction (see file header). */}
            {entry.action === "pii_queried" &&
              entry.payload != null &&
              typeof entry.payload === "object" &&
              (() => {
                const p = entry.payload as Record<string, unknown>;
                const surface = typeof p.surface === "string" ? p.surface : null;
                const count = typeof p.result_count === "number" ? p.result_count : null;
                const query = isOwnRow && typeof p.query === "string" ? p.query : null;
                const parts: string[] = [];
                if (query) parts.push(`"${query}"`);
                if (surface) parts.push(surface);
                if (count !== null) parts.push(`${count} ${pluralizeEs(count, "resultado")}`);
                return parts.length > 0 ? (
                  <>
                    {" "}
                    {"·"} {parts.join(" · ")}
                  </>
                ) : null;
              })()}
          </p>
        </div>
        <time className="whitespace-nowrap text-sm text-ln-op-mute">
          {fmtTime(entry.performedAt)}
        </time>
      </>
    );
  };

  return (
    <div className="space-y-6">
      {header}

      {filterBar(actorOptions.map((o) => ({ value: o.id, label: o.name })))}

      {entries.length === 0 ? (
        <p className="text-md text-ln-op-mute">No hay entradas que coincidan.</p>
      ) : (
        <OpCard>
          <OpCardHead
            title="Registro de auditoría"
            actions={<span className="text-sm text-ln-op-mute">{entries.length} entradas</span>}
          />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {groups.map((group) =>
                group.kind === "single" ? (
                  <li
                    key={group.row.id}
                    className="flex items-start justify-between gap-3 px-4 py-2.5 odd:bg-ln-op-stripe"
                  >
                    <EntryBody entry={group.row} />
                  </li>
                ) : (
                  <li key={group.key} className="px-4 py-2 odd:bg-ln-op-stripe">
                    <details className="group/run">
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 select-none">
                        <div className="min-w-0 space-y-0.5">
                          <p className="flex items-center gap-2 text-md font-medium text-ln-op-ink">
                            {auditActionLabel(group.action)}
                            <OpPill tone="neutral">×{group.count}</OpPill>
                          </p>
                          <p className="text-sm text-ln-op-mute">
                            {actorName(group.actorUserId)} {"·"} {group.count} acciones consecutivas{" "}
                            <span className="group-open/run:hidden">{"·"} tocá para expandir</span>{" "}
                            {"·"}{" "}
                            <a
                              href={runFilterHref(group.action, group.actorUserId)}
                              className="underline underline-offset-2 hover:text-ln-op-ink"
                            >
                              ver filtradas
                            </a>
                          </p>
                        </div>
                        <time className="whitespace-nowrap text-sm text-ln-op-mute">
                          {fmtTime(group.earliestAt)} {"–"} {fmtTime(group.latestAt)}
                        </time>
                      </summary>
                      <ul className="mt-2 divide-y divide-ln-op-line-2 border-l-2 border-ln-op-line pl-3">
                        {group.rows.map((entry) => (
                          <li
                            key={entry.id}
                            className="flex items-start justify-between gap-3 py-2"
                          >
                            <EntryBody entry={entry} />
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ),
              )}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {(newerLink || olderLink) && (
        <nav
          aria-label="Paginación de historial"
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
                Ver más antiguos →
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
