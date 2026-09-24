import { OpCodeBadge, OpPill, SlaBadge } from "@/components/ui/dashboard";
import {
  SEVERITY_BASE_LABEL,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportStatusLabel,
} from "@/src/modules/welfare/domain/types";
import type {
  WelfareReportSeverity,
  WelfareReportStatus,
} from "@/src/modules/welfare/domain/types";
import { primaryWelfareAction } from "@/src/modules/welfare/domain/welfare-status-rules";

import { formatDate } from "@/lib/utils/format";

import { isHistoricalBacklog } from "../_lib/welfare-sla";
import { ActuarButton } from "./ActuarButton";
import { TomarButton } from "./TomarButton";
import { WelfareRowLink } from "./WelfareRowLink";
import { resolveAssignmentDisplay } from "./welfare-row-assignment";

// Historical-backlog severity label (bug fix, qa-triage-2026-07-23 finding
// #4): welfareReportSeverityLabel's "— peligro inmediato" / "— urgente" /
// etc. suffix is an URGENCY claim, and SlaBadge already demotes urgency chrome
// to "Histórico · sin SLA activo" once isHistoricalBacklog is true (>180d
// non-terminal, welfare-sla.ts). Rendering the two pills side by side used to
// contradict: "CRÍTICA — PELIGRO INMEDIATO" next to "HISTÓRICO · SIN SLA
// ACTIVO" on the SAME card (e.g. DEN-VHCX-GRC9, 310 days old, still `open`).
// One truth per card: severity stays as DATA (the base name + tone/left-edge
// stay, nothing is hidden), only the urgency FRAMING is dropped for backlog
// rows — matching SlaBadge's own demotion, not re-deriving a second opinion.
function severityDisplayLabel(severity: WelfareReportSeverity, historical: boolean): string {
  if (!historical) return welfareReportSeverityLabel(severity);
  const base = SEVERITY_BASE_LABEL[severity] ?? severity;
  return `${base} (histórica)`;
}

// Severity → OpPill tone mapping.
// critical/high → danger, medium → open (warn), low → triaged (blue), unknown → neutral.
const SEVERITY_TONE: Record<WelfareReportSeverity, "danger" | "open" | "triaged" | "neutral"> = {
  critical: "danger",
  high: "danger",
  medium: "open",
  low: "triaged",
};

const STATUS_TONE: Record<
  WelfareReportStatus,
  "open" | "triaged" | "progress" | "closed" | "neutral"
> = {
  open: "open",
  triaged: "triaged",
  in_progress: "progress",
  closed: "closed",
  invalid: "neutral",
  duplicate: "neutral",
};

// C6c workqueue grammar — the row's primary "Actuar" CTA label per
// primaryWelfareAction(status). Kept here (presentation) rather than in the
// domain module, which only owns the state-machine ranking, not Spanish copy.
const PRIMARY_ACTION_LABEL: Record<"triage" | "start" | "close", string> = {
  triage: "Marcar revisada",
  start: "Iniciar seguimiento",
  close: "Cerrar con resolución",
};

// Date vocabulary (queue-anatomy alignment, 2026-07-30): the row used to print
// a RELATIVE "hace N días" built by a private formatter. The dominant operator
// queue anatomy (components/ui/dashboard/CaseQueue.tsx) prints the ABSOLUTE
// record date via formatDate and moves the urgency signal into a pill. This row
// already carries TWO urgency pills — the severity pill and SlaBadge, which
// owns the breached/historical/in-plazo semantic — so the relative label was the
// third, weakest opinion about the same axis, and the one thing no pill said was
// WHEN the denuncia was filed. Converting to formatDate adds that and loses
// nothing.
export type WelfareDenunciaRowProps = {
  report: {
    id: string;
    referenceCode: string;
    kind: string;
    severity: WelfareReportSeverity;
    status: WelfareReportStatus;
    jurisdictionLocality: string | null;
    jurisdictionProvince: string | null;
    /** D.11 (PO, 2026-07-31): TRUE when the geocoder was unreachable and the
     * jurisdiction above was read out of the FORM TEXT. The row is routed on a
     * GUESS. Rendering this is the CONDITION the PO attached to accepting the
     * mis-routing risk — a persisted flag that no screen shows would deliver the
     * risk without the mitigation. Do not "clean up" the pill away. */
    jurisdictionUnverified: boolean;
    createdAt: Date;
    assignedToUserId: string | null;
  };
  /** Resolved display name for report.assignedToUserId — null when there is
   * no assignee, OR when the row can't resolve a name (falls back to "un
   * agente" — mirrors the detail page's assignedToName rationale). Never
   * looked up here: the page batch-resolves names once for the whole list. */
  assignedToName: string | null;
  /** The viewing operator's own id — distinguishes "Mía" from "Asignada a
   * {nombre}" for the SAME assignedToUserId value. */
  currentUserId: string;
};

export function WelfareDenunciaRow({
  report,
  assignedToName,
  currentUserId,
}: WelfareDenunciaRowProps) {
  const severityTone = SEVERITY_TONE[report.severity] ?? "neutral";
  const statusTone = STATUS_TONE[report.status] ?? "neutral";

  const createdAt = new Date(report.createdAt);
  const isHistorical = isHistoricalBacklog(report.status, createdAt);

  // A CRITICAL row is visually escalated with the error tokens (thick danger
  // left edge) so it reads as "peligro inmediato" before any text is parsed.
  const isCritical = report.severity === "critical";

  // C6c workqueue grammar (plan-maestro-integridad.md §C6) — the row states
  // its assignment plainly instead of the old terse "· Asignada" suffix that
  // never said WHO or whether it was the viewer's own case. Pure logic lives
  // in welfare-row-assignment.ts (unit-tested there, no React/mocking needed).
  const isUnassigned = report.assignedToUserId === null;
  const { tone: assignmentTone, label: assignmentLabel } = resolveAssignmentDisplay(
    report.assignedToUserId,
    assignedToName,
    currentUserId,
  );

  // The row's ONE primary next-step verb (triage → en curso → resolución),
  // surfaced as a shortcut into the inspector's Acciones tab. null for
  // terminal statuses — a closed/invalid/duplicate row has no action left.
  const primaryAction = primaryWelfareAction(report.status);
  const detailHref = `/gob/maltrato/${report.referenceCode}`;

  return (
    <li
      className={[
        "overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card",
        isCritical ? "border-l-4 border-l-ln-op-danger" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-stretch">
        <WelfareRowLink
          casoParam={report.referenceCode}
          href={detailHref}
          className="min-w-0 flex-1"
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-md font-medium text-ln-op-ink">
                  {welfareReportKindLabel(report.kind)}
                </p>
                <OpPill tone={severityTone}>
                  {severityDisplayLabel(report.severity, isHistorical)}
                </OpPill>
                {/* SlaBadge (C2 language contract 2026-07-22) OWNS the SLA
                    semantic — it derives breached/historical/in-plazo itself
                    from severity+status+createdAt, so this row can never
                    mislabel a severity TIER as a days-overdue count (the #1
                    trust bug the contract kills). Renders nothing for terminal
                    statuses. */}
                <SlaBadge severity={report.severity} status={report.status} createdAt={createdAt} />
              </div>
              {/* Jurisdiction line. The "sin verificar" pill sits HERE, welded
                  to the claim it qualifies, and not up in the severity/SLA row:
                  that row is the urgency voice, and this is not an urgency
                  statement — it is a warning that the address printed one line
                  below may belong to somebody else's municipality. */}
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ln-op-mute">
                <span>
                  {report.jurisdictionLocality && report.jurisdictionProvince
                    ? `${report.jurisdictionLocality}, ${report.jurisdictionProvince}`
                    : "Sin jurisdicción declarada"}
                  {" · "}
                  <time dateTime={createdAt.toISOString()}>{formatDate(createdAt)}</time>
                </span>
                {report.jurisdictionUnverified && (
                  <>
                    <OpPill tone="open">Jurisdicción sin verificar</OpPill>
                    {/* Same <p>, not a sibling one: the explanation inherits the
                        jurisdiction line's size instead of introducing a third
                        arbitrary pixel size (design-token ratchet). */}
                    <span className="basis-full">
                      No pudimos confirmar la ubicación con el geocodificador: la jurisdicción se
                      tomó del texto de la denuncia y puede no corresponder a este municipio.
                    </span>
                  </>
                )}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <OpCodeBadge tone="blue">{report.referenceCode}</OpCodeBadge>
                <OpPill tone={assignmentTone}>{assignmentLabel}</OpPill>
              </div>
            </div>
            <OpPill tone={statusTone}>{welfareReportStatusLabel(report.status)}</OpPill>
          </div>
        </WelfareRowLink>

        {/* Row-level workqueue actions — SIBLINGS of the row's anchor above,
            never nested inside it (an interactive control nested inside
            another anchor is invalid HTML and breaks screen-reader
            semantics). */}
        {(isUnassigned || primaryAction) && (
          <div className="flex shrink-0 flex-col items-end justify-center gap-1.5 border-l border-ln-op-line px-2.5 py-2">
            {isUnassigned && <TomarButton reportId={report.id} />}
            {primaryAction && (
              <ActuarButton
                casoParam={report.referenceCode}
                href={detailHref}
                label={PRIMARY_ACTION_LABEL[primaryAction]}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}
