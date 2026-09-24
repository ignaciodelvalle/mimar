import { describe, expect, it } from "vitest";

import { replayPetStatus } from "@/lib/projections/pet-status";
import type { ProjectionEvent } from "@/lib/projections/types";

function ev(
  eventType: string,
  payload: unknown,
  occurredAt = "2026-01-01T00:00:00Z",
): ProjectionEvent {
  return { id: `e-${occurredAt}`, eventType, occurredAt, recordedAt: occurredAt, payload };
}

const statusChange = (to: string, occurredAt: string) =>
  ev("status_changed", { to_status: to }, occurredAt);

describe("replayPetStatus", () => {
  it("defaults to active with no events", () => {
    expect(replayPetStatus([])).toEqual({ status: "active", deceasedAt: null });
  });

  it("latest status_changed wins", () => {
    const events = [
      statusChange("lost", "2026-01-01T00:00:00Z"),
      statusChange("active", "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetStatus(events).status).toBe("active");
  });

  it("returns lost when the latest status_changed is lost", () => {
    const events = [
      statusChange("active", "2026-01-01T00:00:00Z"),
      statusChange("lost", "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetStatus(events).status).toBe("lost");
  });

  it("death_recorded is terminal — deceased even if a later status_changed exists", () => {
    const events = [
      ev("death_recorded", { cause: "x" }, "2026-03-01T00:00:00Z"),
      statusChange("active", "2026-04-01T00:00:00Z"),
    ];
    const result = replayPetStatus(events);
    expect(result.status).toBe("deceased");
    expect(result.deceasedAt).toEqual(new Date("2026-03-01T00:00:00Z"));
  });

  it("ignores an unrecognized to_status and falls back to the previous valid one", () => {
    const events = [
      statusChange("lost", "2026-01-01T00:00:00Z"),
      statusChange("banana", "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetStatus(events).status).toBe("lost");
  });

  it("ignores unrelated events", () => {
    expect(replayPetStatus([ev("weight_recorded", { kg: "10" })]).status).toBe("active");
  });
});
