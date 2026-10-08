// "La tengo conmigo" — the plan-B block under the confirmation (P4, design
// approved by the PO 2026-10-07).
//
// PRINCIPLE: reuniting with the family comes first. This block appears only
// AFTER the owner was notified, below that confirmation, and it is visually
// QUIETER than it: a muted panel, no primary button, no "llevar al refugio".
// When the finder said the animal needs a vet urgently, the nearest vets come
// first and the receiving organizations after them.

import type { NearbyHelp } from "@/src/modules/organizations/domain/nearby-help";

import { NearbyFallbackNotice, NearbyOrgList } from "./NearbyOrgList";

export const FINDER_PLAN_B_HEADING = "¿No podés tenerla hasta que la busquen?";
export const FINDER_PLAN_B_INTRO = "Estas organizaciones cercanas reciben animales encontrados.";

export function FinderPlanB({ help, urgent }: { help: NearbyHelp; urgent: boolean }) {
  return (
    <section
      className="space-y-4 rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-paper)] p-4"
      aria-labelledby="finder-plan-b-heading"
      data-testid="finder-plan-b"
    >
      {urgent && (
        <div className="space-y-2" data-testid="finder-plan-b-vets">
          <h2 className="text-sm font-semibold text-[var(--color-ln-ink)]">
            Veterinarias cercanas
          </h2>
          {help.vets.length > 0 ? (
            <NearbyOrgList cards={help.vets} label="Veterinarias cercanas" />
          ) : (
            <p className="text-xs text-[var(--color-ln-mute)]">
              No encontramos veterinarias del directorio cerca. Si necesita atención ya, buscá la
              guardia veterinaria más cercana.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2" data-testid="finder-plan-b-receivers">
        <h2 id="finder-plan-b-heading" className="text-sm font-semibold text-[var(--color-ln-ink)]">
          {FINDER_PLAN_B_HEADING}
        </h2>
        <p className="text-xs text-[var(--color-ln-mute)]">{FINDER_PLAN_B_INTRO}</p>
        {help.receivers.length > 0 ? (
          <NearbyOrgList cards={help.receivers} label="Organizaciones que reciben" />
        ) : (
          help.fallback && <NearbyFallbackNotice fallback={help.fallback} />
        )}
        <p className="text-xs text-[var(--color-ln-faint)]">
          Si podés, seguí cuidándola: su familia ya sabe que está con vos.
        </p>
      </div>
    </section>
  );
}
