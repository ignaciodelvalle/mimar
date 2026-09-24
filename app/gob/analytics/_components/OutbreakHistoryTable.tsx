// Plain server component -- receives pre-fetched rows from the page.

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpPill } from "@/components/ui/dashboard";
import type { OutbreakHistoryRow } from "@/lib/analytics/govt-dashboards";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";

type Props = {
  rows: OutbreakHistoryRow[];
  /**
   * (disease, locality, province) groups withheld by k-anon — from
   * `fetchOutbreakHistory`'s own result, never recomputed here.
   *
   * REQUIRED, not optional-with-a-default (RA-3 C3): a table that can render
   * without knowing what it is hiding will eventually be mounted by a caller
   * that forgot, and then it publishes an all-clear it never measured. The type
   * error is the point.
   */
  suppressedCount: number;
};

export function OutbreakHistoryTable({ rows, suppressedCount }: Props) {
  if (rows.length === 0 && suppressedCount > 0) {
    // Everything in scope is a sub-k group. "Sin brotes registrados" would be
    // the WRONG empty state here — it reads as "nothing happened" when the
    // measured truth is "something happened and we are not allowed to say
    // where". Two different absences, two different sentences.
    return (
      <LnEmptyState
        icon="eye-off"
        nature="no-signal"
        title="Historial protegido por privacidad"
        description={`Hay brotes registrados en tu cobertura, pero todos los agrupamientos (enfermedad · localidad) tienen menos de ${ANONYMITY_K} señales y se ocultan por k-anonimato. Ampliá la cobertura o el nivel de agregación para verlos.`}
      />
    );
  }

  if (rows.length === 0) {
    // C4 (2026-07-22, §S4): a historical outbreak row is built from the same
    // signal-reporting pipeline as the live signal panels — "no history"
    // reads as "nothing bad ever happened" when the honest read is "nobody
    // ever reported one". no-signal, not "all clear".
    return (
      <LnEmptyState
        icon="eye-off"
        nature="no-signal"
        title="Sin brotes registrados en miMAR"
        description="La ausencia de registro no implica ausencia de brotes históricos — depende de que se haya reportado una señal en tu cobertura."
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-ln-op-line">
        <table className="min-w-full text-md">
          <caption className="sr-only">
            Historial de brotes por enfermedad, localidad y período
          </caption>
          <thead className="bg-ln-op-stripe">
            <tr className="text-left text-sm uppercase tracking-wider text-ln-op-mute">
              <th scope="col" className="px-4 py-2">
                Enfermedad
              </th>
              <th scope="col" className="px-3 py-2">
                Localidad
              </th>
              <th scope="col" className="px-3 py-2">
                Provincia
              </th>
              <th scope="col" className="px-3 py-2">
                Pico
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Señales
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ln-op-line-2">
            {rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: filas de historico sin ID unico; posicion es suficiente
              <tr key={i} className="odd:bg-ln-op-stripe">
                <td className="px-4 py-2">
                  <OpPill tone="open">{row.diseaseName}</OpPill>
                </td>
                <td className="px-3 py-2 text-ln-op-ink">{row.locality || "—"}</td>
                <td className="px-3 py-2 text-ln-op-ink">{row.province || "—"}</td>
                <td className="px-3 py-2 text-ln-op-mute tabular-nums">
                  {/* peakDate is a date_trunc('day') UTC bucket (midnight-UTC
                    ISO) — pin UTC so the label names the bucket's own calendar
                    day; an ambient- or AR-zone render shifts it a day back. */}
                  {new Date(row.peakDate).toLocaleDateString("es-AR", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    timeZone: "UTC",
                  })}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-ln-op-ink">
                  {row.totalSignals}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The disclosure travels WITH the data, inside the component, so no
          caller can render the table without it. The card header carries the
          COUNT (same shape as the vet-access card on this page); this line
          carries the RULE. */}
      <p className="text-xs text-ln-op-mute">
        {suppressedCount > 0
          ? `${suppressedCount} ${suppressedCount === 1 ? "agrupamiento oculto" : "agrupamientos ocultos"} (enfermedad · localidad) con menos de ${ANONYMITY_K} señales — se ocultan por k-anonimato y no están en esta tabla.`
          : `Los agrupamientos (enfermedad · localidad) con menos de ${ANONYMITY_K} señales se ocultan por k-anonimato. En esta cobertura no hay ninguno.`}
      </p>
    </div>
  );
}
