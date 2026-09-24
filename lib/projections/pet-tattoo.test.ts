import { describe, expect, it } from "vitest";

import { replayPetTattoo } from "@/lib/projections/pet-tattoo";
import type { ProjectionEvent } from "@/lib/projections/types";

// NOTE (WS-D provenance flag): like microchip, replayPetTattoo binds the tattoo
// on the mere PRESENCE of a tattoo_recorded event with a code — ProjectionEvent
// omits author_role, so provenance cannot be checked here. Flagged for a
// follow-up decision, not changed.

function ev(
  eventType: string,
  payload: unknown,
  occurredAt = "2026-01-01T00:00:00Z",
): ProjectionEvent {
  return { id: `e-${occurredAt}`, eventType, occurredAt, recordedAt: occurredAt, payload };
}

describe("replayPetTattoo", () => {
  it("returns EMPTY with no events", () => {
    expect(replayPetTattoo([])).toEqual({
      tattooCode: null,
      tattooLocation: null,
      tattooDescription: null,
      tattooRecordedAt: null,
      tattooRecordedBy: null,
    });
  });

  it("LATEST tattoo wins (a tattoo can be re-recorded with corrected data)", () => {
    const events = [
      ev("tattoo_recorded", { tattoo_code: "OLD" }, "2026-01-01T00:00:00Z"),
      ev("tattoo_recorded", { tattoo_code: "NEW" }, "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetTattoo(events).tattooCode).toBe("NEW");
  });

  it("skips a tattoo event with no code", () => {
    const events = [
      ev("tattoo_recorded", { tattoo_code: "" }, "2026-02-01T00:00:00Z"),
      ev("tattoo_recorded", { tattoo_code: "AB12" }, "2026-01-01T00:00:00Z"),
    ];
    expect(replayPetTattoo(events).tattooCode).toBe("AB12");
  });

  it("surfaces recordedAt only when tattoo_date_known is true", () => {
    const known = ev("tattoo_recorded", {
      tattoo_code: "AB12",
      tattoo_date_known: true,
      recorded_at: "2026-01-15",
    });
    expect(replayPetTattoo([known]).tattooRecordedAt).toBe("2026-01-15");

    const unknown = ev("tattoo_recorded", {
      tattoo_code: "AB12",
      tattoo_date_known: false,
      recorded_at: "2026-01-15",
    });
    expect(replayPetTattoo([unknown]).tattooRecordedAt).toBeNull();
  });

  it("maps location / description / recorded_by", () => {
    const e = ev("tattoo_recorded", {
      tattoo_code: "AB12",
      location_on_body: "oreja",
      description: "negro",
      recorded_by: "Vet X",
    });
    const p = replayPetTattoo([e]);
    expect(p.tattooLocation).toBe("oreja");
    expect(p.tattooDescription).toBe("negro");
    expect(p.tattooRecordedBy).toBe("Vet X");
  });
});
