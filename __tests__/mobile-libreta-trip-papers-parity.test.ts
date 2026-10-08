// The libreta draws a run of trip-papers ticks as ONE row on both platforms.
//
// WHY. Ticking a trip's checklist writes one `event_amended` per tick, and an
// afternoon of "Lo tengo" left a column of identical "Papeles del viaje
// actualizados" asientos. Both libretas now collapse consecutive ticks of one
// trip on one day into "Papeles del viaje actualizados · N cambios · <país>" —
// the web in `components/pet-profile/asiento-fields.ts` (keyed on the trip's
// event id) and the app in `apps/mobile/src/pets/libreta-view-model.ts` (keyed
// on the facts the projection puts on the wire, since no id crosses it).
//
// This feeds ONE set of rows through both: the web grouper over the rows, and
// the app grouper over the asientos the SAME projection turns them into — the
// shape `/api/v1/pets/{token}/libreta` hands the app. Equal labels in equal
// order, or one platform has drifted.

import { describe, expect, it } from "vitest";

import {
  TRIP_PAPERS_UPDATED_LABEL,
  collapseTripPaperTicks,
  toAsientoView,
  tripPapersContext,
  tripPapersGroupLabel,
  tripPapersTickKey,
} from "@/components/pet-profile/asiento-fields";
import type { HistorialEventRow } from "@/src/modules/pets/application/tab-data/types";

import type { LibretaEntryV1 } from "@dim/contract/api";
import {
  TRIP_PAPERS_UPDATED_LABEL as APP_TRIP_PAPERS_UPDATED_LABEL,
  groupLedgerEntries,
} from "../apps/mobile/src/pets/libreta-view-model";

const NOW = new Date("2026-07-10T12:00:00Z");
const OWNER = "user-owner";
const VIEWER = { userId: OWNER, currentOwnerUserId: OWNER };

function row(over: Partial<HistorialEventRow>): HistorialEventRow {
  return {
    id: "evt",
    petId: "pet-1",
    eventType: "note_added",
    payload: { text: "Nota" },
    occurredAt: new Date("2026-07-01T15:00:00Z"),
    notes: null,
    recordedByUserId: OWNER,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
    ...over,
  };
}

function trip(id: string, corridor: string): HistorialEventRow {
  return row({
    id,
    eventType: "movement_recorded",
    payload: { sub_kind: "transport_recorded", corridor_id: corridor, travel_date: "2026-11-15" },
    occurredAt: new Date("2026-06-01T15:00:00Z"),
  });
}

function tick(id: string, target: string, occurredAt: string): HistorialEventRow {
  return row({
    id,
    eventType: "event_amended",
    payload: {
      target_event_id: target,
      reason: "Papeles del viaje",
      changes: [{ field: "documents_confirmed", old: [], new: [id] }],
    },
    occurredAt: new Date(occurredAt),
  });
}

/** Newest first, as both libretas order the past. */
const ROWS: HistorialEventRow[] = [
  tick("a4", "trip-cl", "2026-07-03T18:00:00Z"),
  tick("a3", "trip-cl", "2026-07-02T18:00:00Z"),
  tick("a2", "trip-cl", "2026-07-02T17:00:00Z"),
  tick("u1", "trip-uy", "2026-07-02T16:30:00Z"),
  tick("a1", "trip-cl", "2026-07-02T16:00:00Z"),
  tick("a0", "trip-cl", "2026-07-02T15:00:00Z"),
  row({ id: "note-1", occurredAt: new Date("2026-07-01T15:00:00Z") }),
  trip("trip-uy", "uruguay"),
  trip("trip-cl", "chile"),
];

/** The web libreta's drawn titles. */
function webTitles(rows: HistorialEventRow[]): string[] {
  const trips = tripPapersContext(rows);
  return collapseTripPaperTicks(rows, tripPapersTickKey).map((item) => {
    if (item.kind === "single") return toAsientoView(item.entry, "TOK", VIEWER, NOW, trips).title;
    const head = item.entries[0] as HistorialEventRow;
    const target = (head.payload as { target_event_id: string }).target_event_id;
    return tripPapersGroupLabel(item.entries.length, trips.get(target)?.country ?? null);
  });
}

/** The app libreta's drawn titles, over what the API projects for it. */
function appTitles(rows: HistorialEventRow[]): string[] {
  const trips = tripPapersContext(rows);
  const entries = rows.map((r) => {
    const view = toAsientoView(r, "TOK", VIEWER, NOW, trips);
    return {
      eventId: r.id,
      eventType: r.eventType,
      kind: view.kind,
      title: view.title,
      whenAbsolute: view.whenAbsolute,
      facts: view.facts.map((f) => ({
        key: f.key,
        value: f.value,
        missing: f.missing ?? false,
        mono: f.mono ?? false,
      })),
    } as unknown as LibretaEntryV1;
  });
  return groupLedgerEntries(entries).map((item) =>
    item.kind === "papers" ? item.label : item.entry.title,
  );
}

describe("trip papers ticks collapse identically on the web and in the app", () => {
  it("draws the same rows, in the same order, with the same words", () => {
    const expected = [
      // Its own day: a run of one stays a plain asiento.
      "Papeles del viaje actualizados",
      "Papeles del viaje actualizados · 2 cambios · Chile",
      // Another trip in between breaks the run…
      "Papeles del viaje actualizados",
      // …so the same trip's later ticks are a run of their own.
      "Papeles del viaje actualizados · 2 cambios · Chile",
      "Nota",
    ];
    const web = webTitles(ROWS);
    expect(web.slice(0, 5)).toEqual(expected);
    expect(appTitles(ROWS)).toEqual(web);
  });

  it("never merges in the app what the web keeps apart when the trips fell out of the read", () => {
    // A capped read can keep the ticks and lose the trip rows. The web still
    // tells the trips apart by id; the app, with no destination to key on,
    // must not merge them on the day alone.
    const orphans = [
      tick("x2", "trip-a", "2026-07-02T18:00:00Z"),
      tick("y1", "trip-b", "2026-07-02T17:00:00Z"),
      tick("x1", "trip-a", "2026-07-02T16:00:00Z"),
    ];
    expect(webTitles(orphans)).toEqual(Array(3).fill(TRIP_PAPERS_UPDATED_LABEL));
    expect(appTitles(orphans)).toEqual(webTitles(orphans));
  });

  it("the two platforms title a tick with the same words", () => {
    expect(APP_TRIP_PAPERS_UPDATED_LABEL).toBe(TRIP_PAPERS_UPDATED_LABEL);
  });
});
