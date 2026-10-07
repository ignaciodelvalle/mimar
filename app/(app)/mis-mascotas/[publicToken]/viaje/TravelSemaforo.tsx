// TravelSemaforo — the one loud element on /viaje (viajes-fase-2, design D5;
// v14 "Viaje en pasos": the PASE).
//
// rojo = any blocker; amarillo = warnings, no blocker; verde = nothing pending
// was detected; sin_datos = no corridor could be resolved, so nothing was
// checked (derived upstream by deriveTravelCompliance, never here).
//
// THE PASE (v14). Given `pass`, the semáforo sits under a band in the
// credential's blue: the destination, the countdown and the day, then the
// semáforo strip with its 6px edge. The countdown is date arithmetic, never a
// verdict; the label is the server's, verbatim; the tally under it counts the
// server's `requirementLevel` (trip-screen.ts).
//
// The labels live in lib/domain/travel-copy.ts, shared with the v1 payload the
// native screen draws. None of them promises: the green one says what was
// checked ("Sin pendientes detectados"), never that the animal may board.
//
// R3.5/S13: this surface ALWAYS shows, per corridor, the corridor version +
// effectiveFrom and the staleness disclaimer — ONCE per screen, here (v14: the
// screen no longer repeats it). The disclaimer is not optional styling — it is
// the mechanism that keeps this a copilot, not an authoritative source.

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

/** The band over the semáforo (v14). */
export type TravelPass = {
  /** "Chile". */
  destination: string;
  /** "faltan 39 días", "sale mañana", "viajó el 15/11". */
  countdown: string;
  /** "Domingo 15/11/2026 · LATAM, en cabina". */
  meta: string;
  /** "3 cosas por resolver · 2 ya están". */
  tally: string;
  /** A trip already behind today draws in grey. */
  past: boolean;
};

export type TravelSemaforoProps = {
  semaforo: Semaforo;
  corridors: CorridorDisclosure[];
  /** The trip this reading is for, e.g. "Chile, 12/11/2026 · LATAM en cabina". */
  tripSummary?: string | null;
  /** v14: the pase band. Without it, the plain strip. */
  pass?: TravelPass | null;
  /** "Verificá con tu aerolínea: LATAM" — only when the trip names an airline. */
  airlineNotice?: string | null;
};

function PassBand({ pass }: { pass: TravelPass }) {
  const ground = pass.past
    ? "bg-[var(--color-ln-mute)]"
    : "bg-gradient-to-br from-[var(--color-ln-azul-900)] to-[var(--color-ln-azul)]";
  return (
    <div className={`flex flex-col gap-1 px-5 py-4 text-white ${ground}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-ln-serif text-2xl font-semibold leading-tight">{pass.destination}</p>
        <span className="whitespace-nowrap rounded-[var(--radius-xs)] border border-white/30 bg-white/15 px-1.5 py-1 font-ln-mono text-sm">
          {pass.countdown}
        </span>
      </div>
      <p className="text-sm text-[var(--color-ln-celeste-100)]">{pass.meta}</p>
    </div>
  );
}

export function TravelSemaforo({
  semaforo,
  corridors,
  tripSummary,
  pass,
  airlineNotice,
}: TravelSemaforoProps) {
  const strip = (
    <div className={`border-l-[6px] px-4 py-3.5 ${SEMAFORO_TONE[semaforo]}`}>
      {!pass && tripSummary && (
        <p className="text-sm text-[var(--color-ln-ink-2)]">{tripSummary}</p>
      )}
      <output className="mt-0.5 block text-lg font-semibold leading-snug">
        {TRAVEL_SEMAFORO_LABELS[semaforo]}
      </output>
      {pass && <p className="text-sm text-[var(--color-ln-ink-2)]">{pass.tally}</p>}
    </div>
  );
  return (
    <section aria-label="Semáforo de viaje" className="flex flex-col gap-2">
      {pass ? (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
          <PassBand pass={pass} />
          {strip}
        </div>
      ) : (
        <div className={`rounded-[var(--radius-sm)] border ${SEMAFORO_TONE[semaforo]}`}>
          {strip}
        </div>
      )}
      <p className="text-xs text-[var(--color-ln-mute)]">{TRAVEL_DISCLAIMER}</p>
      {airlineNotice && <p className="text-xs text-[var(--color-ln-warn)]">{airlineNotice}</p>}
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
    </section>
  );
}
