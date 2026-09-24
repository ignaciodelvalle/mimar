// TravelSemaforo — traffic-light summary for /viaje (movilidad Fase 1).
//
// rojo = any blocker; amarillo = warnings, no blocker; verde = all clear;
// sin_datos = no corridor could be resolved for a foreign destination on
// record, so nothing was actually checked (R4.1, S9 — derived upstream by
// deriveTravelCompliance, never here).
//
// R3.5/S13: this surface ALWAYS shows, per corridor, the corridor version +
// effectiveFrom and the staleness disclaimer. The disclaimer is not optional
// styling — it is the mechanism that keeps this a copilot, not an
// authoritative source.
//
// Lives next to the route (not components/pet-profile/) — new thin component
// per design D5; it reuses LN tokens only.

import type {
  CorridorDisclosure,
  TravelSemaforo as Semaforo,
} from "@/lib/projections/travel-compliance";
import { TRAVEL_DISCLAIMER } from "@/lib/reference/cross-border-corridors";

const SEMAFORO_STYLES: Record<Semaforo, { label: string; className: string }> = {
  rojo: {
    label: "No viajar todavía",
    className:
      "bg-[var(--color-ln-err-050)] text-[var(--color-ln-err)] border-[var(--color-ln-err-100)]",
  },
  amarillo: {
    label: "Revisar pendientes",
    className:
      "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)] border-[var(--color-ln-warn-100)]",
  },
  verde: {
    label: "Requisitos en orden",
    className:
      "bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)] border-[var(--color-ln-ok-100)]",
  },
  // A foreign destination is on record but no corridor could be resolved for
  // it — neither red/yellow/green applies because nothing was actually
  // checked. Never render green off zero obligations (QA histórico
  // 2026-07-08 item 3).
  sin_datos: {
    label: "Verificación no disponible",
    className:
      "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)] border-[var(--color-ln-line-strong)]",
  },
};

export type TravelSemaforoProps = {
  semaforo: Semaforo;
  corridors: CorridorDisclosure[];
};

export function TravelSemaforo({ semaforo, corridors }: TravelSemaforoProps) {
  const style = SEMAFORO_STYLES[semaforo];
  return (
    <section aria-label="Semáforo de viaje">
      <output
        className={`inline-flex items-center gap-2 rounded-[var(--radius-sm)] border px-4 py-2 font-ln-mono text-sm font-semibold uppercase tracking-[.08em] ${style.className}`}
      >
        {style.label}
      </output>
      {corridors.length > 0 && (
        <ul className="mt-3 space-y-1">
          {corridors.map((corridor) => (
            <li key={corridor.id} className="text-xs text-[var(--color-ln-mute)]">
              {corridor.label} · reglas v{corridor.version} · vigencia desde{" "}
              {corridor.effectiveFrom} ·{" "}
              <a
                href={corridor.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                fuente oficial
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-[var(--color-ln-mute)]">{TRAVEL_DISCLAIMER}</p>
    </section>
  );
}
