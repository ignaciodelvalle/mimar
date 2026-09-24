// ActividadScreen — the "Actividad" vista of the Auditoría hub.
//
// Audit-trail fusion (structural convergence 2026-08-02): this is the
// byte-relocated body of the former standalone /admin/historial page (see
// ./page.tsx, now a permanent redirect into /admin/auditoria?vista=actividad).
// Both admin surfaces queried the SAME audit_log at the SAME universal admin
// scope — this page's own header comment already said "parity with
// /admin/auditoria" — so the pair collapsed into one tabbed hub. The ONLY
// changes in the relocation are (a) pagination hrefs now target the hub route
// carrying `vista=actividad`, and (b) the ScreenHeader renders under the hub
// (underHub — the hub's h1 + active tab already say "Actividad").
//
// Everything below this paragraph is the original screen, history included:
//
// /admin/historial — admin's audit trail, UNIVERSAL scope (#26 admin↔gob
// drift unification, D1).
//
// BEFORE: hardcoded self-scope only (actorUserId = user.id), cursor-only
// pagination — no action/actor/date filters.
//
// AFTER: ports the SAME action/actor/date filter surface as /gob/historial
// (shared-PeriodPicker-based, see that page's header comment), but with
// admin's UNIVERSAL scope — no jurisdiction/actor restriction at all. Both
// pages share their WHERE-clause assembly and actor-dropdown resolution via
// lib/infra/audit-history-query.ts; the ONLY difference is the scope value
// passed in ({ kind: "admin" } here vs. { kind: "govt", actorIds } there).
// /gob/historial is NOT part of the hub fusion — the govt twin stays
// jurisdiction-scoped, standalone, with its own nav entry.
//
// Scope is wider than the pre-D1 page (previously self-only) — an admin can
// see every actor's actions by default, same as the "Cambios sensibles"
// vista. Row-level presentation intentionally stays SIMPLE (no grouping, no
// PII masking, no target links) — those are the sensibles vista's and
// /gob/historial's features.
//
// Filters (all via URL params so links/bookmarks are shareable):
//   action         — one or more AuditLogAction codes, comma-separated.
//   actor          — exact user id (unrestricted — universal scope).
//   period/from/to — the shared <PeriodPicker> control, same param names +
//                    resolveAnalyticsPeriod resolver as /gob/historial.
//                    Absent `period`/`from` defaults to trailing 12 months.
//   cursor         — keyset pagination (performed_at, id).

import { desc, inArray } from "drizzle-orm";
import Link from "next/link";

import {
  AuditMineToggle,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { approvalRequests, auditLog, db, profiles } from "@/db";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import {
  type AuditHistoryScope,
  buildAuditHistoryWhere,
  resolveAuditHistoryActorOptions,
} from "@/lib/infra/audit-history-query";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { windows } from "@/lib/metrics";
import { DEFAULT_DASHBOARD_PRESET } from "@/lib/metrics/period-presets";
import { auditActionLabel } from "@/lib/ui/audit-action-labels";
import { buildAuditActionOptions, parseAuditActions } from "@/lib/ui/audit-filters";
import { formatDateTimeNumericAr } from "@/lib/utils/format";
import { decodeCursor, newerHref, olderHref } from "@/lib/utils/keyset-pagination";

const ADMIN_HISTORIAL_PAGE_LIMIT = 100;

// Pagination/link base — the hub route this screen renders under. Every href
// this screen emits must carry `vista=actividad` (via filterParams below) so
// paging never silently drops the operator back onto the default vista.
const HUB_BASE = "/admin/auditoria";

type HistorialEntry = {
  id: string;
  actorUserId: string | null;
  action: string;
  performedAt: Date;
  approvalRequestId: string | null;
};

// Extracted so the main screen function's cognitive complexity stays under the
// lint ceiling — same "shared row body" pattern /gob/historial's EntryBody
// uses, minus grouping/PII/target-link logic (D1 scope: filters only).
function HistorialRow({
  entry,
  tokenByReqId,
  actorName,
}: {
  entry: HistorialEntry;
  tokenByReqId: Map<string, string>;
  actorName: (uid: string | null) => string;
}) {
  const token = entry.approvalRequestId ? tokenByReqId.get(entry.approvalRequestId) : undefined;
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-2.5 odd:bg-ln-op-stripe">
      <div className="min-w-0 space-y-0.5">
        <p className="text-md text-ln-op-ink">{auditActionLabel(entry.action)}</p>
        <p className="text-sm text-ln-op-mute">{actorName(entry.actorUserId)}</p>
        {entry.approvalRequestId &&
          (token ? (
            <Link
              href={`/gob/cola/${token}`}
              className="font-ln-mono text-sm text-ln-op-azul underline underline-offset-2 hover:opacity-80"
            >
              Ver solicitud →
            </Link>
          ) : (
            <p className="font-ln-mono text-sm text-ln-op-mute">
              req: {entry.approvalRequestId.slice(0, 8)}…
            </p>
          ))}
      </div>
      <time className="whitespace-nowrap text-sm text-ln-op-mute">
        {formatDateTimeNumericAr(entry.performedAt)}
      </time>
    </li>
  );
}

type ActividadSearchParams = {
  actor?: string;
  action?: string;
  period?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

// Extracted so the screen component's own cognitive complexity stays under the
// lint ceiling — all filter-parsing, querying, and pagination-link logic
// lives here; the component below only renders. Universal admin scope (#26
// D1): shares its WHERE-clause assembly + actor-dropdown resolution with
// /gob/historial via lib/infra/audit-history-query.ts.
async function loadActividad(sp: ActividadSearchParams) {
  const actionFilters = parseAuditActions(sp.action);
  const actorFilter = sp.actor?.trim() || null;
  // Same conditional shape as /gob/historial: only ask the resolver to parse
  // when the picker actually set something, otherwise fall back to the named
  // trailing-12m window DEFAULT_DASHBOARD_PRESET visually highlights.
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing12m();
  const fromDate = period.since;
  const toDate = period.until;
  const rawCursor = sp.cursor;
  const cursor = decodeCursor(rawCursor);

  const scope: AuditHistoryScope = { kind: "admin" };
  const whereClause = buildAuditHistoryWhere(scope, {
    actionFilters,
    actorFilter,
    fromDate,
    toDate,
    cursor,
  });

  // Fetch limit+1 to detect hasMore for keyset pagination (PERF-5).
  const rawEntries = await db
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      performedAt: auditLog.performedAt,
      approvalRequestId: auditLog.approvalRequestId,
    })
    .from(auditLog)
    .where(whereClause)
    .orderBy(desc(auditLog.performedAt), desc(auditLog.id))
    .limit(ADMIN_HISTORIAL_PAGE_LIMIT + 1);

  const hasMore = rawEntries.length > ADMIN_HISTORIAL_PAGE_LIMIT;
  const entries = hasMore ? rawEntries.slice(0, ADMIN_HISTORIAL_PAGE_LIMIT) : rawEntries;

  // Pagination links — changing a filter resets cursor to page 1. `vista` is
  // pinned so paging stays on this tab of the hub.
  const filterParams: Record<string, string | undefined> = {
    vista: "actividad",
    ...(actionFilters.length > 0 ? { action: actionFilters.join(",") } : {}),
    ...(actorFilter ? { actor: actorFilter } : {}),
    ...(sp.period ? { period: sp.period } : {}),
    ...(sp.from ? { from: sp.from } : {}),
    ...(sp.to ? { to: sp.to } : {}),
  };
  const lastEntry = entries.at(-1);
  const olderLink =
    hasMore && lastEntry
      ? olderHref(HUB_BASE, filterParams, { ts: lastEntry.performedAt, id: lastEntry.id })
      : null;
  const newerLink = rawCursor ? newerHref(HUB_BASE, filterParams) : null;

  // Build a lookup from approvalRequestId → publicToken so we can link to the
  // detail page instead of showing raw UUIDs (P2 audit action labels).
  const reqIds = entries.map((e) => e.approvalRequestId).filter((id): id is string => id !== null);
  const tokenByReqId = new Map<string, string>();
  if (reqIds.length > 0) {
    const reqRows = await db
      .select({ id: approvalRequests.id, publicToken: approvalRequests.publicToken })
      .from(approvalRequests)
      .where(inArray(approvalRequests.id, reqIds));
    for (const r of reqRows) tokenByReqId.set(r.id, r.publicToken);
  }

  // Batch-resolve actor display names — scope is universal, so a row's
  // actor is not always the viewer; show who did it.
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

  // Actor dropdown options — shared resolver with /gob/historial (#26 D1):
  // admin derives options from the current page + selected extra (universal
  // scope is unbounded, mirrors the sensibles vista's approach).
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
    actorOptions,
  };
}

type ActorOption = { value: string; label: string };

export async function ActividadScreen({
  searchParams: sp,
  underHub = false,
}: {
  searchParams: ActividadSearchParams;
  underHub?: boolean;
}) {
  const { user } = await requireAdminOrRedirect();

  // Everything the filter bar needs that does NOT come from the database is
  // resolved BEFORE the load, so the degraded branch can keep the bar
  // (lint:degraded-chrome). Only the Actor axis's options are data-derived.
  const actionFilters = parseAuditActions(sp.action);
  const actorFilter = sp.actor?.trim() || null;
  const actionOptions = buildAuditActionOptions();
  const selectedActionOption =
    actionFilters.length === 1
      ? actionOptions.find((o) => o.value.split(",").includes(actionFilters[0]))
      : undefined;
  const isMineFilter = actorFilter === user.id;

  const header = (
    <ScreenHeader
      underHub={underHub}
      title="Historial"
      subtitle={
        <p className="text-md text-ln-op-ink-2">Vista universal admin — todos los actores.</p>
      }
    />
  );

  // Unified filter bar — twin of /gob/historial's (#26 D1 parity): Período
  // + Acción/Actor as registered axes (both no-param defaults are genuinely
  // "todas/todos" — no blank-option trap) + "Ver solo mi actividad" as a
  // children TOGGLE (AuditMineToggle), not an axis — it defaults OFF ("todos
  // los actores", the Actor axis's own default) and writes the SAME `actor`
  // param the axis does (F-migration 2026-07-21, off the bespoke <form> +
  // hand-rolled Período row). A filter change drops the keyset `cursor` (page
  // 1); "Limpiar todo" covers period+action+actor in one click. All filter
  // mutations commit via serverNavCommit, which preserves the hub's `vista`
  // param.
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

  // BOUNDED (T1-L6). The audit_log read plus its three lookups used to be
  // awaited bare, so a degraded pooler left the Actividad tab on its skeleton
  // with no way out. One deadline covers the whole group, as AuditoriaScreen
  // does for the sibling vista.
  const load = await loadWithTimeout(loadActividad(sp));
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        {filterBar(
          // The actor names come from the load that just failed. Keep the
          // operator's current selection selectable so the bar still reads
          // back what is applied, without inventing a name for it.
          actorFilter ? [{ value: actorFilter, label: "Actor seleccionado" }] : [],
        )}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref(HUB_BASE, { ...sp, vista: "actividad" })}
        />
      </div>
    );
  }
  const { entries, olderLink, newerLink, tokenByReqId, namesById, actorOptions } = load.value;
  const actorName = (uid: string | null) =>
    uid ? (namesById.get(uid) ?? "Desconocido") : "Usuario eliminado";

  return (
    <div className="space-y-6">
      {header}

      {filterBar(actorOptions.map((o) => ({ value: o.id, label: o.name })))}

      {entries.length === 0 ? (
        <p className="text-md text-ln-op-mute">No hay entradas que coincidan.</p>
      ) : (
        <OpCard>
          <OpCardHead
            title="Acciones registradas"
            actions={<span className="text-sm text-ln-op-mute">{entries.length} entradas</span>}
          />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {entries.map((entry) => (
                <HistorialRow
                  key={entry.id}
                  entry={entry}
                  tokenByReqId={tokenByReqId}
                  actorName={actorName}
                />
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {/* Pagination footer */}
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
