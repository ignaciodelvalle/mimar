// ---------------------------------------------------------------------------
// TurnoAntirrabicaSheet — owner "compliance-first" slice (WS-2, 2026-07-01)
// Spec: dim-interno:docs/superpowers-private/specs/2026-07-01-owner-compliance-first-slice-handoff.md §3
//
// Intent fork opened from the antirrábica compliance card (?sheet=turno-antirrabica,
// mounted by SheetMounter). Two options routing into EXISTING machinery:
//   1. Reserve a vet appointment (recommended) → /turnos/buscar?service_kind=vaccination_rabies
//   2. Just remind me → /mis-mascotas/[token]/vacunas/programar
//
// Pet pre-selection in the booking flow is a deferred follow-up (the booking
// form does not accept a pet yet); the owner picks the pet in the existing
// select. Touch targets ≥44px via min-h-11 (Ley 26.653 / WCAG 2.1 AA).
// ---------------------------------------------------------------------------

import { LnLinkButton } from "@/components/ui/LinkButton";

export function TurnoAntirrabicaSheet({ petToken }: { petToken: string }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="font-ln-sans text-sm text-[var(--color-ln-ink-2)]">
        ¿Cómo querés ponerte al día con la vacuna antirrábica?
      </p>

      <LnLinkButton
        href="/turnos/buscar?service_kind=vaccination_rabies"
        shape="block"
        subtitle="Recomendado · agenda la aplicación"
      >
        Reservar turno con un veterinario
      </LnLinkButton>

      <LnLinkButton
        href={`/mis-mascotas/${petToken}/vacunas/programar`}
        shape="block"
        fill="outline"
      >
        Solo recordármelo
      </LnLinkButton>

      <p className="font-ln-sans text-xs text-[var(--color-ln-faint)]">
        Un recordatorio solo te avisa; no reemplaza la vacuna ni pone la obligación al día.
      </p>
    </div>
  );
}
