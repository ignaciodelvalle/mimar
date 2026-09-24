// Replay the caretaker arrangements of a pet from the event spine.
//
// Pure. Hand-built event arrays, no DB — the same shape as the nine sibling
// projections in this directory. What it produces is a list of INTERVALS, which
// is why this could not be folded into rederivePetCache: that harness compares
// a single `pets` row column by column, and an arrangement is a set of rows
// with a lifecycle.

import { describe, expect, it } from "vitest";

import { replayPetCaretakers } from "./pet-caretaker";
import type { ProjectionEvent } from "./types";

let seq = 0;

function designated(
  grantId: string,
  caretakerUserId: string,
  occurredAt: string,
  extra: Record<string, unknown> = {},
): ProjectionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    eventType: "caretaker_designated",
    occurredAt: new Date(occurredAt),
    recordedAt: new Date(occurredAt),
    payload: {
      payload_version: 1,
      grant_id: grantId,
      grant_public_token: `CG-${grantId}`,
      caretaker_user_id: caretakerUserId,
      ends_at: "2026-09-15T00:00:00.000Z",
      note: null,
      ...extra,
    },
  };
}

function ended(grantId: string, occurredAt: string, outcome = "expired"): ProjectionEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    eventType: "caretaker_ended",
    occurredAt: new Date(occurredAt),
    recordedAt: new Date(occurredAt),
    payload: {
      payload_version: 1,
      grant_id: grantId,
      outcome,
      ends_at: "2026-09-15T00:00:00.000Z",
    },
  };
}

describe("replayPetCaretakers", () => {
  it("returns nothing for a pet that never had a caretaker", () => {
    expect(replayPetCaretakers([])).toEqual([]);
  });

  it("ignores every event type that is not a caretaker event", () => {
    const noise: ProjectionEvent[] = [
      {
        id: "e-noise",
        eventType: "vaccination_administered",
        occurredAt: new Date("2026-08-01"),
        recordedAt: new Date("2026-08-01"),
        payload: { grant_id: "g-1" },
      },
    ];

    expect(replayPetCaretakers(noise)).toEqual([]);
  });

  it("projects an OPEN interval from a designation with no ending", () => {
    const intervals = replayPetCaretakers([designated("g-1", "u-ana", "2026-08-21T10:00:00Z")]);

    expect(intervals).toEqual([
      {
        grantId: "g-1",
        caretakerUserId: "u-ana",
        startedAt: new Date("2026-08-21T10:00:00Z"),
        endedAt: null,
        outcome: null,
      },
    ]);
  });

  it("closes the interval when the matching caretaker_ended arrives", () => {
    const intervals = replayPetCaretakers([
      designated("g-1", "u-ana", "2026-08-21T10:00:00Z"),
      ended("g-1", "2026-09-16T04:00:00Z", "expired"),
    ]);

    expect(intervals).toEqual([
      {
        grantId: "g-1",
        caretakerUserId: "u-ana",
        startedAt: new Date("2026-08-21T10:00:00Z"),
        endedAt: new Date("2026-09-16T04:00:00Z"),
        outcome: "expired",
      },
    ]);
  });

  it("keeps every arrangement a pet has ever had, in start order", () => {
    const intervals = replayPetCaretakers([
      designated("g-1", "u-ana", "2026-03-01T00:00:00Z"),
      ended("g-1", "2026-04-01T00:00:00Z", "returned"),
      designated("g-2", "u-juan", "2026-08-21T10:00:00Z"),
    ]);

    expect(intervals.map((i) => i.grantId)).toEqual(["g-1", "g-2"]);
    expect(intervals[0].endedAt).toEqual(new Date("2026-04-01T00:00:00Z"));
    expect(intervals[1].endedAt).toBeNull();
  });

  it("sorts by start time even when the events arrive out of order", () => {
    // Events are ordered by the CALLER in every sibling projection, but this
    // one is compared against a set of rows, so a stable order is part of the
    // contract rather than a convenience.
    const intervals = replayPetCaretakers([
      designated("g-2", "u-juan", "2026-08-21T10:00:00Z"),
      designated("g-1", "u-ana", "2026-03-01T00:00:00Z"),
    ]);

    expect(intervals.map((i) => i.grantId)).toEqual(["g-1", "g-2"]);
  });

  it("matches the ending to its OWN grant, not to the latest open one", () => {
    // Two arrangements cannot overlap today (a partial unique index forbids
    // it), but matching on `grant_id` rather than on recency is what keeps this
    // projection correct if that ever changes — and, more immediately, if the
    // events are replayed out of order.
    const intervals = replayPetCaretakers([
      designated("g-1", "u-ana", "2026-03-01T00:00:00Z"),
      designated("g-2", "u-juan", "2026-08-21T10:00:00Z"),
      ended("g-1", "2026-04-01T00:00:00Z", "returned"),
    ]);

    const byGrant = Object.fromEntries(intervals.map((i) => [i.grantId, i]));
    expect(byGrant["g-1"].endedAt).toEqual(new Date("2026-04-01T00:00:00Z"));
    expect(byGrant["g-2"].endedAt).toBeNull();
  });

  it("ignores an ending whose grant was never designated", () => {
    // A `caretaker_ended` with no matching designation is a hole in the spine,
    // not an interval. Inventing a zero-length arrangement for it would make
    // the drift harness report a phantom row instead of the missing event.
    expect(replayPetCaretakers([ended("g-orphan", "2026-09-16T04:00:00Z")])).toEqual([]);
  });

  it("keeps the FIRST ending when a grant is somehow ended twice", () => {
    // The spine is append-only, so a correction is a second event rather than
    // an edit. For an interval, the moment access actually stopped is the first
    // one; a later duplicate cannot move it back.
    const intervals = replayPetCaretakers([
      designated("g-1", "u-ana", "2026-08-21T10:00:00Z"),
      ended("g-1", "2026-09-01T00:00:00Z", "revoked_by_owner"),
      ended("g-1", "2026-09-16T04:00:00Z", "expired"),
    ]);

    expect(intervals).toHaveLength(1);
    expect(intervals[0].endedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(intervals[0].outcome).toBe("revoked_by_owner");
  });

  it("skips a designation with no grant_id or no caretaker_user_id", () => {
    // Both are required by the Zod schema, so this is unreachable through the
    // app. It is handled rather than crashed on because the drift harness runs
    // over historical rows, and a projection that throws on one bad row makes
    // the whole sweep useless.
    const malformed: ProjectionEvent[] = [
      { ...designated("g-1", "u-ana", "2026-08-21T10:00:00Z"), payload: { grant_id: "g-1" } },
      {
        ...designated("g-2", "u-ana", "2026-08-21T10:00:00Z"),
        payload: { caretaker_user_id: "u" },
      },
    ];

    expect(replayPetCaretakers(malformed)).toEqual([]);
  });

  it("accepts ISO strings as well as Date objects for occurredAt", () => {
    const intervals = replayPetCaretakers([
      { ...designated("g-1", "u-ana", "2026-08-21T10:00:00Z"), occurredAt: "2026-08-21T10:00:00Z" },
    ]);

    expect(intervals[0].startedAt).toEqual(new Date("2026-08-21T10:00:00Z"));
  });
});
