// ---------------------------------------------------------------------------
// Public credential banners — the three page-local notices the public /p page
// renders above the credential body.
//
// Extracted from page.tsx (T6 review fix pass, 2026-08-16): the page crossed
// the 1500-line file-size ratchet. These three are pure presentational
// components with no data access, no props from the loader beyond two booleans
// and the conditions array — the cheapest coherent seam in the file.
// ---------------------------------------------------------------------------

import {
  type PermanentCondition,
  isPermanentCondition,
  permanentConditionShortLabel,
} from "@/lib/reference/permanent-conditions";

// ---------------------------------------------------------------------------
// ServiceDogBanner — Ley 26.858 access notice (LN tone)
// ---------------------------------------------------------------------------

export function ServiceDogBanner({ rabiesAtRisk }: { rabiesAtRisk: boolean }) {
  return (
    <section
      aria-label="Banner de acceso — perro de asistencia"
      className="mb-4 rounded-[var(--radius-sm)] border border-ln-celeste-100 border-l-[3px] border-l-ln-azul bg-ln-celeste-050 px-4 py-3.5"
    >
      <p className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-azul">
        Perro de Asistencia
      </p>
      <p className="mb-1.5 font-ln-serif text-md font-semibold leading-[1.45] text-ln-ink">
        Esta persona tiene derecho a ingresar, deambular y permanecer con su perro en este
        establecimiento, espacio privado de acceso público y transporte público.
      </p>
      <p className="text-sm text-ln-ink-2">
        Marco legal: <strong className="text-ln-ink">Arts. 1 y 7, Ley 26.858</strong> · Reg. Decreto
        792/2019 · Credencial RUPGA vigente (Res. ANDIS 2588/2022).
      </p>
      {rabiesAtRisk && (
        <p className="mt-2.5 border-t border-ln-celeste-100 pt-2.5 text-sm text-ln-warn">
          Aviso: la vacunación antirrábica figura vencida en el registro. La credencial requiere
          mantener la vacunación al día (Art. 8, Ley 26.858).
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// RabiesObservationBanner — open antirrábica observation (public safety)
// ---------------------------------------------------------------------------
//
// Public-safe, PII-free signal shown to anyone scanning the QR while the pet is
// under an open rabies observation (Decreto 4669/1973 PBA, Ord. CABA 41.831).
// A vecino who was bitten, or who sees the animal, must know it is under formal
// observation and whom to contact. No owner data, no bite details — just the
// state and the safety instruction.
//
// TWO STATES, TWO REGISTERS (2026-08-17). The window is no longer closed by a
// cron writing "negativo" with no clinical author, so an observation can sit
// past its deadline with nothing asserted about the animal. That must not read
// as an ongoing danger (it is not one) nor as an all-clear (nobody gave one):
//   · running  → alert register, "activa", warn palette.
//   · expired  → informational register, neutral palette, states the two facts
//                that are true (the period ended; no professional closed it) and
//                nothing else.
// The period length is deliberately NOT quoted here: this component has no
// access to the jurisdiction's resolved window, and "10 días" was wrong for
// every jurisdiction running 14.
export function RabiesObservationBanner({ windowExpired = false }: { windowExpired?: boolean }) {
  if (windowExpired) {
    return (
      <section
        aria-label="Aviso — observación antirrábica vencida sin cierre profesional"
        className="mb-4 rounded-[var(--radius-sm)] border border-ln-line-strong border-l-[3px] border-l-ln-azul bg-ln-celeste-050 px-4 py-3"
      >
        <p className="mb-1 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-azul">
          Observación antirrábica
        </p>
        <p className="m-0 text-md font-semibold text-ln-ink">
          El período de observación terminó y todavía no hay un cierre profesional registrado.
        </p>
        <p className="mt-1 text-sm text-ln-mute">
          El registro no afirma ningún resultado: solo un veterinario matriculado o la autoridad
          sanitaria puede cerrarla. Si te mordió o tuviste contacto, comunicate con la autoridad
          sanitaria o el centro antirrábico de tu localidad.
        </p>
      </section>
    );
  }

  return (
    <section
      role="alert"
      aria-label="Aviso — mascota en observación antirrábica"
      className="mb-4 rounded-[var(--radius-sm)] border border-ln-warn-100 border-l-[3px] border-l-ln-warn bg-ln-warn-050 px-4 py-3"
    >
      <p className="mb-1 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-warn">
        Observación antirrábica
      </p>
      <p className="m-0 text-md font-semibold text-ln-ink">
        Esta mascota está en observación antirrábica activa.
      </p>
      <p className="mt-1 text-sm text-ln-mute">
        Si te mordió o tuviste contacto, comunicate con la autoridad sanitaria o el centro
        antirrábico de tu localidad.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PermanentConditionsBanner — special-needs chips (LN tone)
// ---------------------------------------------------------------------------

export function PermanentConditionsBanner({
  codes,
  other,
}: {
  codes: string[];
  other: string | null;
}) {
  const safe: PermanentCondition[] = codes.filter(isPermanentCondition);
  if (safe.length === 0) return null;
  const hasOther = safe.includes("otra");
  return (
    <section className="mb-4 rounded-[var(--radius-sm)] border border-ln-celeste-100 border-l-[3px] border-l-ln-azul bg-ln-celeste-050 px-4 py-3">
      <p className="mb-2 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-azul">
        Necesidades especiales
      </p>
      <div className="flex flex-wrap gap-1.5">
        {safe.map((code) => (
          <span
            key={code}
            className="inline-flex rounded-full bg-ln-azul px-2.5 py-1 text-sm font-semibold text-white"
          >
            {permanentConditionShortLabel(code)}
          </span>
        ))}
      </div>
      {hasOther && other && <p className="mt-1.5 text-sm text-ln-ink-2">{other}</p>}
    </section>
  );
}
