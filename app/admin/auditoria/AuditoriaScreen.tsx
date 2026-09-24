// AuditoriaScreen — the "Cambios sensibles" vista of the Auditoría hub.
//
// Audit-trail fusion (structural convergence 2026-08-02): this is the
// byte-relocated body of the former single-purpose /admin/auditoria page
// (its AuditoriaBody), now rendered under the hub's default tab. The hub
// page (./page.tsx) keeps the streamed-shell contract (sync default export +
// Suspense skeleton, platform-budget T3.3); this screen keeps the bounded
// fetch group. The ONLY relocation changes are (a) searchParams arrive
// already awaited, (b) the ScreenHeader renders under the hub (underHub),
// and (c) the load-failure retry href preserves the hub's `vista` param.
//
// Original page contract (T3.3): the whole fetch group (entries + the
// now-parallel profiles lookups, see _lib/load-audit-data.ts) is bounded
// with loadWithTimeout(8 s) — on expiry the operator gets an honest
// AnalyticsLoadFallback with a retry link that preserves the active filters,
// never a ~20 s blank hang.

import Link from "next/link";

import {
  DateRangeFilterFields,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpPill,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { auditActionLabel } from "@/lib/ui/audit-action-labels";
import {
  buildAuditActionOptions,
  parseAuditActions,
  parseAuditDateRange,
} from "@/lib/ui/audit-filters";
import { groupConsecutiveAuditRows } from "@/lib/ui/audit-row-grouping";
import { businessRuleTargetSummary } from "@/lib/ui/audit-target-link";
import { formatDateTime } from "@/lib/utils/format";
import { decodeCursor, newerHref, olderHref } from "@/lib/utils/keyset-pagination";

import { AuditActionFilter } from "./_components/AuditActionFilter";
import { type AuditData, loadAuditData } from "./_lib/load-audit-data";

/** Budget for the audit fetch group (entries + parallel profile lookups). */
const AUDITORIA_LOAD_TIMEOUT_MS = 8_000;

type AuditoriaSearchParams = {
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
  cursor?: string;
  vista?: string;
};

export async function AuditoriaScreen({
  searchParams: sp,
  underHub = false,
}: {
  searchParams: AuditoriaSearchParams;
  underHub?: boolean;
}) {
  await requireAdminOrRedirect();

  // action is a (possibly comma-separated) list of known enum codes, validated
  // against AUDIT_ACTION_LABELS keys before trusting it — never a free-text ILIKE.
  // Multi-action powers the Decisiones 7d KPI drill (approved + rejected).
  const actionFilters = parseAuditActions(sp.action);
  const actorFilter = sp.actor?.trim() || null;
  // Date-range filter (date-only, YYYY-MM-DD). `until` is exclusive (whole `to`
  // day included). Powers the KPI drill's trailing-7d scope.
  const { since, until } = parseAuditDateRange(sp.from, sp.to);
  const fromValid = since ? sp.from : undefined;
  const toValid = until ? sp.to : undefined;
  const rawCursor = sp.cursor;
  const cursor = decodeCursor(rawCursor);

  // Bounded fetch group (T3.3): entries + the parallel profiles lookups race an
  // 8 s deadline. NOTE: the deadline does not cancel the underlying queries —
  // it only bounds how long this request waits (same contract as the analytics
  // dashboards). The retry link keeps every active filter (and the hub vista).
  const load = await loadWithTimeout(
    loadAuditData({ actionFilters, actorFilter, since, until, cursor }),
    AUDITORIA_LOAD_TIMEOUT_MS,
  );

  if (!load.ok) {
    return (
      <div className="space-y-6">
        <ScreenHeader
          underHub={underHub}
          title="Auditoría global"
          subtitle={
            <p className="text-md text-ln-op-ink-2">
              Registro de auditoría (todas las acciones de autoridad).
            </p>
          }
        />
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/admin/auditoria", {
            vista: sp.vista,
            action: sp.action,
            actor: sp.actor,
            from: sp.from,
            to: sp.to,
            cursor: sp.cursor,
          })}
        />
      </div>
    );
  }

  const { entries, hasMore, namesById, targetsById, actorOptions }: AuditData = load.value;

  // Pagination links — changing a filter resets cursor to page 1. The multi-
  // action list is preserved as a comma-joined param so paging past a KPI drill
  // keeps both decision actions in scope. `vista` is absent by design: this
  // screen only renders on the hub's DEFAULT vista, so a dropped param still
  // lands here.
  const filterParams: Record<string, string | undefined> = {
    ...(actionFilters.length > 0 ? { action: actionFilters.join(",") } : {}),
    ...(actorFilter ? { actor: actorFilter } : {}),
    ...(fromValid ? { from: fromValid } : {}),
    ...(toValid ? { to: toValid } : {}),
  };
  const lastEntry = entries.at(-1);
  const olderLink =
    hasMore && lastEntry
      ? olderHref("/admin/auditoria", filterParams, {
          ts: lastEntry.performedAt,
          id: lastEntry.id,
        })
      : null;
  const newerLink = rawCursor ? newerHref("/admin/auditoria", filterParams) : null;

  // Known action codes+labels for the dropdown, deduped by visible label so
  // aliased codes (old/new revocation codes, etc.) render one row each.
  const actionOptions = buildAuditActionOptions();
  // A single-code filter may belong to an aliased option (its `value` carries
  // every code sharing that label, comma-joined) — match by membership, not
  // equality, so the <select> still preselects the right row.
  const selectedActionOption =
    actionFilters.length === 1
      ? actionOptions.find((o) => o.value.split(",").includes(actionFilters[0]))
      : undefined;

  const hasFilters =
    actionFilters.length > 0 || actorFilter !== null || since !== null || until !== null;
  // The action <select> is single-select; when a KPI drill applies more than
  // one action (approved + rejected) it can't be represented there, so surface
  // the active action filter as a readable chip instead.
  const multiActionLabels =
    actionFilters.length > 1 ? actionFilters.map((a) => auditActionLabel(a)) : null;

  // Collapse consecutive runs of the same action+actor (e.g. a ~150-row bulk
  // override backfill) into one expandable group so real events stay scannable.
  const groups = groupConsecutiveAuditRows(entries);

  const actorName = (uid: string | null) =>
    uid ? (namesById.get(uid) ?? "Desconocido") : "Usuario eliminado";

  const fmtTime = (d: Date) => formatDateTime(d);

  // Link a collapsed run to the filtered view (same action + actor). action is
  // always a valid enum code; actor is omitted when the actor was hard-deleted.
  const runFilterHref = (action: string, uid: string | null) => {
    const params = new URLSearchParams({ action });
    if (uid) params.set("actor", uid);
    return `/admin/auditoria?${params.toString()}`;
  };

  // Shared row body — the label line + actor/target detail + timestamp. Reused
  // for standalone rows and for the expanded children of a collapsed run.
  const EntryBody = ({ entry }: { entry: (typeof entries)[number] }) => (
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
          {entry.approvalRequestId && (
            <>
              {" "}
              {"·"} req:{" "}
              <span className="font-ln-mono">{entry.approvalRequestId.slice(0, 8)}&#x2026;</span>
            </>
          )}
          {(() => {
            const target = businessRuleTargetSummary(entry.action, entry.payload);
            return target ? (
              <>
                {" "}
                {"·"} sobre: <span className="font-ln-mono">{target}</span>
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

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        title="Auditoría global"
        subtitle={
          <p className="text-md text-ln-op-ink-2">
            {hasFilters
              ? `${entries.length} ${entries.length === 1 ? "entrada" : "entradas"} del registro de auditoría que coinciden con los filtros.`
              : `Últimas ${entries.length} entradas del registro de auditoría (todas las acciones de autoridad).`}
          </p>
        }
      />

      {/* Unified filter bar — Actor as a registered axis (its no-param default
          is genuinely "todos los actores", so it gets OpFilterBar's own
          chip + "Limpiar todo" for free). Acción and Desde/Hasta stay
          `children`:
            - Acción (AuditActionFilter) — not a default-value trap (its
              default is genuinely "all" too), but a multi-action KPI drill
              (Decisiones 7d) renders as a locked chip that a single-select
              axis can't represent.
            - Desde/Hasta (DateRangeFilterFields) — no default bound
              (genuinely unbounded); commits on change like any axis (no
              "Aplicar" — see DateRangeFilterFields for how a masked dd/mm/aaaa
              field commits safely without a submit button).
          Because neither is a registered axis, OpFilterBar's "Limpiar todo"
          can't reach them — the "Limpiar filtros" link below is kept
          (identical href/behavior to the pre-migration <form>) as the
          full-reset fallback. A filter change drops the keyset `cursor`
          (page 1). */}
      <OpFilterBar
        showPeriod={false}
        resetParamsOnChange={["cursor"]}
        axes={
          [
            {
              id: "actor",
              label: "Actor",
              paramKey: "actor",
              options: actorOptions.map((o) => ({ value: o.id, label: o.name })),
              current: actorFilter,
              allLabel: "Todos los actores",
            },
          ] satisfies OpFilterAxis[]
        }
      >
        <AuditActionFilter
          actionOptions={actionOptions}
          selectedValue={selectedActionOption?.value ?? ""}
          multiActionLabels={multiActionLabels}
          resetParamsOnChange={["cursor"]}
        />
        <DateRangeFilterFields
          fromValue={fromValid}
          toValue={toValid}
          resetParamsOnChange={["cursor"]}
        />
        {hasFilters && (
          <a
            href="/admin/auditoria"
            className="self-center text-sm text-ln-op-mute underline underline-offset-4"
          >
            Limpiar filtros
          </a>
        )}
      </OpFilterBar>

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

      {/* Pagination footer */}
      {(newerLink || olderLink) && (
        <nav
          aria-label="Paginación de auditoría"
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
