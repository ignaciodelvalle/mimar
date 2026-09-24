"use client";

// AdoptionQueueList — client component for the org adoption review surface
// (UX audit 1.3 adopciones).
//
// Features:
//   - Checkbox selection with shift-click range select.
//   - OpBulkBar for bulk approve / reject (reject requires a reason ≥ 5 chars).
//   - Age/SLA badge per row: neutral up to ADOPTION_SLA_WARNING_DAYS, warning
//     above it (application is "stale" and the org should act).
//   - Filter chips (Pendientes / Aprobadas / Rechazadas) as URL-driven <a>
//     links; no local filter state.
//   - ResultPanel for partial-failure feedback after a bulk action.
//
// Selection state lives here. Filter state lives in the URL (?status=).
// The parent (server component) fetches data and passes it as props.

import Link from "next/link";
import { useCallback, useState, useTransition } from "react";

import type { BulkResult } from "@/app/actions/bulk-actions";
import {
  bulkApproveAdoptionApplicationsAction,
  bulkRejectAdoptionApplicationsAction,
} from "@/app/actions/bulk-adoption-actions";
import { Icon } from "@/components/Icon";
import { LnCheckbox } from "@/components/ui/Field";
import type { OpBulkAction } from "@/components/ui/dashboard/OpBulkBar";
import { OpBulkBar } from "@/components/ui/dashboard/OpBulkBar";
import { OpBulkResultPanel } from "@/components/ui/dashboard/OpBulkResultPanel";
import { OpPill } from "@/components/ui/dashboard/OpPill";
import { toggleSelection } from "@/lib/domain/bulk-select";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { calendarDaysAgoInAr } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// SLA constant
// ---------------------------------------------------------------------------

/**
 * Applications pending for longer than this many days are considered stale.
 * The org dashboard shows a warning-toned age badge so reviewers can triage
 * quickly. There is no hard enforcement (no auto-close); it is purely visual.
 * Derived from a reasonable 7-day window for volunteer orgs (industry-typical).
 */
export const ADOPTION_SLA_WARNING_DAYS = 7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdoptionQueueRow = {
  /** application_event_id — stable UUID from pet_events. Used as selection key. */
  applicationEventId: string;
  petName: string;
  petPublicToken: string;
  applicantName: string | null;
  /** Null once the applicant exercised art. 16 erasure (T3-A2b). */
  housingType: string | null;
  submittedAt: string; // ISO string from DB
  infoRequested: boolean;
  /** The pet lives with its family while this org runs the evaluation (rehome-by-titular, REQ-11). */
  livesWithFamily: boolean;
};

export type AdoptionQueueStatus = "pending" | "approved" | "rejected";

export type AdoptionQueueListProps = {
  rows: AdoptionQueueRow[];
  orgToken: string;
  /** Active status filter — drives chip highlight. Defaults to "pending". */
  activeStatus: AdoptionQueueStatus;
};

// ---------------------------------------------------------------------------
// Filter chip config
// ---------------------------------------------------------------------------

const STATUS_CHIPS: Array<{ value: AdoptionQueueStatus; label: string }> = [
  { value: "pending", label: "Pendientes" },
  { value: "approved", label: "Aprobadas" },
  { value: "rejected", label: "Rechazadas" },
];

// ---------------------------------------------------------------------------
// Age utilities
// ---------------------------------------------------------------------------

/** AR-calendar days since submittedAt — a submission from yesterday evening
 * reads "1 día" this morning, never "hoy" (calendarDaysAgoInAr rationale).
 * `now` is injectable so tests can pin the boundary deterministically. */
export function ageDays(submittedAt: string, now: Date = new Date()): number {
  return calendarDaysAgoInAr(new Date(submittedAt), now);
}

function ageLabel(days: number): string {
  if (days === 0) return "hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}

// ---------------------------------------------------------------------------
// Housing type label (duplicated from server component to keep component self-
// contained; pure function, no I/O).
// ---------------------------------------------------------------------------

function housingTypeLabel(value: string | null): string {
  if (value === null) return "Sin dato";
  switch (value) {
    case "casa_con_patio":
      return "Casa con patio";
    case "casa_sin_patio":
      return "Casa sin patio";
    case "departamento":
      return "Departamento";
    default:
      return "Otra";
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AdoptionQueueList({ rows, orgToken, activeStatus }: AdoptionQueueListProps) {
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);

  // Shift-click range select: if Shift is held and there's a previous anchor,
  // toggle all rows between anchor and the clicked row inclusive.
  const handleRowCheckbox = useCallback(
    (idx: number, id: string, shiftKey: boolean) => {
      if (shiftKey && lastClickedIdx !== null) {
        const lo = Math.min(lastClickedIdx, idx);
        const hi = Math.max(lastClickedIdx, idx);
        setSelected((prev) => {
          const next = new Set(prev);
          const targetState = !prev.has(id);
          for (let i = lo; i <= hi; i++) {
            const rowId = rows[i]?.applicationEventId;
            if (rowId) {
              if (targetState) next.add(rowId);
              else next.delete(rowId);
            }
          }
          return next;
        });
      } else {
        setSelected((prev) => toggleSelection(prev, id));
      }
      setLastClickedIdx(idx);
    },
    [lastClickedIdx, rows],
  );

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.applicationEventId)),
    );
  }, [rows]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setLastClickedIdx(null);
  }, []);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;

  // Post-bulk navigation (router.refresh() is banned — it rides the same
  // client-router transition machinery as the silent-drop defect; see
  // lib/ui/full-page-action-nav.ts). Clean success → immediate full reload
  // so the SSR list reflects the new state. Partial failure → keep the
  // ResultPanel visible (its whole purpose is making partial failure
  // legible) and do the full reload when the operator dismisses it.
  const settleBulkResult = useCallback(
    (result: BulkResult) => {
      if (result.failed.length === 0) {
        navigateAfterActionSuccess(window.location.href);
        return;
      }
      setLastResult(result);
      clearSelection();
    },
    [clearSelection],
  );

  const dismissResult = useCallback(() => {
    setLastResult((prev) => {
      if (prev && prev.succeeded.length > 0) {
        // Some rows DID change server-side — the list is stale; reload it.
        navigateAfterActionSuccess(window.location.href);
        return prev;
      }
      return null;
    });
  }, []);

  // Build bulk actions for OpBulkBar.
  const bulkActions: OpBulkAction[] = [
    {
      key: "approve",
      label: "Aprobar seleccionadas",
      tone: "neutral",
      // Approving notifies the applicants — gate it behind a confirm so it can't
      // fire on a single misclick (parity with the Rechazar confirm).
      requireConfirm: true,
      confirmLabel: "Aprobar postulaciones",
      confirmTitle: "Aprobar postulaciones seleccionadas",
      confirmDescription:
        "Las postulantes seleccionadas recibirán una notificación de aprobación. Confirmá que querés aprobar estas adopciones.",
      onRun: (_reason: string) => {
        const ids = Array.from(selected);
        setLastResult(null);
        startTransition(async () => {
          const result = await bulkApproveAdoptionApplicationsAction({
            orgToken,
            applicationEventIds: ids,
          });
          settleBulkResult(result);
        });
      },
    },
    {
      key: "reject",
      label: "Rechazar seleccionadas",
      tone: "danger",
      requireReason: true,
      minReasonLength: 5,
      confirmLabel: "Rechazar postulaciones",
      confirmTitle: "Rechazar postulaciones seleccionadas",
      confirmDescription:
        "Las postulantes seleccionadas recibirán una notificación con el motivo. Esta acción no se puede deshacer.",
      onRun: (reason: string) => {
        const ids = Array.from(selected);
        setLastResult(null);
        startTransition(async () => {
          const result = await bulkRejectAdoptionApplicationsAction({
            orgToken,
            applicationEventIds: ids,
            reason,
          });
          settleBulkResult(result);
        });
      },
    },
  ];

  return (
    <div className="space-y-4 pb-32">
      {/* Filter chips */}
      <nav aria-label="Filtros de estado" className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((chip) => {
          const isActive = activeStatus === chip.value;
          return (
            <Link
              key={chip.value}
              href={`/org/${orgToken}/adopciones?status=${chip.value}`}
              aria-pressed={isActive}
              className={[
                "rounded-full border px-3 py-1 text-sm font-medium no-underline transition-colors",
                isActive
                  ? "border-ln-op-azul bg-ln-op-azul text-white"
                  : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe",
              ].join(" ")}
            >
              {chip.label}
            </Link>
          );
        })}
      </nav>

      {/* Row count — suppressed when empty: the empty-state box below already
          says it, and "Sin postulaciones" + "No tenés postulaciones…" back to
          back was the same message twice. */}
      {rows.length > 0 && (
        <p aria-live="polite" className="text-sm text-ln-op-mute">
          {`${rows.length} ${rows.length === 1 ? "postulación" : "postulaciones"}`}
        </p>
      )}

      {/* Empty state — a review queue with nothing pending is a GOOD state, not
          a dead end, but it still shouldn't strand the operator with no next
          step (copy audit 2026-08-04, S8). Point back at the org's own pets. */}
      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-sm)] border border-dashed border-ln-op-line p-8 text-center text-md text-ln-op-mute space-y-2">
          <p>
            {activeStatus === "pending"
              ? "No tenés postulaciones pendientes de revisión."
              : activeStatus === "approved"
                ? "Todavía no aprobaste ninguna postulación."
                : "Todavía no rechazaste ninguna postulación."}
          </p>
          <Link href={`/org/${orgToken}/mascotas`} className="text-ln-op-azul hover:underline">
            Ver mascotas en custodia
          </Link>
        </div>
      ) : (
        <>
          {/* Select-all toggle — only shown for pending (bulk actions apply to pending) */}
          {activeStatus === "pending" && (
            <div className="flex items-center gap-3 text-sm text-ln-op-mute">
              <button
                type="button"
                onClick={allSelected ? clearSelection : toggleAll}
                className="underline hover:text-ln-op-ink"
              >
                {allSelected ? "Deseleccionar todo" : `Seleccionar todo (${rows.length})`}
              </button>
            </div>
          )}

          {/* Row list */}
          <ul className="divide-y divide-ln-op-line rounded-[var(--radius-sm)] border border-ln-op-line">
            {rows.map((row, idx) => {
              const isSelected = selected.has(row.applicationEventId);
              const days = ageDays(row.submittedAt);
              const isStale = days >= ADOPTION_SLA_WARNING_DAYS;
              const href = `/org/${orgToken}/adopciones/${row.applicationEventId}`;

              return (
                <li
                  key={row.applicationEventId}
                  className={[
                    "flex items-start gap-3 px-4 py-3 transition-colors",
                    isSelected ? "bg-ln-op-blue-bg" : "hover:bg-ln-op-stripe",
                  ].join(" ")}
                >
                  {/* Checkbox — only for pending rows (bulk only applies to pending) */}
                  {activeStatus === "pending" && (
                    <div className="mt-0.5 shrink-0">
                      <LnCheckbox
                        id={`app-${row.applicationEventId}`}
                        checked={isSelected}
                        onChange={(e) =>
                          handleRowCheckbox(
                            idx,
                            row.applicationEventId,
                            e.nativeEvent instanceof MouseEvent &&
                              (e.nativeEvent as MouseEvent).shiftKey,
                          )
                        }
                        onClick={(e) => {
                          // Capture shift state on click for keyboard + pointer parity.
                          handleRowCheckbox(idx, row.applicationEventId, e.shiftKey);
                        }}
                        aria-label={`Seleccionar postulación de ${row.applicantName ?? "postulante"} para ${row.petName}`}
                      />
                    </div>
                  )}

                  {/* Row content */}
                  <Link href={href} className="flex-1 min-w-0 space-y-1 no-underline">
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                      <p className="flex items-center gap-2 flex-wrap text-md font-medium text-ln-op-ink">
                        {row.applicantName ?? "Postulante"}
                        <span className="text-sm font-normal text-ln-op-mute">→ {row.petName}</span>
                        {row.infoRequested && (
                          <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-ln-op-azul bg-ln-op-celeste-050 px-1.5 py-px text-xs font-semibold uppercase tracking-[.08em] text-ln-op-azul">
                            Info pedida
                          </span>
                        )}
                        {row.livesWithFamily && (
                          <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-ln-op-line bg-ln-op-stripe px-1.5 py-px text-xs font-semibold uppercase tracking-[.08em] text-ln-op-ink-2">
                            Vive con su familia
                          </span>
                        )}
                      </p>

                      {/* Age/SLA badge */}
                      <OpPill tone={isStale ? "open" : "neutral"}>
                        {ageLabel(days)}
                        {isStale && (
                          <Icon
                            name="warning"
                            size="sm"
                            decorative
                            className="ml-0.5 inline align-text-bottom"
                          />
                        )}
                      </OpPill>
                    </div>

                    <p className="text-sm text-ln-op-mute">
                      Vivienda: {housingTypeLabel(row.housingType)}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* Partial-failure result panel */}
      {lastResult && (
        <OpBulkResultPanel result={lastResult} onDismiss={dismissResult} truncateFailedIdsTo={8} />
      )}

      {/* Bulk bar — only active when pending rows are selected */}
      {activeStatus === "pending" && (
        <OpBulkBar count={selected.size} actions={bulkActions} onClear={clearSelection} />
      )}
    </div>
  );
}
