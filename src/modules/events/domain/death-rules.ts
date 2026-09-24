// Pure domain rules for death-record cross-field validation.
//
// Extracted from app/actions/events.ts — createDeathRecordAction validation
// block. Zero runtime imports (pure domain logic). @/db/schema type-only is
// allowed but not needed here.

import { findDisease } from "@/lib/reference/diseases";
import { isReportable } from "@/lib/reference/diseases";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// RE-EXPORTED FROM THE CONTRACT, not declared twice. The three lists moved to
// `@dim/contract/input` on 2026-09-08 with the `death` kind, because the native
// form has to draw the same options the wire accepts — and two hand-kept copies
// of one vocabulary is how a form comes to offer a cause the server refuses.
//
// THIS MODULE IS STILL THE WRITE-SIDE AUTHORITY. What lives here is the part a
// client may not hold: `validateDeathCrossFields`, which the server runs
// whatever the wire said, and `resolveDeathReportable`, which decides whether a
// health authority hears about a zoonosis. The contract carries the vocabulary;
// the judgement stays here. Same split as the PPP registries three days ago.
export {
  DEATH_CAUSES,
  type DeathCause,
  DISPOSITION_METHODS,
  type DispositionMethod,
  VET_CONTACT_VALUES,
  type VetContactValue,
} from "@dim/contract/input";

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

export type DeathCrossFieldInput = {
  cause: string;
  dispositionMethod: string | null;
  vetContactedOwner: string | null;
  deathAtClinic: boolean;
  clinicName: string | null;
  vetDecidedAlone: boolean;
  diseaseCode: string | null;
  confirmedByLab: boolean;
};

/**
 * Validate the cross-field constraints for a death record.
 * Returns an error string (Spanish) on failure, or null on success.
 *
 * Pure function — no side effects, no DB calls.
 */
export function validateDeathCrossFields(input: DeathCrossFieldInput): string | null {
  const { cause, vetContactedOwner, deathAtClinic, clinicName, vetDecidedAlone, diseaseCode } =
    input;

  // clinicName requires deathAtClinic
  if (clinicName && !deathAtClinic) {
    return "Indicaste un nombre de clínica pero no marcaste que falleció en una veterinaria.";
  }

  // vetContactedOwner requires deathAtClinic
  if (vetContactedOwner && !deathAtClinic) {
    return "El contacto del veterinario solo aplica si falleció en una veterinaria.";
  }

  // vetDecidedAlone requires vetContactedOwner='no'
  if (vetDecidedAlone && vetContactedOwner !== "no") {
    return "Solo se puede marcar 'vet decidió sin contacto' cuando el veterinario no logró contactar al propietario.";
  }

  // Disease-specific rules (only when cause === "disease")
  if (cause === "disease") {
    if (!diseaseCode) {
      return "Falta el código de enfermedad.";
    }
    if (!findDisease(diseaseCode)) {
      return "Enfermedad no reconocida.";
    }
  }

  return null;
}

/**
 * Resolve whether a death is reportable to health authorities.
 * Only diseases with cause="disease" and a known reportable code qualify.
 */
export function resolveDeathReportable(cause: string, diseaseCode: string | null): boolean {
  if (cause !== "disease") return false;
  return isReportable(diseaseCode);
}
