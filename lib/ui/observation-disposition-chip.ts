// Disposal chip for /admin/observaciones rows closed by death.
//
// A "Cerrada por fallecimiento" row used to say nothing about what happened
// to the body — the one fact the authority needs after a death-in-observation
// (an analyzable body vs. a buried one). This helper derives a terse chip from
// the pet's latest death_recorded event:
//
//   - tone "danger" when the disposal is non-recommended (owner_burial /
//     household_waste) AND the death event carries during_rabies_observation:
//     true — the first consumer of that payload flag. Both conditions are
//     required: without the flag (older rows, back-compat optional in the
//     schema) we cannot honestly claim the death happened inside the
//     observation window, so the chip stays neutral.
//   - tone "neutral" otherwise (compliant channel, or unknowable).
//   - null when the row is not completed_dead or no death event was found —
//     no chip is rendered at all.
//
// Pure function — no DB, no React — so the danger/neutral contract is
// unit-testable without fixtures.

import { isNonRecommendedDisposition } from "@/lib/domain/disposition";
import { dispositionMethodLabel } from "@/lib/utils/format";

export type ObservationDeathFacts = {
  /** payload.disposition_method of the latest death_recorded event, if any. */
  dispositionMethod: string | null;
  /** payload.during_rabies_observation === true on that event. */
  duringRabiesObservation: boolean;
};

export type ObservationDispositionChip = {
  label: string;
  tone: "danger" | "neutral";
};

export function observationDispositionChip(
  status: string,
  death: ObservationDeathFacts | null,
): ObservationDispositionChip | null {
  if (status !== "completed_dead" || !death) return null;
  return {
    // null method → "Sin especificar" (same label the 'unknown' enum value
    // gets) rather than the dispositionMethodLabel(null) em-dash, which reads
    // as a rendering glitch in a chip.
    label: dispositionMethodLabel(death.dispositionMethod ?? "unknown"),
    tone:
      isNonRecommendedDisposition(death.dispositionMethod) && death.duringRabiesObservation
        ? "danger"
        : "neutral",
  };
}
