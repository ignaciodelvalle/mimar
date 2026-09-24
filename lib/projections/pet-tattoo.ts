// Projection: derive the tattoo block on `pets` from the event log.
//
// LATEST tattoo_recorded event wins. Unlike microchip (earliest-wins, a chip is
// a permanent implant), a tattoo can be re-recorded with corrected data; the
// writer (createTattooForUser in app/actions/tattoo.ts) overwrites the pets
// columns on every record, so the latest event is the binding fact.
//
// tattooRecordedAt is null unless payload.tattoo_date_known is true — mirroring
// the writer, which stores `recorded_at` (the date the user supplied) only when
// the date was actually known, and otherwise defaults occurredAt to `now`.
//
// Pure function. Caller orders events ascending by (occurredAt, recordedAt, id).

import type { ProjectionEvent } from "./types";

export type PetTattooProjection = {
  tattooCode: string | null;
  tattooLocation: string | null;
  tattooDescription: string | null;
  tattooRecordedAt: string | null;
  tattooRecordedBy: string | null;
};

const EMPTY: PetTattooProjection = {
  tattooCode: null,
  tattooLocation: null,
  tattooDescription: null,
  tattooRecordedAt: null,
  tattooRecordedBy: null,
};

export function replayPetTattoo(events: ProjectionEvent[]): PetTattooProjection {
  // Iterate from the end so the first match is the latest event.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType !== "tattoo_recorded") continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const code = strOrNull(payload.tattoo_code);
    if (!code) continue; // a tattoo event with no code is malformed; skip
    const dateKnown = payload.tattoo_date_known === true;
    return {
      tattooCode: code,
      tattooLocation: strOrNull(payload.location_on_body),
      tattooDescription: strOrNull(payload.description),
      // The writer stores the user-supplied `recorded_at` (already a YYYY-MM-DD
      // string) when the date was known; otherwise null.
      tattooRecordedAt: dateKnown ? strOrNull(payload.recorded_at) : null,
      tattooRecordedBy: strOrNull(payload.recorded_by),
    };
  }
  return EMPTY;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
