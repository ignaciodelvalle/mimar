// overlayAmendments — D2 at the read boundary (projection-cron audit
// 2026-07-03 A). Pure unit tests: the helper must project corrected payloads
// + amendedAt over a fetched stream that includes event_amended rows, with
// zero extra queries.

import { describe, expect, it } from "vitest";

import { overlayAmendments } from "./amendment";

type Row = {
  id: string;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

const weight = (id: string, kg: string, at: string): Row => ({
  id,
  eventType: "weight_recorded",
  occurredAt: at,
  payload: { kg },
});

const amendment = (
  id: string,
  targetId: string,
  at: string,
  changes: Array<{ field: string; old: unknown; new: unknown }>,
): Row => ({
  id,
  eventType: "event_amended",
  occurredAt: at,
  payload: { target_event_id: targetId, changes, reason: null },
});

describe("overlayAmendments", () => {
  it("returns rows untouched (amendedAt null) when no amendments exist", () => {
    const rows = [weight("w1", "12.50", "2026-01-01")];
    const out = overlayAmendments(rows);
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ kg: "12.50" });
    expect(out[0].amendedAt).toBeNull();
  });

  it("projects the corrected payload and sets amendedAt on the target", () => {
    const rows = [
      weight("w1", "12.50", "2026-01-01"),
      amendment("a1", "w1", "2026-02-01", [{ field: "kg", old: "12.50", new: "15.00" }]),
    ];
    const out = overlayAmendments(rows);
    const target = out.find((r) => r.id === "w1");
    expect(target?.payload).toEqual({ kg: "15.00" });
    expect(target?.amendedAt).toBe("2026-02-01");
  });

  it("latest amendment wins when several target the same event", () => {
    const rows = [
      weight("w1", "12.50", "2026-01-01"),
      amendment("a1", "w1", "2026-02-01", [{ field: "kg", old: "12.50", new: "13.00" }]),
      amendment("a2", "w1", "2026-03-01", [{ field: "kg", old: "13.00", new: "15.00" }]),
    ];
    const out = overlayAmendments(rows);
    const target = out.find((r) => r.id === "w1");
    expect(target?.payload).toEqual({ kg: "15.00" });
    expect(target?.amendedAt).toBe("2026-03-01");
  });

  // EL-F3: two amendments with the SAME occurred_at must resolve to the newest
  // recorded_at (the SQL-twin "latest"). The old occurred_at-only strict `>`
  // kept whichever landed first in the stream — here the OLDER recorded_at.
  it("same occurredAt: newest recorded_at wins (tiebreaker parity)", () => {
    const rows = [
      weight("w1", "12.50", "2026-01-01"),
      // Older recorded_at, appears FIRST in the stream.
      {
        id: "a1",
        eventType: "event_amended",
        occurredAt: "2026-02-01",
        recordedAt: "2026-02-01T10:00:00Z",
        payload: {
          target_event_id: "w1",
          changes: [{ field: "kg", old: "12.50", new: "13.00" }],
          reason: null,
        },
      },
      // Newer recorded_at, appears SECOND.
      {
        id: "a2",
        eventType: "event_amended",
        occurredAt: "2026-02-01",
        recordedAt: "2026-02-01T12:00:00Z",
        payload: {
          target_event_id: "w1",
          changes: [{ field: "kg", old: "12.50", new: "15.00" }],
          reason: null,
        },
      },
    ];
    const out = overlayAmendments(rows);
    expect(out.find((r) => r.id === "w1")?.payload).toEqual({ kg: "15.00" });
  });

  it("event_amended rows pass through untouched (visible timeline entries)", () => {
    const rows = [
      weight("w1", "12.50", "2026-01-01"),
      amendment("a1", "w1", "2026-02-01", [{ field: "kg", old: "12.50", new: "15.00" }]),
    ];
    const out = overlayAmendments(rows);
    expect(out).toHaveLength(2);
    const correction = out.find((r) => r.id === "a1");
    expect(correction?.eventType).toBe("event_amended");
    expect((correction?.payload as Record<string, unknown>).target_event_id).toBe("w1");
    expect(correction?.amendedAt).toBeNull();
  });

  it("only touches the targeted event; siblings keep their payload", () => {
    const rows = [
      weight("w1", "12.50", "2026-01-01"),
      weight("w2", "13.10", "2026-01-15"),
      amendment("a1", "w1", "2026-02-01", [{ field: "kg", old: "12.50", new: "15.00" }]),
    ];
    const out = overlayAmendments(rows);
    expect(out.find((r) => r.id === "w2")?.payload).toEqual({ kg: "13.10" });
    expect(out.find((r) => r.id === "w2")?.amendedAt).toBeNull();
  });

  it("does not mutate the input rows (pure)", () => {
    const original = weight("w1", "12.50", "2026-01-01");
    const rows = [
      original,
      amendment("a1", "w1", "2026-02-01", [{ field: "kg", old: "12.50", new: "15.00" }]),
    ];
    overlayAmendments(rows);
    expect(original.payload).toEqual({ kg: "12.50" });
  });

  it("amendments with a dangling target are inert", () => {
    const rows = [
      weight("w1", "12.50", "2026-01-01"),
      amendment("a1", "no-such-event", "2026-02-01", [{ field: "kg", old: "x", new: "y" }]),
    ];
    const out = overlayAmendments(rows);
    expect(out.find((r) => r.id === "w1")?.payload).toEqual({ kg: "12.50" });
  });

  // WAVE D1 / finding 27-#11: overlayAmendments is the single read boundary
  // that ALWAYS upcasts, so a payload_version bump can't silently hand a reader
  // a stale-shaped payload. adoption_application_submitted has a registered
  // v1→v2 upcaster (lib/events/event-upcasters.ts) — a v1 row must come out v2.
  it("upcasts non-amendment payloads to the latest schema version", () => {
    const rows: Row[] = [
      {
        id: "app1",
        eventType: "adoption_application_submitted",
        occurredAt: "2026-01-01",
        // v1 shape — motivation / prior_pets absent, version 1.
        payload: { payload_version: 1, housing_type: "departamento" },
      },
    ];
    const out = overlayAmendments(rows);
    const app = out.find((r) => r.id === "app1")?.payload as Record<string, unknown>;
    expect(app.payload_version).toBe(2);
    expect(app.motivation).toBeNull();
    expect(app.prior_pets).toBeNull();
    expect(app.housing_type).toBe("departamento");
  });

  it("applies the correction ON TOP of the upcast payload", () => {
    const rows: Row[] = [
      {
        id: "app1",
        eventType: "adoption_application_submitted",
        occurredAt: "2026-01-01",
        payload: { payload_version: 1, housing_type: "departamento" },
      },
      amendment("a1", "app1", "2026-02-01", [
        { field: "housing_type", old: "departamento", new: "casa" },
      ]),
    ];
    const out = overlayAmendments(rows);
    const app = out.find((r) => r.id === "app1")?.payload as Record<string, unknown>;
    // Upcast keys are present AND the correction won.
    expect(app.payload_version).toBe(2);
    expect(app.motivation).toBeNull();
    expect(app.housing_type).toBe("casa");
  });

  it("multi-field change entries all apply", () => {
    const rows: Row[] = [
      {
        id: "v1",
        eventType: "vaccination_administered",
        occurredAt: "2026-01-01",
        payload: { vaccine_name: "Polivalente", next_due_at: "2027-01-01" },
      },
      amendment("a1", "v1", "2026-02-01", [
        { field: "vaccine_name", old: "Polivalente", new: "Antirrábica" },
        { field: "next_due_at", old: "2027-01-01", new: "2027-02-01" },
      ]),
    ];
    const out = overlayAmendments(rows);
    expect(out.find((r) => r.id === "v1")?.payload).toEqual({
      vaccine_name: "Antirrábica",
      next_due_at: "2027-02-01",
    });
  });
});
