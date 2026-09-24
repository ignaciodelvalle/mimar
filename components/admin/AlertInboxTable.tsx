// components/admin/AlertInboxTable.tsx — accessible inbox table for /admin/alertas.
//
// Presentational server component. Renders one row per alert_firings record with
// the metric (es-AR label), jurisdiction, observed-vs-threshold, aging
// (antigüedad), a status badge (icon + TEXT, not color alone — WCAG 1.4.1), and
// a breach badge for old `disparada` firings (the outbox breach pattern). The
// per-row triage controls live in the client AlertRowActions island.
//
// A11y: <table> carries a <caption> + every <th scope="col">. The status badge
// pairs an aria-hidden glyph with a visible text label so meaning never depends
// on color alone.

import { AlertRowActions } from "@/app/admin/alertas/AlertRowActions";
import type { AlertFiring, AlertFiringStatus, AlertMetricKey } from "@/db/schema";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { calendarDaysAgoInAr } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const ALERT_METRIC_LABEL: Record<AlertMetricKey, string> = {
  active_zoonosis: KPI_CATALOG.active_zoonosis_signals.label,
  eno_sla_ontime_pct: "SLA ENO en tiempo (%)",
  queue_oldest_days: "Días sin atender (cola)",
  sterilization_coverage_pct: "Cobertura de esterilización (%)",
  microchip_penetration_pct: "Penetración de microchip (%)",
  open_welfare_reports: "Denuncias de maltrato abiertas",
};

const STATUS_LABEL: Record<AlertFiringStatus, string> = {
  disparada: "Disparada",
  reconocida: "Reconocida",
  en_investigacion: "En investigación",
  autoridad_contactada: "Autoridad contactada",
  resuelta: "Resuelta",
  descartada: "Descartada",
};

// Icon reinforces meaning beyond color (WCAG 1.4.1). aria-hidden — the visible
// text label is the accessible name.
//
// DELIBERATE GLYPH EXCEPTION (PO-approved 2026-07-14, UI professionalism pass).
// These six escalation marks encode a *quarter-fill progression* — ▲ (fired) →
// ◔ (¼) → ◑ (½) → ◕ (¾) → ● (full/resolved), with ○ (empty) for discarded. The
// increasing pie-fill communicates triage advancement at a glance, an ordinal
// metaphor that lucide-react has NO equivalent for (its Circle family is not a
// graduated fill set). Substituting stroke icons would lose the progression, so
// these glyphs are whitelisted in the emoji/icon professionalism fence.
const STATUS_ICON: Record<AlertFiringStatus, string> = {
  disparada: "▲",
  reconocida: "◔",
  en_investigacion: "◑",
  autoridad_contactada: "◕",
  resuelta: "●",
  descartada: "○",
};

const STATUS_CLASSES: Record<AlertFiringStatus, string> = {
  disparada: "bg-ln-op-danger-bg text-ln-op-danger border-ln-op-danger-bd",
  reconocida: "bg-ln-op-warn-bg text-ln-op-warn border-ln-op-warn-bd",
  en_investigacion: "bg-ln-op-viol-bg text-ln-op-viol border-ln-op-viol-bd",
  autoridad_contactada: "bg-ln-op-viol-bg text-ln-op-viol border-ln-op-viol-bd",
  resuelta: "bg-ln-op-ok-bg text-ln-op-ok border-ln-op-ok-bd",
  descartada: "bg-ln-op-stripe text-ln-op-mute border-ln-op-line",
};

// A `disparada` firing older than this (days) is in breach of the triage SLA.
const BREACH_DAYS = 3;

function StatusBadge({ status }: { status: AlertFiringStatus }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-[7px] py-0.5",
        "font-ln-mono text-xs font-bold uppercase tracking-[0.06em]",
        STATUS_CLASSES[status],
      ].join(" ")}
    >
      <span aria-hidden="true">{STATUS_ICON[status]}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}

function agingDays(firedAt: Date): number {
  // AR-calendar days, not elapsed-ms floor — an alert fired yesterday evening
  // reads "1 día" this morning, never "hoy" (calendarDaysAgoInAr rationale).
  return calendarDaysAgoInAr(firedAt);
}

function formatAging(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export type AlertInboxRow = AlertFiring;

export function AlertInboxTable({ rows }: { rows: AlertInboxRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-md text-ln-op-mute">
        Sin alertas que coincidan con los filtros seleccionados.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-md text-ln-op-ink">
        <caption className="sr-only">
          Bandeja de alertas sanitarias. Cada fila muestra la métrica, la jurisdicción, el valor
          observado frente al umbral, la antigüedad, el estado del triage y las acciones
          disponibles. Las alertas disparadas con más de {BREACH_DAYS} días se marcan en breach de
          SLA.
        </caption>
        <thead>
          <tr className="border-b border-ln-op-line">
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Métrica
            </th>
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Jurisdicción
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold text-ln-op-mute">
              Observado · Meta
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold text-ln-op-mute">
              Antigüedad
            </th>
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Estado
            </th>
            <th scope="col" className="py-2 text-left font-semibold text-ln-op-mute">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const days = agingDays(row.firedAt);
            const isBreach = row.status === "disparada" && days >= BREACH_DAYS;
            const metricLabel = ALERT_METRIC_LABEL[row.metricKey] ?? row.metricKey;
            const jurisdiction =
              row.jurisdictionProvince && row.jurisdictionLocality
                ? `${row.jurisdictionLocality}, ${row.jurisdictionProvince}`
                : (row.jurisdictionProvince ?? "Nacional");
            return (
              <tr
                key={row.id}
                className="border-b border-ln-op-line last:border-0 align-top hover:bg-ln-op-stripe/40 transition-colors"
              >
                <td className="py-2.5 pr-4">
                  <span className="font-medium text-ln-op-ink">{metricLabel}</span>
                  {row.investigationCode ? (
                    <span className="ml-2 font-ln-mono text-xs text-ln-op-viol">
                      {row.investigationCode}
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 pr-4 text-ln-op-ink-2">{jurisdiction}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {/* "observado al disparo X · meta Y" — explicit framing instead
                      of a bare "X ≤ Y" comparison the operator has to decode (D3).
                      "al disparo" because observed_value is FROZEN when the alert
                      fires (record-firings.ts) while /admin/suscripciones shows
                      the cube's value TODAY: the same CABA sterilization alert
                      read "observado 38" here and "actual 37" there, at the same
                      moment, 34 days apart in meaning (master test CIU, A5). */}
                  <span className="text-ln-op-mute">observado al disparo </span>
                  <span className="font-semibold text-ln-op-ink">
                    {Number(row.observedValue).toLocaleString("es-AR")}
                  </span>
                  <span className="text-ln-op-mute">
                    {" · meta "}
                    {Number(row.threshold).toLocaleString("es-AR")}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  <span
                    className={isBreach ? "font-semibold text-ln-op-danger" : "text-ln-op-mute"}
                  >
                    {formatAging(days)}
                  </span>
                  {isBreach ? (
                    <span
                      className="ml-2 inline-flex items-center gap-[3px] rounded-[var(--radius-sm)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-1.5 py-px font-ln-mono text-xs font-bold uppercase text-ln-op-danger"
                      title={`Sin reconocer hace ${days} días (SLA ${BREACH_DAYS} días)`}
                    >
                      <span aria-hidden="true">!</span>
                      Vencido
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 pr-4">
                  <StatusBadge status={row.status} />
                </td>
                <td className="py-2.5">
                  <AlertRowActions
                    firingId={row.id}
                    status={row.status}
                    metricKey={row.metricKey}
                    hasJurisdiction={Boolean(row.jurisdictionProvince && row.jurisdictionLocality)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
