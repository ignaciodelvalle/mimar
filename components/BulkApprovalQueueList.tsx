"use client";

// Client-side wrapper for the approval queues (/admin/cola and /gob/cola).
// Renders each pending request as a row with a checkbox; when ≥ 1 are
// selected, a sticky BulkActionBar appears with Approve / Reject. Modals
// drive the corresponding bulk server action; results show per-item
// success / failure inline so partial-failure (e.g. some items out of the
// govt's scope) is legible.
//
// Dashboard-kit migration (2026-07-19): rows/actions were brought up to kit
// STYLING (LnEmptyState, OpButton, OpCard-consistent row tokens) but rows
// deliberately were NOT ported onto `components/ui/dashboard/CaseQueue.tsx`.
// CaseQueue's bulk mode delegates to `OpBulkBar`, whose `OpBulkAction.onRun`
// is a single `(reason: string) => void | Promise<void>` — it has no slot for
// this screen's per-type approval breakdown, the RUPGA CUD warning, the
// hasVetMatricula bulk-approve gate, or (the big one) the inline partial-
// failure `ResultPanel` below (succeeded/failed counts + per-item reasons +
// bulkActionId — see settleBulkResult/dismissResult). `CaseQueueRow` also
// assumes case semantics (caseKind/CaseStatus/openedAt/closedAt) that don't
// exist for an approval_requests row. Forcing either would mean rebuilding
// half of OpBulkBar inside a CaseQueue wrapper or discarding the partial-
// failure legibility that's this screen's whole point — so rows keep their
// bespoke <ul>/<li> + bespoke bulk bar, now token-aligned with the kit.

import Link from "next/link";
import { type ReactNode, useState, useTransition } from "react";

import {
  type BulkResult,
  bulkApproveRequestsAction,
  bulkRejectRequestsAction,
} from "@/app/actions/bulk-actions";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpBulkResultPanel } from "@/components/ui/dashboard/OpBulkResultPanel";
import { OpButton, type OpButtonVariant } from "@/components/ui/dashboard/OpButton";
import { OpCodeBadge } from "@/components/ui/dashboard/OpCodeBadge";
import { OpCheckbox, OpTextarea } from "@/components/ui/dashboard/OpField";
import { OpPill } from "@/components/ui/dashboard/OpPill";
import type { ApprovalRequestType } from "@/db";
import {
  RUPGA_APPROVAL_WARNING,
  VET_MATRICULA_BULK_APPROVE_BLOCKED,
  VET_MATRICULA_TYPE,
  computeApprovalTypeBreakdown,
  selectionHasRupga,
  selectionHasVetMatricula,
} from "@/lib/infra/approval-queue-breakdown";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { formatDate, pluralizeEs } from "@/lib/utils/format";

export type QueueItem = {
  publicToken: string;
  /** Raw request type — drives the per-type approval breakdown + RUPGA warning. */
  type: ApprovalRequestType;
  typeLabel: string;
  applicantName: string;
  jurisdiction: string;
  /**
   * ISO-8601 timestamp of the request. RAW, not pre-formatted (queue-anatomy
   * alignment, 2026-07-30): the row formats it itself with the shared
   * `formatDate`, the same absolute vocabulary the dominant queue anatomy
   * (components/ui/dashboard/CaseQueue.tsx) uses, so the queue can no longer
   * drift to a per-caller date format. `formatDate` is AR-timezone-pinned, so
   * formatting it client-side is hydration-safe.
   */
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Row state indicator (queue-anatomy alignment, 2026-07-30)
//
// This was the only operator queue with NO state indicator at all. The obvious
// fix — a literal "Pendiente" badge — would have been a constant, not
// information: the queue fetches `status = 'pending'` exclusively
// (fetchVisiblePendingRequests, lib/infra/approval-scope.ts), so every row would
// carry the identical pill.
//
// The state that DOES vary per row is the DECISION PATH, and today the operator
// discovers it only by selecting a row and finding "Aprobar" disabled: vet
// matrículas are excluded from bulk approve (VET_MATRICULA_BULK_APPROVE_BLOCKED,
// mirrored server-side by approveRequestForAuthority). The row now declares that
// up front.
//
// Vocabulary is the approvals domain's own (pending + the bulk-approve gate) —
// deliberately NOT mapped onto CaseStatus, which has no meaning here. Only the
// PRIMITIVE is shared: OpPill → OpStatusPill, the same primitive every other
// operator queue routes through.
// ---------------------------------------------------------------------------

function rowStateDisplay(type: ApprovalRequestType): {
  tone: "open" | "triaged";
  label: string;
} {
  return type === VET_MATRICULA_TYPE
    ? { tone: "triaged", label: "Verificación individual" }
    : { tone: "open", label: "Pendiente" };
}

export function BulkApprovalQueueList({
  items,
  detailUrlPrefix,
  historyHref,
  servicesHref,
}: {
  items: QueueItem[];
  detailUrlPrefix: string;
  /**
   * Link to the OTHER place approvals happen — Directorio's services registry.
   * Portal-aware, so the caller supplies it (same reason as `historyHref`).
   * Without it the empty state still names its scope in prose; with it the
   * operator gets one click to the work this queue cannot show.
   */
  servicesHref?: string;
  /**
   * Link to the portal's decision history (e.g. `${base}/historial`). Shown
   * as the empty-state CTA — there is nothing to "create" on a review queue,
   * but an empty inbox still shouldn't be a dead end (copy audit 2026-08-04,
   * S8). Optional so tests/callers without a history route keep today's
   * action-less empty state.
   */
  historyHref?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"none" | "approve" | "reject">("none");
  const [decisionNotes, setDecisionNotes] = useState("");
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);

  function toggle(token: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(items.map((i) => i.publicToken)));
  }

  function clear() {
    setSelected(new Set());
    setMode("none");
    setLastResult(null);
    setDecisionNotes("");
  }

  // Post-bulk navigation (router.refresh() is banned — it rides the same
  // client-router transition machinery as the silent-drop defect; see
  // lib/ui/full-page-action-nav.ts). Clean success → immediate full reload
  // so the SSR queue reflects the new state. Partial failure → keep the
  // ResultPanel visible (its whole purpose is making partial failure
  // legible) and do the full reload when the operator dismisses it.
  function settleBulkResult(result: BulkResult) {
    if (result.failed.length === 0) {
      navigateAfterActionSuccess(window.location.href);
      return;
    }
    setLastResult(result);
  }

  function dismissResult() {
    if (lastResult && lastResult.succeeded.length > 0) {
      // Some rows DID change server-side — the list is stale; reload it.
      navigateAfterActionSuccess(window.location.href);
      return;
    }
    setLastResult(null);
  }

  function runApprove() {
    const tokens = Array.from(selected);
    setLastResult(null);
    startTransition(async () => {
      const result = await bulkApproveRequestsAction({
        requestPublicTokens: tokens,
        decisionNotes: decisionNotes.trim() || null,
      });
      settleBulkResult(result);
    });
  }

  function runReject() {
    const tokens = Array.from(selected);
    setLastResult(null);
    startTransition(async () => {
      const result = await bulkRejectRequestsAction({
        requestPublicTokens: tokens,
        reason: decisionNotes,
      });
      settleBulkResult(result);
    });
  }

  // THE EMPTY STATE NAMES ITS SCOPE. This screen is titled "Aprobaciones" but
  // only ever holds three approval_request types (matrículas, organizaciones,
  // RUPGA). Service offerings are approved in Directorio and are not
  // approval_requests at all — so this list is STRUCTURALLY incapable of
  // knowing whether one is waiting, and it used to say "No hay solicitudes
  // pendientes" as if it were.
  //
  // QA 2026-08-08 (S5-F01) measured both surfaces in the same minute: this one
  // said nothing was pending while Directorio showed "1 servicio pendiente".
  // Meanwhile the org had been promised, on sending it, that "la autoridad
  // competente lo revisa y aprueba". The operator who trusts the screen named
  // after the job never approves it.
  //
  // Same class as the outbox subtitle fixed 2026-08-08: an empty state claiming
  // more scope than it has.
  if (items.length === 0) {
    return (
      <LnEmptyState
        icon="solicitud"
        title="No hay solicitudes de registro pendientes"
        description="Matrículas veterinarias, verificación de organizaciones y credenciales RUPGA están al día en tu jurisdicción. Los servicios se aprueban por separado, en Directorio."
        action={
          <span className="flex flex-wrap items-center gap-3">
            {servicesHref ? (
              <Link href={servicesHref} className="text-sm text-ln-op-azul hover:underline">
                Ver servicios pendientes
              </Link>
            ) : null}
            {historyHref ? (
              <Link href={historyHref} className="text-sm text-ln-op-azul hover:underline">
                Ver historial de decisiones
              </Link>
            ) : null}
          </span>
        }
      />
    );
  }

  const allSelected = selected.size === items.length;
  const someSelected = selected.size > 0;

  // C5: per-type breakdown of the SELECTED items, for the approve confirmation.
  const selectedTypes = items.filter((i) => selected.has(i.publicToken)).map((i) => i.type);
  const typeBreakdown = computeApprovalTypeBreakdown(selectedTypes);
  const hasRupga = selectionHasRupga(selectedTypes);
  // Vet matrículas are approved individually (verification flow) — a selection
  // containing one blocks bulk APPROVE (reject stays available). Mirrors the
  // server-side guard in approveRequestForAuthority.
  const hasVetMatricula = selectionHasVetMatricula(selectedTypes);

  return (
    <div className="space-y-3 pb-32">
      <div className="flex items-center gap-3 text-xs text-ln-op-mute">
        <button
          type="button"
          onClick={allSelected ? clear : selectAll}
          className="underline hover:text-ln-op-ink"
        >
          {allSelected ? "Deseleccionar todo" : `Seleccionar todo (${items.length})`}
        </button>
      </div>

      <ul className="space-y-2">
        {items.map((item) => {
          const isSelected = selected.has(item.publicToken);
          const rowState = rowStateDisplay(item.type);
          return (
            <li
              key={item.publicToken}
              // OpCard-consistent row treatment (rounded-[var(--radius-md)] +
              // border-ln-op-line + bg-ln-op-card, matching components/ui/
              // dashboard/OpCard.tsx) and the same selected/hover tokens
              // CaseQueue uses for its rows (bg-ln-op-blue-bg when selected).
              // Kept as a raw <li>, NOT CaseQueue itself — see the file-level
              // note below the imports for why forcing CaseQueue here would
              // regress the bulk-selection UX this screen depends on.
              //
              // CSS-8: capped at 200 rows (COLA_PAGE_LIMIT, also served on
              // /admin/cola) with no virtualization — content-visibility
              // skips off-screen rows.
              className={`op-lazy-row rounded-[var(--radius-md)] border px-4 py-3 flex items-start gap-3 transition-colors ${
                isSelected
                  ? "border-ln-op-line bg-ln-op-blue-bg"
                  : "border-ln-op-line bg-ln-op-card hover:bg-ln-op-stripe"
              }`}
            >
              <OpCheckbox
                id={`row-${item.publicToken}`}
                checked={isSelected}
                onChange={() => toggle(item.publicToken)}
                aria-label={`Seleccionar solicitud de ${item.applicantName} (${item.typeLabel})`}
                className="mt-1"
              />
              <Link
                href={`${detailUrlPrefix}/${item.publicToken}`}
                className="flex-1 min-w-0 space-y-1 no-underline"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-ln-op-ink">{item.typeLabel}</p>
                  <OpPill tone={rowState.tone}>{rowState.label}</OpPill>
                </div>
                <p className="text-xs text-ln-op-mute">
                  {item.applicantName} · {item.jurisdiction}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <OpCodeBadge tone="blue">{item.publicToken}</OpCodeBadge>
                  <time dateTime={item.createdAt} className="text-xs text-ln-op-mute">
                    {formatDate(item.createdAt)}
                  </time>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {lastResult && <OpBulkResultPanel result={lastResult} onDismiss={dismissResult} />}

      {someSelected && (
        <div className="fixed bottom-0 left-0 right-0 border-t border-ln-op-line bg-ln-op-card z-50">
          <div className="max-w-5xl mx-auto px-6 py-3 space-y-3">
            {mode === "none" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm">
                    <span className="font-medium">{selected.size}</span>{" "}
                    {pluralizeEs(selected.size, "seleccionada")}
                  </p>
                  <div className="flex items-center gap-2">
                    {/* "Limpiar" stays a plain text button — not an OpButton —
                        matching OpBulkBar's OWN canonical "Limpiar" affordance
                        (components/ui/dashboard/OpBulkBar.tsx:117-123), which
                        is a bare button too. The shared kit doesn't promote
                        the clear-selection action to a bordered button. */}
                    <button
                      type="button"
                      onClick={clear}
                      className="text-xs text-ln-op-mute hover:text-ln-op-ink"
                    >
                      Limpiar
                    </button>
                    <OpButton variant="danger" size="sm" onClick={() => setMode("reject")}>
                      Rechazar
                    </OpButton>
                    <OpButton
                      variant="ok"
                      size="sm"
                      onClick={() => setMode("approve")}
                      disabled={hasVetMatricula}
                    >
                      Aprobar
                    </OpButton>
                  </div>
                </div>
                {hasVetMatricula && (
                  <output className="block text-sm text-ln-op-mute">
                    {VET_MATRICULA_BULK_APPROVE_BLOCKED}
                  </output>
                )}
              </div>
            )}

            {mode === "approve" && (
              <ConfirmRow
                title={`Aprobar ${selected.size} ${pluralizeEs(selected.size, "solicitud")}`}
                placeholder="Notas (opcional)"
                value={decisionNotes}
                onChange={setDecisionNotes}
                confirmLabel="Confirmar aprobación"
                confirmVariant="ok"
                confirmDisabled={hasVetMatricula}
                pending={pending}
                onConfirm={runApprove}
                onCancel={() => setMode("none")}
              >
                <ul className="space-y-0.5 text-xs text-ln-op-ink-2">
                  {typeBreakdown.map((entry) => (
                    <li key={entry.type} className="flex items-center justify-between gap-2">
                      <span>{entry.label}</span>
                      <span className="tabular-nums font-medium">{entry.count}</span>
                    </li>
                  ))}
                </ul>
                {hasRupga && (
                  <p
                    role="alert"
                    className="rounded-md border border-ln-op-danger-bd bg-ln-op-danger-bg px-2 py-1.5 text-sm text-ln-op-danger"
                  >
                    {RUPGA_APPROVAL_WARNING}
                  </p>
                )}
              </ConfirmRow>
            )}

            {mode === "reject" && (
              <ConfirmRow
                title={`Rechazar ${selected.size} ${pluralizeEs(selected.size, "solicitud")}`}
                placeholder="Motivo del rechazo (mínimo 5 caracteres) *"
                value={decisionNotes}
                onChange={setDecisionNotes}
                confirmLabel="Confirmar rechazo"
                confirmVariant="primary"
                confirmDisabled={decisionNotes.trim().length < 5}
                pending={pending}
                onConfirm={runReject}
                onCancel={() => setMode("none")}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmRow({
  title,
  placeholder,
  value,
  onChange,
  confirmLabel,
  confirmVariant,
  confirmDisabled,
  pending,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  confirmLabel: string;
  /**
   * Approve = "ok" (bg-ln-op-ok, matches OpButton's "EXPLICIT positive
   * confirmation" contract exactly). Reject = "primary" (bg-ln-op-azul) —
   * this preserves the EXISTING bespoke `confirmClass` color, which was
   * already blue, not red: rejecting a request is a normal decisive
   * workflow action here, not styled as destructive-red (the outline-red
   * "Rechazar" TRIGGER button above is the only red affordance in this flow).
   */
  confirmVariant: OpButtonVariant;
  confirmDisabled?: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      {children}
      <OpTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder={placeholder}
        size="sm"
      />
      <div className="flex gap-2 justify-end">
        <OpButton variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancelar
        </OpButton>
        <OpButton
          variant={confirmVariant}
          size="sm"
          onClick={onConfirm}
          disabled={pending || confirmDisabled}
        >
          {pending ? "Procesando..." : confirmLabel}
        </OpButton>
      </div>
    </div>
  );
}
