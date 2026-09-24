import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnListRow } from "@/components/ui/ListRow";
import type { WorkflowItem, WorkflowKind } from "@/lib/analytics/owner-dashboard";
import { AR_TIME_ZONE, calendarDaysAgoInAr } from "@/lib/utils/format";

// CasesWidget — the owner's cases list.
//
// Used on /inicio (open cases, with a "Ver historial →" link) and on
// /cuenta/casos (rendered twice: open + closed/past history). Accepts the
// adapted CaseRow shape; the WorkflowItem→CaseRow adapter is exported here so
// both call sites share one mapping.
//
// Spec: docs/owner-home-plan-2026-05-20.md — v3 revision.

export type CaseRow = {
  /** Unique key for React. */
  id: string;
  /** First line — what happened, with the pet's name. */
  title: string;
  /** Second line — case ref + status. */
  subtitle: string;
  /** Where this row goes on click. Usually `/casos/{publicCode}` or `/mis-mascotas/{token}`. */
  ctaUrl: string;
  /** Open/decision date. Drives "hace X días". */
  since: Date;
  /** Visual tone. */
  severity: "info" | "warning" | "danger" | "success";
  /** Optional case-kind icon (emoji in v1; Icon webfont pending). */
  icon?: string;
};

/** Case-kind → icon name for the Icon component. */
export const WORKFLOW_KIND_ICON: Record<WorkflowKind, string> = {
  pet_lost: "perdida",
  welfare_report_open: "denuncia",
  welfare_report_closed: "denuncia",
  adoption_application_pending: "solicitud",
  adoption_application_resolved: "solicitud",
  foster_proposal_pending: "casa",
  foster_proposal_resolved: "casa",
  custody_transfer_pending: "trato",
  custody_dispute_open: "disputa",
  approval_request_pending: "custodia",
  approval_request_decided: "custodia",
  bite_observation_open: "mordedura",
  dangerous_breed_pending_attestation: "alerta",
  case_generic_open: "nota",
};

/** Adapt a WorkflowItem (lib/owner-dashboard) to a CaseRow for rendering. */
export function adaptWorkflow(w: WorkflowItem): CaseRow {
  return {
    id: w.id,
    title: w.title,
    subtitle: w.subtitle ?? "",
    ctaUrl: w.ctaUrl,
    since: w.since,
    severity: w.severity === "urgent" ? "danger" : w.severity,
    icon: WORKFLOW_KIND_ICON[w.kind],
  };
}

export function CasesWidget({
  cases,
  title = "Mis casos",
  emptyText = "Sin casos abiertos. Cualquier denuncia, postulación o pérdida que empieces va a aparecer acá.",
  historyHref,
}: {
  cases: CaseRow[];
  /** Section heading. */
  title?: string;
  /** Copy shown when there are no cases. */
  emptyText?: string;
  /** When set, renders a "Ver historial →" link in the header. */
  historyHref?: string;
}) {
  const total = cases.length;

  return (
    <section aria-label={title} className="rounded-2xl border border-ln-line bg-ln-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ln-ink">
          {title}
          {total > 0 && (
            <span className="ml-2 text-xs font-normal text-ln-mute">
              · {total} {total === 1 ? "caso" : "casos"}
            </span>
          )}
        </h2>
        {historyHref && (
          <Link
            href={historyHref}
            className="shrink-0 text-xs font-medium text-ln-azul hover:underline"
          >
            Ver historial →
          </Link>
        )}
      </div>

      {cases.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ln-line-strong p-6 text-center text-sm text-ln-mute">
          {emptyText}
        </p>
      ) : (
        <ul className="divide-y divide-ln-line">
          {cases.map((c) => (
            <li key={c.id}>
              <LnListRow
                href={c.ctaUrl}
                className="py-3 transition-colors hover:bg-ln-stripe"
                icon={<CaseIcon severity={c.severity} icon={c.icon} />}
                trailing={
                  <p
                    className="shrink-0 text-sm text-ln-mute"
                    title={c.since.toLocaleString("es-AR", { timeZone: AR_TIME_ZONE })}
                  >
                    {relativeShort(c.since)}
                  </p>
                }
              >
                <p className="truncate text-sm font-medium text-ln-ink">{c.title}</p>
                <p className="mt-0.5 truncate text-xs text-ln-mute">{c.subtitle}</p>
              </LnListRow>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CaseIcon({
  severity,
  icon,
}: {
  severity: CaseRow["severity"];
  icon?: string;
}) {
  const tone =
    severity === "danger"
      ? "bg-[var(--color-ln-err-050)] text-ln-err"
      : severity === "warning"
        ? "bg-[var(--color-ln-warn-050)] text-ln-warn"
        : severity === "success"
          ? "bg-[var(--color-ln-ok-050)] text-ln-ok"
          : "bg-ln-celeste/10 text-ln-azul";
  return (
    <span
      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone}`}
      aria-hidden
    >
      {icon ? <Icon name={icon} size={18} decorative /> : <Icon name="nota" size={18} decorative />}
    </span>
  );
}

function relativeShort(d: Date): string {
  // AR-calendar days, not elapsed-ms floor: 20:00 yesterday viewed at 10:00
  // today must read "ayer", not "hoy" (calendarDaysAgoInAr rationale).
  const days = calendarDaysAgoInAr(d);
  if (days < 1) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} d.`;
  if (days < 365) {
    const m = Math.floor(days / 30);
    return `hace ${m} m.`;
  }
  const y = Math.floor(days / 365);
  return `hace ${y} a.`;
}
