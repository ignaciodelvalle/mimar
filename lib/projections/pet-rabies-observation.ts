// Projection: derive `pets.rabiesObservationStatus` from the event log.
//
// The 10-day rabies observation lifecycle (Decreto 4669/1973 PBA, etc.) is
// driven by two event types:
//   - rabies_observation_started → status 'in_progress'
//   - rabies_observation_ended   → status 'completed_{...}' via outcomeToStatus
//     (negative | positive_rabies | dead | lost_to_followup)
//
// All three writer paths dual-write pets.rabies_observation_status:
//   - reportBite / reportBiteFromOrg          → in_progress (started)
//   - owner/professional close-observation    → ended (outcomeToStatus)
//   - death_recorded CASCADE C                → ALSO emits rabies_observation_ended
//     (outcome=dead) before flipping to completed_dead, so death-during-
//     observation is fully event-derivable.
//
// A pet can be bitten more than once over its life, so the CHRONOLOGICALLY LAST
// observation event (started or ended) determines the current cache value.
//
// null when no observation event exists.
//
// ---------------------------------------------------------------------------
// `window_expired_unclosed` IS NOT DERIVED HERE — ON PURPOSE
// ---------------------------------------------------------------------------
// Since 2026-08-17 the daily sweep moves an observation whose statutory window
// elapsed with no professional closure to `window_expired_unclosed` (see
// src/modules/surveillance/domain/rabies-observation.ts for why that state
// exists). No event is written, because nothing happened: the state is
// `rabies_observation_started` + `observation_until` + the passage of time.
//
// This projection stays CLOCKLESS and keeps returning `in_progress` for that
// stream. Reading the wall clock here would make the drift harness report every
// pet whose deadline passed between the sweep's runs — a false alarm on a
// self-healing lag — and would make a pure replay non-deterministic.
//
// The two sides are reconciled in the harness instead: lib/infra/rederive-pet-
// cache.ts compares this column with the "observationStatus" CompareKind, which
// accepts a stored `window_expired_unclosed` against a derived `in_progress`
// (the stored value is a TIME REFINEMENT of the derived one) and treats every
// other disagreement as drift.
//
// Pure function. Caller orders events ascending by (occurredAt, recordedAt, id).

import { outcomeToStatus } from "@/src/modules/surveillance/domain/rabies-observation";
import type { RabiesObservationOutcome } from "@/src/modules/surveillance/domain/rabies-observation";
import type { ProjectionEvent } from "./types";

export type PetRabiesObservationProjection = {
  rabiesObservationStatus: string | null;
};

const VALID_OUTCOMES: readonly RabiesObservationOutcome[] = [
  "negative",
  "positive_rabies",
  "dead",
  "lost_to_followup",
];

export function replayPetRabiesObservation(
  events: ProjectionEvent[],
): PetRabiesObservationProjection {
  // Iterate from the end so the first observation-relevant match is the latest.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType === "rabies_observation_started") {
      return { rabiesObservationStatus: "in_progress" };
    }
    if (e.eventType === "rabies_observation_ended") {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const outcome = payload.outcome;
      if (typeof outcome === "string" && (VALID_OUTCOMES as readonly string[]).includes(outcome)) {
        return {
          rabiesObservationStatus: outcomeToStatus(outcome as RabiesObservationOutcome),
        };
      }
      // Malformed ended event (no/invalid outcome) — keep scanning backwards.
    }
  }
  return { rabiesObservationStatus: null };
}
