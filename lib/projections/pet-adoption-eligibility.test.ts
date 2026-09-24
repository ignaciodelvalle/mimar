import { describe, expect, it } from "vitest";

import { replayPetAdoptionEligibility } from "@/lib/projections/pet-adoption-eligibility";
import type { ProjectionEvent } from "@/lib/projections/types";

function ev(payload: unknown, occurredAt = "2026-01-01T00:00:00Z"): ProjectionEvent {
  return {
    id: `e-${occurredAt}`,
    eventType: "adoption_eligibility_set",
    occurredAt,
    recordedAt: occurredAt,
    payload,
  };
}

describe("replayPetAdoptionEligibility", () => {
  it("returns EMPTY with no events", () => {
    expect(replayPetAdoptionEligibility([])).toEqual({
      adoptionEligible: null,
      adoptionIneligibleReason: null,
      adoptionIneligibleReasonNotes: null,
      adoptionIneligibleUntil: null,
      adoptionEligibilitySetAt: null,
    });
  });

  it("eligible=true clears the ineligible fields and stamps setAt", () => {
    const p = replayPetAdoptionEligibility([
      ev({ eligible: true, ineligible_reason: "medical" }, "2026-02-01T00:00:00Z"),
    ]);
    expect(p.adoptionEligible).toBe(true);
    expect(p.adoptionIneligibleReason).toBeNull();
    expect(p.adoptionEligibilitySetAt).toBe(new Date("2026-02-01T00:00:00Z").toISOString());
  });

  it("eligible=false surfaces reason / notes / until", () => {
    const p = replayPetAdoptionEligibility([
      ev({
        eligible: false,
        ineligible_reason: "medical",
        ineligible_reason_notes: "en tratamiento",
        ineligible_until: "2026-09-01",
      }),
    ]);
    expect(p.adoptionEligible).toBe(false);
    expect(p.adoptionIneligibleReason).toBe("medical");
    expect(p.adoptionIneligibleReasonNotes).toBe("en tratamiento");
    expect(p.adoptionIneligibleUntil).toBe("2026-09-01");
  });

  it("LATEST event wins", () => {
    const p = replayPetAdoptionEligibility([
      ev({ eligible: false, ineligible_reason: "medical" }, "2026-01-01T00:00:00Z"),
      ev({ eligible: true }, "2026-03-01T00:00:00Z"),
    ]);
    expect(p.adoptionEligible).toBe(true);
  });

  it("skips a malformed event whose eligible is not a boolean", () => {
    const p = replayPetAdoptionEligibility([
      ev({ eligible: true }, "2026-01-01T00:00:00Z"),
      ev({ eligible: "yes" }, "2026-03-01T00:00:00Z"),
    ]);
    expect(p.adoptionEligible).toBe(true);
  });
});
