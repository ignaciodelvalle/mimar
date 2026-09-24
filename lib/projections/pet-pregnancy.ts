// Projection: derive `pets.pregnancyStatus` from the event log.
//
// Pregnancy is modelled as paired clinical_info_logged events with
// payload.sub_kind='pregnancy' (spec 2026-05-19-pregnancy-tracking-design):
//   - pregnancy_phase='started' → status 'in_progress'
//   - pregnancy_phase='ended'   → status 'completed_{outcome}'
//     where outcome ∈ live_birth | stillbirth | miscarriage | termination | unknown
//
// The writers (recordPregnancyStartedWriter / recordPregnancyEndedWriter in
// app/actions/pregnancy.ts) dual-write the matching pets.pregnancy_status.
// A pet can go through multiple pregnancies over its life, so the LATEST
// pregnancy event (started or ended) determines the current status.
//
// null when no pregnancy event exists.
//
// Pure function. Caller orders events ascending by (occurredAt, recordedAt, id).

import type { AmendmentOverlaid, ProjectionEvent } from "./types";

export type PetPregnancyProjection = {
  pregnancyStatus: string | null;
};

export function replayPetPregnancy(
  events: AmendmentOverlaid<ProjectionEvent>,
): PetPregnancyProjection {
  // Iterate from the end so the first pregnancy-relevant match is the latest.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType !== "clinical_info_logged") continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (payload.sub_kind !== "pregnancy") continue;

    const phase = payload.pregnancy_phase;
    if (phase === "started") {
      return { pregnancyStatus: "in_progress" };
    }
    if (phase === "ended") {
      const outcome = typeof payload.outcome === "string" ? payload.outcome : null;
      // CHECK constraint pets_pregnancy_status_valid only permits these four
      // terminal states. The writer maps outcome='unknown' to
      // 'completed_unknown' — but the column CHECK rejects it, so in practice
      // 'unknown' never reaches the cache. We still derive it faithfully so a
      // mismatch (cache holds something else) is surfaced rather than hidden.
      //
      // An 'ended' event with a missing/non-string outcome is malformed: do
      // NOT fall back to 'in_progress' (that would invent a pregnancy); keep
      // scanning backwards for the previous well-formed event instead.
      if (outcome) {
        return { pregnancyStatus: `completed_${outcome}` };
      }
    }
    // A pregnancy event with an unexpected phase is malformed; keep scanning
    // backwards for the previous well-formed one.
  }
  return { pregnancyStatus: null };
}
