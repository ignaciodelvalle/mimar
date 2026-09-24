// TravelObligationsPanel — travel obligations checklist for /viaje
// (movilidad Fase 1, R4.1).
//
// Design D5: a NEW thin panel. It deliberately does NOT widen ObligationKey /
// ComplianceObligationsPanel — those are hard-keyed to the 4 domestic cards
// and requirementLevel must not leak onto them (R4.3).

import { LnBadge } from "@/components/ui/Badge";
import type { RequirementLevel } from "@/lib/domain/travel-strictness";
import type { TravelObligation } from "@/lib/projections/travel-compliance";

const LEVEL_BADGE: Record<
  RequirementLevel,
  { label: string; variant: "danger" | "warning" | "info" }
> = {
  blocker: { label: "Bloqueante", variant: "danger" },
  warning: { label: "Atención", variant: "warning" },
  info: { label: "Informativo", variant: "info" },
};

export type TravelObligationsPanelProps = {
  obligations: TravelObligation[];
};

export function TravelObligationsPanel({ obligations }: TravelObligationsPanelProps) {
  if (obligations.length === 0) {
    return (
      <p className="text-sm text-[var(--color-ln-mute)]">
        Sin requisitos para el contexto de viaje registrado.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {obligations.map((obligation) => {
        const badge = LEVEL_BADGE[obligation.requirementLevel];
        return (
          <li
            key={obligation.key}
            className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{obligation.label}</p>
              <LnBadge variant={badge.variant}>{badge.label}</LnBadge>
            </div>
            <p className="mt-1 text-sm">{obligation.state}</p>
            {obligation.detail && (
              <p className="mt-1 text-sm text-[var(--color-ln-mute)]">{obligation.detail}</p>
            )}
            {obligation.contributingJurisdictions.length > 0 && (
              <p className="mt-1 text-xs text-[var(--color-ln-mute)]">
                Exigido por: {obligation.contributingJurisdictions.join(" · ")}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--color-ln-mute)]">{obligation.legalFootnote}</p>
          </li>
        );
      })}
    </ol>
  );
}
