// Historic event places from the spine (localidades-por-id D6, design
// "Backfill": place at time t = the pet's home per the spine at t, method
// spine_rederived).
//
// An event recorded before events carried a `place` gets the pet's home AT
// THAT TIME — the latest registration or jurisdiction move up to and
// including the event. The catalogue row comes only from what that spine
// event RECORDED (jurisdiction_locality_id / place.resolved / to_locality_id);
// a home recorded by name alone stays unresolved — never matched to a
// homonym by its name. Events that already have a place row, events that
// carry their own place, and amendments are left alone.

import { describe, expect, it } from "vitest";

import { planHistoricEventPlaces } from "./historic-event-places";

const ev = (
  id: string,
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown> = {},
) => ({ id, eventType, occurredAt, recordedAt: occurredAt, payload });

const registeredInAlberti = ev("reg", "pet_registered", "2026-01-01T00:00:00Z", {
  jurisdiction_province: "Buenos Aires",
  jurisdiction_locality: "Mechita",
  jurisdiction_locality_id: "loc-alberti",
});
const movedToCordobaByName = ev("move", "movement_recorded", "2026-03-01T00:00:00Z", {
  sub_kind: "jurisdiction_changed",
  to_country: "AR",
  to_province: "Córdoba",
  to_locality: "Villa María",
});

describe("planHistoricEventPlaces", () => {
  it("places each event at the home the spine had at that time", () => {
    const events = [
      registeredInAlberti,
      ev("vac1", "vaccination_administered", "2026-02-01T00:00:00Z"),
      movedToCordobaByName,
      ev("vac2", "vaccination_administered", "2026-04-01T00:00:00Z"),
    ];
    const rows = planHistoricEventPlaces("pet-1", events, new Set());
    const byEvent = new Map(rows.map((r) => [r.eventId, r]));

    expect(byEvent.get("vac1")).toEqual({
      eventId: "vac1",
      petId: "pet-1",
      provinceCode: "AR-B",
      localityId: "loc-alberti",
      method: "spine_rederived",
      entered: {
        province: "Buenos Aires",
        locality: "Mechita",
        source: "spine",
        spine_event_id: "reg",
      },
    });
    // The move recorded only a name: the place stays unresolved, never guessed.
    expect(byEvent.get("vac2")).toMatchObject({
      provinceCode: "AR-X",
      localityId: null,
      method: "unresolved",
      entered: {
        province: "Córdoba",
        locality: "Villa María",
        source: "spine",
        spine_event_id: "move",
      },
    });
    // The spine events themselves are placed too (the home they set).
    expect(byEvent.get("reg")?.localityId).toBe("loc-alberti");
  });

  it("skips events already placed, events carrying their own place, and amendments", () => {
    const events = [
      registeredInAlberti,
      ev("own", "incident_reported", "2026-02-01T00:00:00Z", {
        place: { entered: {}, resolved: null },
      }),
      ev("amend", "event_amended", "2026-02-02T00:00:00Z"),
      ev("done", "vaccination_administered", "2026-02-03T00:00:00Z"),
      ev("todo", "vaccination_administered", "2026-02-04T00:00:00Z"),
    ];
    const rows = planHistoricEventPlaces("pet-1", events, new Set(["done", "reg"]));
    expect(rows.map((r) => r.eventId)).toEqual(["todo"]);
  });

  it("an event before any jurisdiction-bearing spine event gets no row", () => {
    const rows = planHistoricEventPlaces(
      "pet-1",
      [ev("early", "vaccination_administered", "2025-12-01T00:00:00Z"), registeredInAlberti],
      new Set(["reg"]),
    );
    expect(rows).toEqual([]);
  });

  it("a spine event that predates the id field is unresolved, not guessed", () => {
    const legacy = ev("reg", "pet_registered", "2026-01-01T00:00:00Z", {
      jurisdiction_province: "Buenos Aires",
      jurisdiction_locality: "Mechita",
    });
    const rows = planHistoricEventPlaces(
      "pet-1",
      [legacy, ev("vac", "vaccination_administered", "2026-02-01T00:00:00Z")],
      new Set(["reg"]),
    );
    expect(rows).toEqual([
      expect.objectContaining({ eventId: "vac", localityId: null, method: "unresolved" }),
    ]);
  });
});
