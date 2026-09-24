"use client";

// CaseQueue — unified queue component for case (expediente) list surfaces.
//
// Props:
//   rows     — pre-fetched list rows (CaseListItem shape from lib/case-queries)
//   filters  — active filter state (kind, status); drives chip highlights
//   bulk     — optional OpBulkBar config (reuses Item 10's bulk pattern)
//
// The queue owns row-selection state (Set<string>) when bulk is supplied.
// Filter navigation is URL-driven (chips are <a> links); the component is
// purely presentational for filtering.
//
// A11y:
//   - table with <caption> + <th scope="col">
//   - checkbox header with aria-label
//   - selection count announced via aria-live (delegated to OpBulkBar)
//   - "N casos" count announced below the filter chips
//
// Responsive (rewritten 2026-09-23 — W3 item 3): BELOW the `sm` breakpoint
// (640px) the table is replaced outright by a stacked card list, not
// collapsed into fewer columns. The column-hiding approach (kind/status
// visible; province/locality hidden under `sm`) still left Código + Tipo +
// Estado + Apertura (with its SLA badge) crammed into one row — on a real
// phone width that row still needed horizontal scroll to reach the "Venció
// hace N días" badge, the one piece of information a funcionario opens this
// queue FOR. The stacked list is the SAME pattern
// app/gob/vigilancia/investigaciones/page.tsx already uses for its queue
// (`<ul><li>` cards, one row's fields stacked vertically instead of packed
// into columns) — reused here rather than invented, so the codebase keeps one
// idiom for "a list that must survive a phone width" instead of two. Both
// views render from the SAME `sortedRows` (and the SAME due-badge helper,
// `rowDueBadge` below) so they can never disagree about order or urgency;
// CSS (`hidden sm:block` / `sm:hidden`) picks one, never both, at any width.

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { CaseStatusBadge } from "@/components/ui/dashboard/CaseStatusBadge";
import { type OpBulkAction, OpBulkBar } from "@/components/ui/dashboard/OpBulkBar";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { OpCodeBadge } from "@/components/ui/dashboard/OpCodeBadge";
import { OpPill } from "@/components/ui/dashboard/OpPill";
import type { CaseStatus, CaseSubjectKind } from "@/db/schema";
import { computeDueInfo, dueDateBadge } from "@/lib/domain/due-state";
import {
  CASE_QUEUE_DEFAULT_SORT,
  CASE_QUEUE_SORTS,
  CASE_QUEUE_SORT_LABELS,
  type CaseQueueSort,
} from "@/lib/ui/case-queue-order";
import { formatDate, pluralizeEs } from "@/lib/utils/format";
import {
  type CaseKind,
  caseKindLabel,
  caseKindSeverityWeight,
} from "@/src/modules/cases/domain/case-kinds";
import { CASE_SLA_WARNING_DAYS, caseSlaDueAt } from "@/src/modules/cases/domain/case-sla";

// ---------------------------------------------------------------------------
// SLA / age helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Open cases pending for longer than this many days are considered SLA-breached.
 * Visual-only: no auto-close occurs. 14 days aligns with the typical org
 * review window for escalated/unresolved cases.
 */
// The SLA deadline rule lives in a PURE module (src/modules/cases/domain/
// case-sla.ts), not here: the RSC server graph (/gob/acciones' worklist-core.ts)
// must import CASE_SLA_WARNING_DAYS too, and a "use client" export becomes a
// throw-on-coerce Proxy there. Re-exported so this component's own consumers and
// tests keep their import path.
export { CASE_SLA_WARNING_DAYS, caseSlaDueAt };

/**
 * Returns the number of whole days elapsed since the case was opened (floored).
 * Accepts a Date so callers from server components pass Date objects directly.
 */
export function ageCaseDays(openedAt: Date): number {
  const diffMs = Date.now() - openedAt.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * The "Venció hace N días" SLA badge for one row, or `null` before breach —
 * same rule the table cell and the stacked card render (2026-09-23): one
 * computation, shared, so the two views can never show a different verdict
 * for the same case.
 */
function rowDueBadge(
  row: Pick<CaseQueueRow, "closedAt" | "openedAt">,
): { tone: ReturnType<typeof dueDateBadge>["tone"]; label: string } | null {
  if (row.closedAt !== null) return null;
  const due = computeDueInfo(caseSlaDueAt(row.openedAt));
  if (due.state !== "overdue") return null;
  return dueDateBadge(due);
}

// ---------------------------------------------------------------------------
// Urgency score (PO interview 2026-07-23, item 6) — age-days × kind-severity
// weight (CASE_KIND_SEVERITY_WEIGHT, src/modules/cases/domain/case-kinds.ts).
// A closed case scores 0 regardless of age — it is resolved, never urgent —
// so it always sinks below every open row under the default sort.
// ---------------------------------------------------------------------------

export function caseUrgencyScore(
  row: Pick<CaseQueueRow, "caseKind" | "openedAt" | "closedAt">,
): number {
  if (row.closedAt !== null) return 0;
  return ageCaseDays(row.openedAt) * caseKindSeverityWeight(row.caseKind);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaseQueueRow {
  id: string;
  publicCode: string;
  caseKind: CaseKind;
  status: CaseStatus;
  /**
   * Optional: only producers backed by the `cases` table set this (case-queries.ts).
   * Rows synthesized from a different table (e.g. DisputasScreen's custody
   * disputes, which always join a pet — petId is NOT NULL there) omit it, since
   * their `primaryPetName` is never null and the fallback never triggers.
   */
  primarySubjectKind?: CaseSubjectKind;
  primaryPetName: string | null;
  primaryPetPublicToken: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedAt: Date;
  closedAt: Date | null;
  /** Optional href for the detail link. Defaults to /casos/[publicCode]. */
  detailHref?: string;
}

export interface CaseQueueFilters {
  kind?: CaseKind | null;
  status?: "open" | "closed" | null;
}

export interface CaseQueueBulkConfig {
  /** Actions passed to OpBulkBar. */
  actions: (selectedIds: Set<string>) => OpBulkAction[];
  /** Called when the selection is cleared. */
  onClear?: () => void;
}

export interface CaseQueueProps {
  rows: CaseQueueRow[];
  filters?: CaseQueueFilters;
  bulk?: CaseQueueBulkConfig;
  /**
   * Base URL for filter chip links.
   * Chips append ?kind=… and ?status=… to this base.
   * Defaults to the current path (empty string).
   */
  filterBase?: string;
  /** Optional caption for the table (defaults to "Cola de casos"). */
  caption?: string;
  /** When true, shows a "Truncated — hay más resultados" note. */
  truncated?: boolean;
  /**
   * The TRUE total behind a capped list (M4). When set and larger than the
   * rendered rows, the count reads "Mostrando los N más recientes de M" instead
   * of a bare "N casos" that hides how many exist. Omit on uncapped lists.
   */
  totalCount?: number;
  /** Empty-state message. */
  emptyMessage?: string;
  /**
   * Optional CTA rendered under `emptyMessage` (a link or button) — e.g.
   * "Limpiar filtros" when the empty result is filter-caused, or a link back
   * to a related screen. Omit for a plain message-only empty state (today's
   * default, still valid for queues where there is genuinely nothing to do —
   * see components/ui/EmptyState.tsx's `action` prop for the sibling
   * pattern used outside table/queue primitives). Added copy audit
   * 2026-08-04 (S8): `emptyMessage`-only primitives had no CTA slot at all,
   * so an empty queue could never invite an action even when one existed.
   * NEVER pair this with a k-anonymity/suppression message — "no data" and
   * "hidden by suppression" are different epistemic states and a cheerful
   * CTA over a suppression notice misrepresents which one this is.
   */
  emptyAction?: ReactNode;
  /**
   * When false, the built-in status filter chips (Todos / Abiertos / Cerrados)
   * are not rendered. Use this on surfaces that own a richer external filter
   * form (e.g. /admin/casos, which filters status alongside kind + province)
   * to avoid a duplicate status control. Defaults to true.
   */
  showStatusChips?: boolean;
  /**
   * Extra query params ALWAYS carried on every chip link, on top of kind/
   * status (F6, 2026-07-22). Needed when `filterBase` points at a TABBED HUB
   * route rather than a dedicated page — e.g. the Casos hub's "Disputas"
   * expediente (filterBase="/gob/casos") must keep `expediente=disputas` on
   * every chip click, or the chip would silently drop the viewer back onto
   * the hub's default "casos" tab. Omit on non-hub, single-purpose routes
   * (existing behavior, unchanged).
   */
  extraFilterParams?: Record<string, string>;
  /**
   * Hrefs for the sort toggle, one per SORT_OPTIONS value. Supplying this
   * switches the toggle from local component state to a URL-driven control and
   * declares that the SERVER already ordered `rows` — so the client sort below
   * is skipped entirely and the rows render exactly as fetched.
   *
   * This is the SC-6 fix (audit 2026-07-26, red #3). While the toggle was local
   * state, "Urgencia" could only re-rank the page the server had already
   * chosen BY DATE, so the queue's headline order was the most urgent OF THAT
   * PAGE — under a caption that said "orden: Urgencia" without qualification.
   * Ranking the whole filtered set requires the ORDER BY to be in SQL, which
   * requires the server to know the mode, which requires it in the URL.
   *
   * A plain record and not a callback: this is a "use client" component and a
   * function prop is not serializable across the RSC boundary.
   *
   * Surfaces WITHOUT server-side urgency ordering (Disputas, /org/…/casos,
   * decomisos, alertas, la cola) simply omit it and keep the previous
   * local-state behaviour — for them the fetched list is the whole list, so a
   * page-local sort ranks everything there is and was never wrong.
   */
  sortHrefs?: Record<CaseQueueSort, string>;
  /**
   * The sort the SERVER applied. Only read when `sortHrefs` is supplied.
   * Defaults to "urgencia" — the queue's default order since the PO interview
   * 2026-07-23, item 6.
   */
  sortMode?: CaseQueueSort;
}

// ---------------------------------------------------------------------------
// Status chip links
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: Array<{ value: "open" | "closed" | null; label: string }> = [
  { value: null, label: "Todos" },
  { value: "open", label: "Abiertos" },
  { value: "closed", label: "Cerrados" },
];

/**
 * Sort-toggle options — hoisted so the row-count caption (below) can name the
 * ACTIVE sort's label instead of a hardcoded "más recientes" that reads wrong
 * once the default sort became urgency (copy audit 2026-08-06, S7).
 */
const SORT_OPTIONS: ReadonlyArray<{ value: CaseQueueSort; label: string }> = CASE_QUEUE_SORTS.map(
  (value) => ({ value, label: CASE_QUEUE_SORT_LABELS[value] }),
);

function buildFilterHref(
  base: string,
  kind: CaseKind | null | undefined,
  status: "open" | "closed" | null | undefined,
  extraParams?: Record<string, string>,
): string {
  const params = new URLSearchParams();
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) params.set(key, value);
  }
  if (kind) params.set("kind", kind);
  if (status) params.set("status", status);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base || "/";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Unified case queue table with filter chips + optional bulk-action bar.
 * Consumes the CaseListItem shape from lib/case-queries.
 */
export function CaseQueue({
  rows,
  filters,
  bulk,
  filterBase = "",
  caption = "Cola de casos",
  truncated = false,
  totalCount,
  emptyMessage = "No hay casos en esta cola.",
  emptyAction,
  showStatusChips = true,
  extraFilterParams,
  sortHrefs,
  sortMode: serverSortMode,
}: CaseQueueProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Default sort: urgency (age-days × kind-severity) — the old "recientes"
  // (openedAt desc, as returned by the query) stays reachable via the toggle
  // below (PO interview 2026-07-23, item 6: "no debe perderse el orden viejo").
  const [localSortMode, setLocalSortMode] = useState<CaseQueueSort>(CASE_QUEUE_DEFAULT_SORT);

  // Who owns the order: the server (URL-driven toggle) or this component.
  const serverOrdered = sortHrefs !== undefined;
  const sortMode: CaseQueueSort = serverOrdered
    ? (serverSortMode ?? CASE_QUEUE_DEFAULT_SORT)
    : localSortMode;

  const sortedRows = useMemo(() => {
    // Server-ordered: render exactly what arrived. Re-sorting here would be
    // worse than redundant — the client scores with `Date.now()` and the server
    // with `now()`, so across a midnight boundary the two disagree by a day and
    // the page would visibly reshuffle on hydration for no reason.
    if (serverOrdered) return rows;
    if (sortMode === "recientes") return rows;
    return [...rows].sort((a, b) => {
      const scoreDiff = caseUrgencyScore(b) - caseUrgencyScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      // Tie-break (equal score, incl. both 0/closed): older-opened first, so
      // the longest-unresolved row of a tied group still surfaces first. Same
      // tie-break the SQL ordering uses (caseListOrderBy).
      return a.openedAt.getTime() - b.openedAt.getTime();
    });
  }, [rows, sortMode, serverOrdered]);

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }, [rows]);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;

  const activeKind = filters?.kind ?? null;
  const activeStatus = filters?.status ?? null;

  const bulkActions = bulk ? bulk.actions(selected) : [];

  return (
    <div className="space-y-4">
      {/* Filter chips */}
      {showStatusChips && (
        <nav aria-label="Filtros de estado" className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((opt) => {
            const isActive = activeStatus === opt.value;
            return (
              <Link
                key={opt.value ?? "all"}
                href={buildFilterHref(filterBase, activeKind, opt.value, extraFilterParams)}
                aria-pressed={isActive}
                className={[
                  "rounded-full border px-3 py-1 text-sm font-medium no-underline transition-colors",
                  isActive
                    ? "border-ln-op-azul bg-ln-op-azul text-white"
                    : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe",
                ].join(" ")}
              >
                {opt.label}
              </Link>
            );
          })}
        </nav>
      )}

      {/* Sort toggle (PO interview 2026-07-23, item 6): "Urgencia" (age-days ×
          kind-severity, see caseUrgencyScore) is the default so the queue
          leads with what most needs action, not just what's newest. The old
          "Recientes" (openedAt desc, as fetched) stays one click away. Uses
          the shared OpButton primitive rather than a raw button element —
          the design-system consolidation ratchet (scripts/check-raw-
          buttons.mjs) requires new toggles to go through LnButton/OpButton. */}
      {/* The toggle renders even on a single row when the server owns the
          order: with SQL ordering the visible row count says nothing about how
          many rows the sort ranked, so hiding the control on a 1-row page would
          strand an operator whose filter happens to return one result. */}
      {(rows.length > 1 || serverOrdered) && (
        <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0 text-sm">
          <legend className="text-ln-op-mute">Ordenar por:</legend>
          {SORT_OPTIONS.map((opt) => {
            const isActive = sortMode === opt.value;
            // URL-driven when the server owns the order: the mode has to reach
            // the query, and a link is also what makes the ordered view
            // shareable and back-button-able.
            if (sortHrefs) {
              return (
                <OpButton
                  key={opt.value}
                  href={sortHrefs[opt.value]}
                  size="sm"
                  variant={isActive ? "primary" : "ghost"}
                  aria-pressed={isActive}
                >
                  {opt.label}
                </OpButton>
              );
            }
            return (
              <OpButton
                key={opt.value}
                type="button"
                size="sm"
                variant={isActive ? "primary" : "ghost"}
                aria-pressed={isActive}
                onClick={() => setLocalSortMode(opt.value)}
              >
                {opt.label}
              </OpButton>
            );
          })}
        </fieldset>
      )}

      {/* Row count — suppressed when empty: the empty-state box below already
          carries the message, so "Sin casos" + emptyMessage was a double.
          S7: a fixed "más recientes" was wrong once urgency became the
          default sort — the caption now names whichever sort is ACTIVE. */}
      {rows.length > 0 && (
        <p aria-live="polite" className="text-sm text-ln-op-mute">
          {totalCount !== undefined && totalCount > rows.length
            ? `Mostrando ${rows.length.toLocaleString("es-AR")} de ${totalCount.toLocaleString("es-AR")} · orden: ${SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? sortMode}`
            : `${rows.length} ${pluralizeEs(rows.length, "caso")}${truncated ? " (hay más — refiná los filtros)" : ""}`}
        </p>
      )}

      {/* Table (sm and up) + stacked cards (below sm) — see the header comment
          on why this is two views over the SAME sortedRows, not one
          column-hiding table. */}
      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-sm)] border border-dashed border-ln-op-line p-8 text-center text-md text-ln-op-mute space-y-2">
          <p>{emptyMessage}</p>
          {emptyAction && <div>{emptyAction}</div>}
        </div>
      ) : (
        <>
          {/* Q2 (sticky headers): the header sticks to THIS wrapper, so the
            wrapper must be the scrolling element — `position: sticky` fails
            silently when the scroll happens on an ancestor the sticky can't
            see (the old `overflow-x-auto` made this div a scroll container
            that never scrolled vertically, which is exactly that trap). Same
            structure as MapDataTable: max-height + overflow-auto on the
            container, sticky + opaque bg + z on the thead. `hidden sm:block`:
            below 640px the stacked card list (right after this) takes over
            entirely — see the header comment. */}
          <div className="hidden sm:block max-h-[70vh] overflow-auto rounded-[var(--radius-sm)] border border-ln-op-line">
            <table className="w-full border-collapse text-md">
              <caption className="sr-only">{caption}</caption>
              <thead className="sticky top-0 z-10 bg-ln-op-stripe">
                <tr>
                  {bulk && (
                    <th scope="col" className="w-10 px-3 py-2 text-left">
                      <input
                        type="checkbox"
                        aria-label={allSelected ? "Deseleccionar todos" : "Seleccionar todos"}
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelected;
                        }}
                        onChange={toggleAll}
                        className="h-4 w-4 rounded border-ln-op-line accent-ln-op-azul"
                      />
                    </th>
                  )}
                  <th
                    scope="col"
                    className="px-3 py-2 text-left font-ln-mono text-xs font-bold uppercase tracking-[.1em] text-ln-op-mute"
                  >
                    Código
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left font-ln-mono text-xs font-bold uppercase tracking-[.1em] text-ln-op-mute"
                  >
                    Tipo
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left font-ln-mono text-xs font-bold uppercase tracking-[.1em] text-ln-op-mute"
                  >
                    Estado
                  </th>
                  <th
                    scope="col"
                    className="hidden px-3 py-2 text-left font-ln-mono text-xs font-bold uppercase tracking-[.1em] text-ln-op-mute sm:table-cell"
                  >
                    Mascota
                  </th>
                  <th
                    scope="col"
                    className="hidden px-3 py-2 text-left font-ln-mono text-xs font-bold uppercase tracking-[.1em] text-ln-op-mute md:table-cell"
                  >
                    Jurisdicción
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left font-ln-mono text-xs font-bold uppercase tracking-[.1em] text-ln-op-mute"
                  >
                    Apertura
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, idx) => {
                  const href = row.detailHref ?? `/casos/${row.publicCode}`;
                  const isSelected = selected.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      className={[
                        "border-t border-ln-op-line transition-colors",
                        isSelected
                          ? "bg-ln-op-blue-bg"
                          : idx % 2 === 0
                            ? "bg-ln-op-card hover:bg-ln-op-stripe"
                            : "bg-transparent hover:bg-ln-op-stripe",
                      ].join(" ")}
                    >
                      {bulk && (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar caso ${row.publicCode}`}
                            checked={isSelected}
                            onChange={() => toggleRow(row.id)}
                            className="h-4 w-4 rounded border-ln-op-line accent-ln-op-azul"
                          />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <Link
                          href={href}
                          className="no-underline"
                          aria-label={`Ver caso ${row.publicCode}`}
                        >
                          <OpCodeBadge tone="blue">{row.publicCode}</OpCodeBadge>
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ln-op-ink-2">{caseKindLabel(row.caseKind)}</td>
                      <td className="px-3 py-2">
                        <CaseStatusBadge status={row.status} />
                      </td>
                      <td className="hidden px-3 py-2 text-ln-op-mute sm:table-cell">
                        {row.primaryPetName ??
                          (row.primarySubjectKind === "unowned_animal"
                            ? "Animal sin registrar"
                            : "—")}
                      </td>
                      <td className="hidden px-3 py-2 text-ln-op-mute md:table-cell">
                        {row.jurisdictionLocality && row.jurisdictionProvince
                          ? `${row.jurisdictionLocality}, ${row.jurisdictionProvince}`
                          : (row.jurisdictionProvince ?? "—")}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-ln-op-mute">
                        <div className="flex flex-col gap-1">
                          <time dateTime={row.openedAt.toISOString()}>
                            {formatDate(row.openedAt)}
                          </time>
                          {/* SLA badge: only shown on non-closed cases past the warning
                            threshold (due-state "overdue" — the deadline is
                            caseSlaDueAt, same rule /gob/acciones ranks by). Label,
                            day count and tone come from the shared dueDateBadge so
                            this queue can never disagree with the worklist on what
                            "vencido" means. title stays the badge's legend (PO
                            interview 2026-07-23, item 6) — the label alone doesn't
                            say which deadline it counts against. */}
                          {(() => {
                            const badge = rowDueBadge(row);
                            if (!badge) return null;
                            return (
                              <span
                                title={`${badge.label} — plazo SLA de ${CASE_SLA_WARNING_DAYS} días desde la apertura del caso`}
                                aria-label={badge.label}
                              >
                                <OpPill tone={badge.tone}>{badge.label}</OpPill>
                              </span>
                            );
                          })()}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Stacked cards (below sm, 640px) — reuses the card idiom
            app/gob/vigilancia/investigaciones/page.tsx already uses for its
            queue. Every field the table hides at narrow widths (Mascota,
            Jurisdicción) is simply always visible here — there is no column
            to fit it into — and the SLA badge sits directly under the open
            date with nothing to its right, so it is never the reason a phone
            needs to scroll sideways. */}
          <ul className="sm:hidden divide-y divide-ln-op-line-2 rounded-[var(--radius-sm)] border border-ln-op-line">
            {sortedRows.map((row) => {
              const href = row.detailHref ?? `/casos/${row.publicCode}`;
              const isSelected = selected.has(row.id);
              const badge = rowDueBadge(row);
              const subject =
                row.primaryPetName ??
                (row.primarySubjectKind === "unowned_animal" ? "Animal sin registrar" : "—");
              const jurisdiction =
                row.jurisdictionLocality && row.jurisdictionProvince
                  ? `${row.jurisdictionLocality}, ${row.jurisdictionProvince}`
                  : (row.jurisdictionProvince ?? "—");
              return (
                <li
                  key={row.id}
                  className={[
                    "flex items-start gap-3 p-3",
                    isSelected ? "bg-ln-op-blue-bg" : "bg-ln-op-card",
                  ].join(" ")}
                >
                  {bulk && (
                    <input
                      type="checkbox"
                      aria-label={`Seleccionar caso ${row.publicCode}`}
                      checked={isSelected}
                      onChange={() => toggleRow(row.id)}
                      className="mt-1 h-4 w-4 shrink-0 rounded border-ln-op-line accent-ln-op-azul"
                    />
                  )}
                  <Link
                    href={href}
                    className="min-w-0 flex-1 space-y-1 no-underline"
                    aria-label={`Ver caso ${row.publicCode}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <OpCodeBadge tone="blue">{row.publicCode}</OpCodeBadge>
                      <CaseStatusBadge status={row.status} />
                    </div>
                    <p className="text-md text-ln-op-ink">{caseKindLabel(row.caseKind)}</p>
                    <p className="text-sm text-ln-op-mute">
                      {subject} &middot; {jurisdiction}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-ln-op-mute">
                      <time dateTime={row.openedAt.toISOString()}>{formatDate(row.openedAt)}</time>
                      {badge && (
                        <span
                          title={`${badge.label} — plazo SLA de ${CASE_SLA_WARNING_DAYS} días desde la apertura del caso`}
                          aria-label={badge.label}
                        >
                          <OpPill tone={badge.tone}>{badge.label}</OpPill>
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Bulk bar — only rendered when bulk is configured and count > 0 */}
      {bulk && (
        <OpBulkBar
          count={selected.size}
          actions={bulkActions}
          onClear={() => {
            setSelected(new Set());
            bulk.onClear?.();
          }}
        />
      )}
    </div>
  );
}
