// Projection: derive the adoption-eligibility block on `pets` from the event log.
//
// Eligibility is set via adoption_eligibility_set events (spec
// foster-volunteers-pool §17). Both the single-pet path
// (AdoptionRepository.setEligibility) and the bulk path
// (bulkSetEligibilityAction) dual-write the same five columns with an
// identically-shaped payload, so the LATEST event is the binding fact:
//
//   eligible                      ← payload.eligible
//   ineligibleReason              ← payload.ineligible_reason         (null when eligible)
//   ineligibleReasonNotes         ← payload.ineligible_reason_notes   (null when eligible)
//   ineligibleUntil (ISO string)  ← payload.ineligible_until          (null when eligible)
//   eligibilitySetAt              ← event.recordedAt (witness that the event landed)
//
// NOT derived here: adoptionEligibilitySetByUserId. It maps to the event's
// recordedByUserId, but that can be null for system/stub writes; setAt is the
// safe witness, so the harness compares setAt and excludes the by-user column.
//
// null block when no adoption_eligibility_set event exists.
//
// Pure function. Caller orders events ascending by (occurredAt, recordedAt, id).

import type { ProjectionEvent } from "./types";

export type PetAdoptionEligibilityProjection = {
  adoptionEligible: boolean | null;
  adoptionIneligibleReason: string | null;
  adoptionIneligibleReasonNotes: string | null;
  // ISO timestamp string (or null). Compared as an instant by the harness.
  adoptionIneligibleUntil: string | null;
  // ISO timestamp string of the event that set eligibility (or null).
  adoptionEligibilitySetAt: string | null;
};

const EMPTY: PetAdoptionEligibilityProjection = {
  adoptionEligible: null,
  adoptionIneligibleReason: null,
  adoptionIneligibleReasonNotes: null,
  adoptionIneligibleUntil: null,
  adoptionEligibilitySetAt: null,
};

export function replayPetAdoptionEligibility(
  events: ProjectionEvent[],
): PetAdoptionEligibilityProjection {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType !== "adoption_eligibility_set") continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.eligible !== "boolean") continue; // malformed; skip

    const eligible = payload.eligible;
    return {
      adoptionEligible: eligible,
      adoptionIneligibleReason: eligible ? null : strOrNull(payload.ineligible_reason),
      adoptionIneligibleReasonNotes: eligible ? null : strOrNull(payload.ineligible_reason_notes),
      adoptionIneligibleUntil: eligible ? null : strOrNull(payload.ineligible_until),
      adoptionEligibilitySetAt: toIso(e.recordedAt),
    };
  }
  return EMPTY;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toIso(value: Date | string): string | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
