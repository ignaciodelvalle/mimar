// OutboxTable — shared presentational table for the event-notification outbox
// list surfaces (/admin/outbox + /gob/outbox), which were ~90% duplicated
// (Wave B systemic — shared-component adoption).
//
// The two pages differ only in their QUERY (admin is unscoped and resolves
// source-event → pet links; govt adds a jurisdiction WHERE and hides the
// admin-only detail link). Those differences are injected here as props:
//   - petTokenBySourceEventId — when provided, the "Evento origen" cell links
//     to the pet public page; when omitted the cell is plain mono text (govt).
//   - detailHrefFor — returns the row's detail href, or null to render "—"
//     (govt non-admin has no scoped detail page yet).
//
// This is a Server Component (no interactivity) — safe to receive function
// props from the parent server page.

import Link from "next/link";

import { OpPill } from "@/components/ui/dashboard/OpPill";
import type { OutboxStatus } from "@/db";
import {
  type BreachCue,
  type EnoNotificationDetail,
  buildBreachCue,
  buildStatusLabel,
  externalDeliveryNote,
  isPendingExternalTransmission,
} from "@/lib/infra/outbox-list";
import { formatDateTimeNumericAr } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Shared filter/presentation constants (previously duplicated in both pages)
// ---------------------------------------------------------------------------

export const OUTBOX_TARGET_KIND_LABEL: Record<string, string> = {
  govt_webhook: "Webhook govt",
  eno_authority: "Autoridad ENO",
  audit_export: "Exportación auditoría",
  internal_dashboard: "Dashboard interno",
};

export const OUTBOX_TARGET_KIND_VALUES = [
  "govt_webhook",
  "eno_authority",
  "audit_export",
  "internal_dashboard",
] as const;

export const OUTBOX_STATUS_VALUES = ["pending", "delivered", "failed"] as const;

type PillTone = "ok" | "neutral" | "danger" | "escalated";

const BREACH_PILL_TONE: Record<BreachCue, PillTone> = {
  delivered: "ok",
  ok: "neutral",
  breach: "danger",
  failed: "escalated",
};

const BREACH_PILL_LABEL: Record<BreachCue, string> = {
  delivered: "Entregado",
  ok: "En SLA",
  breach: "Incumplimiento",
  failed: "Fallido",
};

/**
 * G7 (2026-08-02): the delivered-cue pill must not read "Entregado" for a row
 * whose transmission has no external receiving endpoint (eno_authority) —
 * that pill was the exact lie externalDeliveryNote used to footnote. The
 * honest pending-transmission state comes from buildStatusLabel (status
 * 'delivered' + targetKind), rendered neutral instead of green: nothing was
 * delivered externally, so nothing has earned an all-clear tone.
 */
function cuePill(cue: BreachCue, status: OutboxStatus, targetKind: string) {
  if (cue === "delivered" && isPendingExternalTransmission(status, targetKind)) {
    return { tone: "neutral" as PillTone, label: buildStatusLabel(status, targetKind) };
  }
  return { tone: BREACH_PILL_TONE[cue], label: BREACH_PILL_LABEL[cue] };
}

// Re-export so filter <option> labels stay in sync across pages.
export { buildStatusLabel };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboxTableRow {
  id: string;
  status: OutboxStatus;
  slaDueAt: Date;
  targetKind: string;
  targetJurisdictionProvince: string | null;
  targetJurisdictionLocality: string | null;
  sourceEventId: string;
  attempts: number;
  createdAt: Date;
  /** The enqueue-time payload snapshot — read by `enoDetailFor` (legal queue) only. */
  payloadSnapshot?: unknown;
}

export interface OutboxTableProps {
  rows: OutboxTableRow[];
  caption: string;
  /**
   * sourceEventId → pet publicToken. When a row's sourceEventId is present the
   * "Evento origen" cell links to /p/[token]; otherwise it renders plain text.
   * Omit entirely to disable event→pet linking (govt scope).
   */
  petTokenBySourceEventId?: Map<string, string>;
  /** Returns the detail href for a row, or null to render an inert "—" cell. */
  detailHrefFor: (row: OutboxTableRow) => string | null;
  /**
   * Legal-queue view (`?preset=eno`): when provided, an extra "Enfermedad ·
   * plazo legal" column renders what it returns per row (the disease behind
   * the notification and the statutory window its SLA was minted from — see
   * describeEnoNotification), or "—" when the snapshot carries none. Omitted
   * on the whole-bandeja view, where most rows have no disease to name.
   */
  enoDetailFor?: (row: OutboxTableRow) => EnoNotificationDetail | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TH_CLS = "px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute";

function formatDateTime(value: Date): string {
  return formatDateTimeNumericAr(value);
}

export function OutboxTable({
  rows,
  caption,
  petTokenBySourceEventId,
  detailHrefFor,
  enoDetailFor,
}: OutboxTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-ln-op-line">
            <th scope="col" className={TH_CLS}>
              SLA
            </th>
            <th scope="col" className={TH_CLS}>
              Destino
            </th>
            <th scope="col" className={TH_CLS}>
              Jurisdicción
            </th>
            {enoDetailFor && (
              <th scope="col" className={TH_CLS}>
                Enfermedad · plazo legal
              </th>
            )}
            <th scope="col" className={TH_CLS}>
              Evento origen
            </th>
            <th scope="col" className={TH_CLS}>
              Intentos
            </th>
            <th scope="col" className={TH_CLS}>
              Creado
            </th>
            <th scope="col" className={TH_CLS}>
              SLA vence
            </th>
            <th scope="col" className={TH_CLS}>
              Acción
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cue: BreachCue = buildBreachCue(row.status, row.slaDueAt);
            const pill = cuePill(cue, row.status, row.targetKind);
            const jurisdiction = [row.targetJurisdictionLocality, row.targetJurisdictionProvince]
              .filter(Boolean)
              .join(", ");
            const petToken = petTokenBySourceEventId?.get(row.sourceEventId);
            const detailHref = detailHrefFor(row);

            return (
              <tr
                key={row.id}
                className={`border-t border-ln-op-line ${cue === "breach" ? "bg-ln-op-danger-bg" : "hover:bg-ln-op-stripe"}`}
              >
                <td className="py-2 px-3">
                  <OpPill tone={pill.tone}>{pill.label}</OpPill>
                </td>
                <td className="py-2 px-3 whitespace-nowrap text-sm text-ln-op-ink-2">
                  {OUTBOX_TARGET_KIND_LABEL[row.targetKind] ?? row.targetKind}
                  {/* ENO honest-delivery note (C2, 2026-07-22): "Entregado" on
                      this row means our outbox pipeline processed it, not
                      that the external health authority received it — no
                      receiving endpoint exists yet. */}
                  {externalDeliveryNote(row.targetKind) && (
                    <span
                      className="ml-1 cursor-help text-ln-op-mute"
                      title={externalDeliveryNote(row.targetKind) ?? undefined}
                      aria-label={externalDeliveryNote(row.targetKind) ?? undefined}
                    >
                      ⓘ
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-sm text-ln-op-ink-2">{jurisdiction || "—"}</td>
                {enoDetailFor &&
                  (() => {
                    const eno = enoDetailFor(row);
                    return (
                      <td className="py-2 px-3 text-sm text-ln-op-ink-2 whitespace-nowrap">
                        {eno ? (
                          <>
                            {eno.diseaseLabel}
                            <span className="text-ln-op-mute"> · {eno.legalHours} h</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    );
                  })()}
                <td className="py-2 px-3">
                  {petToken ? (
                    <Link
                      href={`/p/${petToken}`}
                      className="font-ln-mono text-sm text-ln-op-azul underline underline-offset-2 hover:opacity-80 whitespace-nowrap"
                    >
                      {row.sourceEventId.slice(0, 8)}
                      {"…"}
                    </Link>
                  ) : (
                    <span className="font-ln-mono text-sm text-ln-op-mute">
                      {row.sourceEventId.slice(0, 8)}
                      {"…"}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-sm text-ln-op-ink-2 text-center">
                  {/* W3: attempts=0 means the drainer never touched this row yet.
                      Rendering a bare "0" on a delivered/breached row read as a
                      real (confusing) attempt count, so the cell dashed instead.
                      PO, 2026-07-26: with every row at 0 (the drainer has not run
                      against this data), the whole column read as BLANK — and an
                      em dash is this repo's "no value" glyph, while `attempts` is
                      NOT NULL DEFAULT 0: the value exists and it is zero. On a
                      breached row "nobody has tried yet" is the most important
                      fact in the row, so say it in words instead of punctuating
                      it away. */}
                  {row.attempts === 0 ? (
                    <span className="text-sm text-ln-op-mute whitespace-nowrap">Sin intentos</span>
                  ) : (
                    row.attempts
                  )}
                </td>
                <td className="py-2 px-3 text-sm tabular-nums text-ln-op-mute whitespace-nowrap">
                  {formatDateTime(row.createdAt)}
                </td>
                <td className="py-2 px-3 text-sm tabular-nums text-ln-op-mute whitespace-nowrap">
                  {formatDateTime(row.slaDueAt)}
                </td>
                <td className="py-2 px-3">
                  {detailHref ? (
                    // Plain <a> (not next/link) — operator-trust T2. The row →
                    // detail click soft-nav-dropped on this dense list (Next 15.5
                    // client-router defect, see lib/ui/sheet-nav.ts): the link
                    // focused but the page stayed. A real anchor hard-navigates,
                    // so the click always lands on the detail page.
                    <a
                      href={detailHref}
                      className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-2 hover:underline whitespace-nowrap"
                    >
                      Detalle {"→"}
                    </a>
                  ) : (
                    <span className="text-sm text-ln-op-mute">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
