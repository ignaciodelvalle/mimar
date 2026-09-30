// TravelSemaforo — the one loud element on /viaje (viajes-fase-2, design D5).
//
// rojo = any blocker; amarillo = warnings, no blocker; verde = nothing pending
// was detected; sin_datos = no corridor could be resolved, so nothing was
// checked (derived upstream by deriveTravelCompliance, never here).
//
// The labels live in lib/domain/travel-copy.ts, shared with the v1 payload the
// native screen draws. None of them promises: the green one says what was
// checked ("Sin pendientes detectados"), never that the animal may board.
//
// R3.5/S13: this surface ALWAYS shows, per corridor, the corridor version +
// effectiveFrom and the staleness disclaimer. The disclaimer is not optional
// styling — it is the mechanism that keeps this a copilot, not an
// authoritative source.

import { TRAVEL_SEMAFORO_LABELS } from "@/lib/domain/travel-copy";
import type {
  CorridorDisclosure,
  TravelSemaforo as Semaforo,
} from "@/lib/projections/travel-compliance";
import { TRAVEL_DISCLAIMER } from "@/lib/reference/cross-border-corridors";

const SEMAFORO_TONE: Record<Semaforo, string> = {
  rojo: "bg-[var(--color-ln-err-050)] text-[var(--color-ln-err)] border-[var(--color-ln-err-100)] border-l-[var(--color-ln-err)]",
  amarillo:
    "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)] border-[var(--color-ln-warn-100)] border-l-[var(--color-ln-warn)]",
  verde:
    "bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)] border-[var(--color-ln-ok-100)] border-l-[var(--color-ln-ok)]",
  sin_datos:
    "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)] border-[var(--color-ln-line-strong)] border-l-[var(--color-ln-mute)]",
};

export type TravelSemaforoProps = {
  semaforo: Semaforo;
  corridors: CorridorDisclosure[];
  /** The trip this reading is for, e.g. "Chile, 12/11/2026 · LATAM en cabina". */
  tripSummary?: string | null;
};

export function TravelSemaforo({ semaforo, corridors, tripSummary }: TravelSemaforoProps) {
  return (
    <section aria-label="Semáforo de viaje" className="flex flex-col gap-3">
      <div
        className={`rounded-[var(--radius-sm)] border border-l-[6px] px-4 py-3.5 ${SEMAFORO_TONE[semaforo]}`}
      >
        {tripSummary && <p className="text-sm text-[var(--color-ln-ink-2)]">{tripSummary}</p>}
        <output className="mt-0.5 block text-lg font-semibold leading-snug">
          {TRAVEL_SEMAFORO_LABELS[semaforo]}
        </output>
      </div>
      {corridors.length > 0 && (
        <ul className="space-y-1">
          {corridors.map((corridor) => (
            <li key={corridor.id} className="text-xs text-[var(--color-ln-mute)]">
              {corridor.label}: reglas v{corridor.version}, vigentes desde {corridor.effectiveFrom}.{" "}
              <a
                href={corridor.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Fuente oficial
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-[var(--color-ln-mute)]">{TRAVEL_DISCLAIMER}</p>
    </section>
  );
}
