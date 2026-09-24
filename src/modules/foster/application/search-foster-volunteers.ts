// Use-case: search foster volunteers (read, org side).
//
// Migrated from app/actions/foster-proposals.ts::searchFosterVolunteers.
// Auth (foster.assign capability) is handled by the caller (thin action).
//
// Filters active+slots>0 by optional province/locality/species.
// Optional match scoring vs a concrete pet shape.
// Sort: matchScore desc → slots desc → acceptedCount desc.
// Returns rows ≤ limit (default 50, clamped 1..200).

import { ageMonthsFromDob, computeMatch } from "@/src/modules/foster/domain/matching-rules";
import type { FosterRepository } from "../infrastructure/foster-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Deps = {
  repo: typeof FosterRepository;
};

export type SearchFosterVolunteersInput = {
  province?: string | null;
  locality?: string | null;
  species?: "dog" | "cat" | "other";
  /** When provided, scores match warnings against this pet shape. */
  petShape?: {
    species: string;
    estimatedWeightKg?: number | null;
    dateOfBirth?: Date | null;
    isPpp: boolean;
  } | null;
  proposedDurationWeeks?: number | null;
  limit?: number;
};

export type FosterVolunteerSearchRow = {
  userId: string;
  displayName: string;
  availableSlots: number;
  acceptedCount: number;
  matchScore: number | null;
  matchWarnings: string[];
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function searchFosterVolunteers(
  input: SearchFosterVolunteersInput,
  deps: Deps,
): Promise<UseCaseResult<{ rows: FosterVolunteerSearchRow[] }>> {
  const { repo } = deps;

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  // Fetch volunteer rows from repo.
  const rawVolunteers = await repo.searchVolunteers(
    {
      province: input.province ?? null,
      locality: input.locality ?? null,
      species: input.species,
    },
    limit,
  );

  // Fetch accepted counts for experience sorting.
  const countMap = await repo.acceptedCountsByVolunteer();

  // Build result rows (optionally scored against pet shape).
  const rows: FosterVolunteerSearchRow[] = rawVolunteers.map((volunteer) => {
    let matchScore: number | null = null;
    let matchWarnings: string[] = [];

    if (input.petShape) {
      const matchPet = {
        species: input.petShape.species,
        estimatedWeightKg:
          input.petShape.estimatedWeightKg != null
            ? Number(input.petShape.estimatedWeightKg)
            : null,
        ageMonths: ageMonthsFromDob(input.petShape.dateOfBirth ?? null),
        isPpp: input.petShape.isPpp,
        hasChronic: false,
      };
      const m = computeMatch(matchPet, volunteer, input.proposedDurationWeeks ?? null);
      matchScore = m.score;
      matchWarnings = m.warnings.map((w) => w.message);
    }

    return {
      userId: volunteer.userId,
      displayName: (volunteer as { displayName?: string }).displayName ?? "",
      availableSlots: volunteer.availableSlots,
      acceptedCount: countMap.get(volunteer.userId) ?? 0,
      matchScore,
      matchWarnings,
      jurisdictionProvince: volunteer.jurisdictionProvince,
      jurisdictionLocality: volunteer.jurisdictionLocality,
    };
  });

  // Sort: matchScore desc → slots desc → acceptedCount desc.
  rows.sort((a, b) => {
    if (a.matchScore != null && b.matchScore != null && a.matchScore !== b.matchScore) {
      return b.matchScore - a.matchScore;
    }
    if (a.availableSlots !== b.availableSlots) return b.availableSlots - a.availableSlots;
    return b.acceptedCount - a.acceptedCount;
  });

  return { ok: true, value: { rows }, notifications: [] };
}
