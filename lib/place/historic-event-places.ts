// Historic event places from the spine — localidades-por-id D6 (design
// "Backfill": place at time t = pet home per spine at t, method
// spine_rederived).
//
// event_places (0250) is written by trigger for every event that carries a
// `place`. Events recorded before that — most of the history — have no row,
// so an id-keyed count cannot see them. This plans their rows from the spine
// itself: for each such event, the latest jurisdiction-bearing event up to and
// including it (a registration or a jurisdiction move — the same rule and the
// same functions rederivePetCache uses) is the pet's home at that time.
//
// P1, never a guess: the catalogue row is only what that spine event
// RECORDED (jurisdiction_locality_id, place.resolved.locality_id,
// to_locality_id). A home recorded by name alone — or before the id field
// existed — gives an UNRESOLVED row (locality_id NULL, method 'unresolved')
// that reaches only its province; its name is kept in `entered`, never matched
// to a catalogue row. P2: the events themselves are never touched.
//
// Corrections are folded HERE (overlayAmendments), on every prefix, with the
// whole stream's amendments: an amendment says what an event always was, so a
// correction recorded after an event still governs where that event happened.
//
// Pure. The writer is scripts/place-backfill-event-places.ts.

import { overlayAmendments } from "@/lib/infra/amendment";
import { replayPetJurisdiction, replayPetLocalityId } from "@/lib/projections/pet-jurisdiction";
import type { ProjectionEvent } from "@/lib/projections/types";
import { provinceByName } from "@/lib/reference/ar-provincias";

export type HistoricEventPlace = {
  eventId: string;
  petId: string;
  provinceCode: string | null;
  localityId: string | null;
  method: "spine_rederived" | "unresolved";
  entered: {
    province: string | null;
    locality: string | null;
    source: "spine";
    spine_event_id: string;
  };
};

/** Event kinds that describe a correction, not something that happened somewhere. */
const NOT_A_HAPPENING = new Set(["event_amended"]);

function spineEventId(events: readonly ProjectionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as ProjectionEvent;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (e.eventType === "pet_registered") return e.id;
    if (e.eventType === "movement_recorded" && payload.sub_kind === "jurisdiction_changed") {
      return e.id;
    }
  }
  return null;
}

/**
 * Rows for `events` (one pet's RAW stream, ascending by occurredAt,
 * recordedAt, id — amendments included, not yet overlaid) that have none yet.
 */
export function planHistoricEventPlaces(
  petId: string,
  events: readonly ProjectionEvent[],
  alreadyPlaced: ReadonlySet<string>,
): HistoricEventPlace[] {
  const rows: HistoricEventPlace[] = [];
  const amendments = events.filter((e) => e.eventType === "event_amended");
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ProjectionEvent;
    if (alreadyPlaced.has(e.id) || NOT_A_HAPPENING.has(e.eventType)) continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if ("place" in payload) continue; // the trigger's job, from the event's own place
    // The home as of this event, every correction folded (amendments pass
    // through overlayAmendments untouched and no replay reads them).
    const prefix = overlayAmendments([
      ...events.slice(0, i + 1).filter((x) => x.eventType !== "event_amended"),
      ...amendments,
    ]);
    const home = replayPetJurisdiction(prefix);
    const spineId = spineEventId(prefix);
    if (!home || !spineId) continue; // no spine yet: nothing honest to say
    const recorded = replayPetLocalityId(prefix);
    const localityId = recorded?.localityId ?? null;
    rows.push({
      eventId: e.id,
      petId,
      provinceCode: provinceByName(home.jurisdictionProvince)?.code ?? null,
      localityId,
      method: localityId ? "spine_rederived" : "unresolved",
      entered: {
        province: home.jurisdictionProvince,
        locality: home.jurisdictionLocality,
        source: "spine",
        spine_event_id: spineId,
      },
    });
  }
  return rows;
}
