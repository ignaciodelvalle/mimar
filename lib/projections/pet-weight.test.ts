import { overlayAmendments } from "@/lib/infra/amendment";
import { describe, expect, it } from "vitest";

import { replayPetWeight } from "@/lib/projections/pet-weight";
import type { ProjectionEvent } from "@/lib/projections/types";

function ev(
  eventType: string,
  payload: unknown,
  occurredAt = "2026-01-01T00:00:00Z",
): ProjectionEvent {
  return { id: `e-${occurredAt}`, eventType, occurredAt, recordedAt: occurredAt, payload };
}

describe("replayPetWeight", () => {
  it("returns null with no events", () => {
    expect(replayPetWeight(overlayAmendments([]))).toEqual({ estimatedWeightKg: null });
  });

  it("returns the LATEST weight (string payload preserved as-is)", () => {
    const events = [
      ev("weight_recorded", { kg: "10.0" }, "2026-01-01T00:00:00Z"),
      ev("weight_recorded", { kg: "12.5" }, "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBe("12.5");
  });

  it("coerces a numeric kg to its string form", () => {
    expect(
      replayPetWeight(overlayAmendments([ev("weight_recorded", { kg: 8 })])).estimatedWeightKg,
    ).toBe("8");
  });

  it("ignores non-weight events and malformed kg", () => {
    const events = [
      ev("vaccination_administered", { vaccine_name: "x" }),
      ev("weight_recorded", { kg: "" }),
    ];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBeNull();
  });

  // --- register / profile weight are derivable too (Invariant #3) -----------

  it("derives the registration weight from pet_registered.estimated_weight_kg", () => {
    const events = [ev("pet_registered", { estimated_weight_kg: "5.5" })];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBe("5.5");
  });

  it("treats a registration with no weight (null) as no weight", () => {
    const events = [ev("pet_registered", { estimated_weight_kg: null })];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBeNull();
  });

  it("derives a profile-edit weight correction (latest-wins over registration)", () => {
    const events = [
      ev("pet_registered", { estimated_weight_kg: "5.5" }, "2026-01-01T00:00:00Z"),
      ev(
        "pet_profile_updated",
        {
          changes: [
            { field: "name", old: "A", new: "B" },
            { field: "estimated_weight_kg", old: "5.5", new: "7.2" },
          ],
        },
        "2026-02-01T00:00:00Z",
      ),
    ];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBe("7.2");
  });

  it("a later weight_recorded wins over an earlier profile-edit weight", () => {
    const events = [
      ev(
        "pet_profile_updated",
        { changes: [{ field: "estimated_weight_kg", old: null, new: "7.2" }] },
        "2026-01-01T00:00:00Z",
      ),
      ev("weight_recorded", { kg: "8.0" }, "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBe("8.0");
  });

  it("a profile edit that does not touch weight preserves the prior weight", () => {
    const events = [
      ev("weight_recorded", { kg: "8.0" }, "2026-01-01T00:00:00Z"),
      ev(
        "pet_profile_updated",
        { changes: [{ field: "color", old: "brown", new: "black" }] },
        "2026-02-01T00:00:00Z",
      ),
    ];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBe("8.0");
  });

  it("a profile edit that clears the weight (new=null) wins as null", () => {
    const events = [
      ev("weight_recorded", { kg: "8.0" }, "2026-01-01T00:00:00Z"),
      ev(
        "pet_profile_updated",
        { changes: [{ field: "estimated_weight_kg", old: "8.0", new: null }] },
        "2026-02-01T00:00:00Z",
      ),
    ];
    expect(replayPetWeight(overlayAmendments(events)).estimatedWeightKg).toBeNull();
  });
});
