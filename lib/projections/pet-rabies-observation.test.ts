import { describe, expect, it } from "vitest";

import { replayPetRabiesObservation } from "@/lib/projections/pet-rabies-observation";
import type { ProjectionEvent } from "@/lib/projections/types";
import { outcomeToStatus } from "@/src/modules/surveillance/domain/rabies-observation";

function ev(
  eventType: string,
  payload: unknown,
  occurredAt = "2026-01-01T00:00:00Z",
): ProjectionEvent {
  return { id: `e-${occurredAt}`, eventType, occurredAt, recordedAt: occurredAt, payload };
}

describe("replayPetRabiesObservation", () => {
  it("returns null with no events", () => {
    expect(replayPetRabiesObservation([])).toEqual({ rabiesObservationStatus: null });
  });

  it("started → in_progress", () => {
    expect(
      replayPetRabiesObservation([ev("rabies_observation_started", {})]).rabiesObservationStatus,
    ).toBe("in_progress");
  });

  it("ended with a valid outcome → outcomeToStatus(outcome), latest wins", () => {
    const events = [
      ev("rabies_observation_started", {}, "2026-01-01T00:00:00Z"),
      ev("rabies_observation_ended", { outcome: "negative" }, "2026-01-11T00:00:00Z"),
    ];
    expect(replayPetRabiesObservation(events).rabiesObservationStatus).toBe(
      outcomeToStatus("negative"),
    );
  });

  it("a later observation re-opens the status (a pet can be bitten more than once)", () => {
    const events = [
      ev("rabies_observation_ended", { outcome: "negative" }, "2026-01-11T00:00:00Z"),
      ev("rabies_observation_started", {}, "2026-06-01T00:00:00Z"),
    ];
    expect(replayPetRabiesObservation(events).rabiesObservationStatus).toBe("in_progress");
  });

  it("a malformed ended (invalid/missing outcome) is skipped", () => {
    const events = [
      ev("rabies_observation_started", {}, "2026-01-01T00:00:00Z"),
      ev("rabies_observation_ended", { outcome: "banana" }, "2026-01-11T00:00:00Z"),
    ];
    expect(replayPetRabiesObservation(events).rabiesObservationStatus).toBe("in_progress");
  });

  it("ignores unrelated events", () => {
    expect(
      replayPetRabiesObservation([ev("weight_recorded", { kg: "10" })]).rabiesObservationStatus,
    ).toBeNull();
  });
});
