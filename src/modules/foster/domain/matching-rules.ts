// Foster matching — pure scoring helper for the volunteer pool (spec
// foster-volunteers-pool v1.4 §11). Moved from lib/foster-matching.ts;
// no logic changes. A re-export shim in lib/foster-matching.ts keeps
// existing callers (tests + foster-proposals.ts) working until WU-4
// repoints them.
//
// Pure function: no DB access. Caller supplies the pet shape.

import type { FosterVolunteer } from "@/db/schema";
import { pluralizeEs } from "@/lib/utils/format";

export type MatchWarning = {
  kind:
    | "species_mismatch"
    | "size_mismatch"
    | "age_mismatch"
    | "health_mismatch"
    | "ppp_mismatch"
    | "duration_mismatch";
  message: string;
};

export type MatchScoreResult = {
  score: number;
  warnings: MatchWarning[];
};

export type MatchPet = {
  species: string;
  estimatedWeightKg?: number | null;
  ageMonths?: number | null;
  isPpp: boolean;
  hasChronic?: boolean;
};

export function computeMatch(
  pet: MatchPet,
  volunteer: Pick<
    FosterVolunteer,
    | "acceptsDogs"
    | "acceptsCats"
    | "acceptsOtherSpecies"
    | "acceptsSizeSmall"
    | "acceptsSizeMedium"
    | "acceptsSizeLarge"
    | "acceptsPuppies"
    | "acceptsSeniors"
    | "acceptsChronicConditions"
    | "acceptsDangerousBreeds"
    | "maxDurationWeeks"
  >,
  proposedDurationWeeks?: number | null,
): MatchScoreResult {
  const warnings: MatchWarning[] = [];
  let score = 100;

  const speciesLower = pet.species.toLowerCase();
  if (speciesLower === "dog") {
    if (!volunteer.acceptsDogs) {
      warnings.push({ kind: "species_mismatch", message: "El voluntario no acepta perros." });
      score -= 30;
    }
  } else if (speciesLower === "cat") {
    if (!volunteer.acceptsCats) {
      warnings.push({ kind: "species_mismatch", message: "El voluntario no acepta gatos." });
      score -= 30;
    }
  } else {
    if (!volunteer.acceptsOtherSpecies) {
      warnings.push({
        kind: "species_mismatch",
        message: "El voluntario no acepta otras especies.",
      });
      score -= 30;
    }
  }

  if (speciesLower === "dog" && pet.estimatedWeightKg != null) {
    const w = pet.estimatedWeightKg;
    if (w > 25 && !volunteer.acceptsSizeLarge) {
      warnings.push({
        kind: "size_mismatch",
        message: `El voluntario no acepta tamaño grande (${w}kg).`,
      });
      score -= 15;
    } else if (w >= 10 && w <= 25 && !volunteer.acceptsSizeMedium) {
      warnings.push({
        kind: "size_mismatch",
        message: `El voluntario no acepta tamaño medio (${w}kg).`,
      });
      score -= 15;
    } else if (w < 10 && !volunteer.acceptsSizeSmall) {
      warnings.push({
        kind: "size_mismatch",
        message: `El voluntario no acepta tamaño chico (${w}kg).`,
      });
      score -= 15;
    }
  }

  if (pet.ageMonths != null) {
    if (pet.ageMonths < 4 && !volunteer.acceptsPuppies) {
      warnings.push({
        kind: "age_mismatch",
        message: "El voluntario no acepta cachorros (menos de 4 meses).",
      });
      score -= 15;
    } else if (pet.ageMonths > 84 && !volunteer.acceptsSeniors) {
      warnings.push({
        kind: "age_mismatch",
        message: "El voluntario no acepta seniors (más de 7 años).",
      });
      score -= 10;
    }
  }

  if (pet.hasChronic === true && !volunteer.acceptsChronicConditions) {
    warnings.push({
      kind: "health_mismatch",
      message: "El voluntario no acepta animales con condiciones crónicas.",
    });
    score -= 15;
  }

  if (pet.isPpp && !volunteer.acceptsDangerousBreeds) {
    warnings.push({
      kind: "ppp_mismatch",
      message: "El voluntario no marcó aceptar razas PPP.",
    });
    score -= 20;
  }

  if (
    proposedDurationWeeks != null &&
    volunteer.maxDurationWeeks != null &&
    proposedDurationWeeks > volunteer.maxDurationWeeks
  ) {
    warnings.push({
      kind: "duration_mismatch",
      message: `Duración propuesta (${proposedDurationWeeks} ${pluralizeEs(proposedDurationWeeks, "semana")}) excede el máximo del voluntario (${volunteer.maxDurationWeeks} ${pluralizeEs(volunteer.maxDurationWeeks, "semana")}).`,
    });
    score -= 10;
  }

  return { score: Math.max(0, score), warnings };
}

export function ageMonthsFromDob(
  dob: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (dob == null) return null;
  const date = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return null;
  const days = diffMs / (1000 * 60 * 60 * 24);
  return Math.floor(days / 30.4375);
}
