import { overlayAmendments } from "@/lib/infra/amendment";
import { describe, expect, it } from "vitest";

import { replayPetPregnancy } from "@/lib/projections/pet-pregnancy";
import type { ProjectionEvent } from "@/lib/projections/types";

function ev(
  eventType: string,
  payload: unknown,
  occurredAt = "2026-01-01T00:00:00Z",
): ProjectionEvent {
  return { id: `e-${occurredAt}`, eventType, occurredAt, recordedAt: occurredAt, payload };
}

const preg = (phase: string, extra: Record<string, unknown>, occurredAt: string) =>
  ev(
    "clinical_info_logged",
    { sub_kind: "pregnancy", pregnancy_phase: phase, ...extra },
    occurredAt,
  );

describe("replayPetPregnancy", () => {
  it("returns null with no events", () => {
    expect(replayPetPregnancy(overlayAmendments([]))).toEqual({ pregnancyStatus: null });
  });

  it("started → in_progress", () => {
    expect(
      replayPetPregnancy(overlayAmendments([preg("started", {}, "2026-01-01T00:00:00Z")]))
        .pregnancyStatus,
    ).toBe("in_progress");
  });

  it("ended with an outcome → completed_{outcome}, latest wins", () => {
    const events = [
      preg("started", {}, "2026-01-01T00:00:00Z"),
      preg("ended", { outcome: "live_birth" }, "2026-03-01T00:00:00Z"),
    ];
    expect(replayPetPregnancy(overlayAmendments(events)).pregnancyStatus).toBe(
      "completed_live_birth",
    );
  });

  it("a later pregnancy re-opens the status (multiple pregnancies over a life)", () => {
    const events = [
      preg("ended", { outcome: "live_birth" }, "2026-01-01T00:00:00Z"),
      preg("started", {}, "2026-06-01T00:00:00Z"),
    ];
    expect(replayPetPregnancy(overlayAmendments(events)).pregnancyStatus).toBe("in_progress");
  });

  it("a malformed 'ended' (no outcome) is skipped, not treated as in_progress", () => {
    const events = [
      preg("started", {}, "2026-01-01T00:00:00Z"),
      preg("ended", {}, "2026-03-01T00:00:00Z"),
    ];
    // Falls back to the previous well-formed event (started).
    expect(replayPetPregnancy(overlayAmendments(events)).pregnancyStatus).toBe("in_progress");
  });

  it("ignores clinical_info_logged with a non-pregnancy sub_kind", () => {
    expect(
      replayPetPregnancy(overlayAmendments([ev("clinical_info_logged", { sub_kind: "surgery" })]))
        .pregnancyStatus,
    ).toBeNull();
  });
});
