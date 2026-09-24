// Unit tests for the three projection modules. Pure functions — no DB.

import { overlayAmendments } from "@/lib/infra/amendment";
import { describe, expect, it } from "vitest";

import { replayPetMicrochip } from "@/lib/projections/pet-microchip";
import { replayPetStatus } from "@/lib/projections/pet-status";
import { replayPetWeight } from "@/lib/projections/pet-weight";
import type { ProjectionEvent } from "@/lib/projections/types";

function ev(
  i: number,
  eventType: string,
  payload: Record<string, unknown> = {},
  occurredAt?: Date | string,
): ProjectionEvent {
  return {
    id: `evt-${i}`,
    eventType,
    occurredAt: occurredAt ?? new Date(2026, 0, i + 1),
    recordedAt: new Date(2026, 0, i + 1),
    payload,
  };
}

describe("replayPetStatus", () => {
  it("returns active for an empty event list", () => {
    expect(replayPetStatus([])).toEqual({ status: "active", deceasedAt: null });
  });

  it("returns active when only registration-style events exist", () => {
    expect(
      replayPetStatus([
        ev(1, "pet_registered"),
        ev(2, "vaccination_administered"),
        ev(3, "weight_recorded"),
      ]),
    ).toEqual({ status: "active", deceasedAt: null });
  });

  it("returns lost after a single status_changed → lost event", () => {
    const result = replayPetStatus([ev(1, "status_changed", { to_status: "lost" })]);
    expect(result.status).toBe("lost");
    expect(result.deceasedAt).toBeNull();
  });

  it("returns active after lost → active toggle (latest wins)", () => {
    const result = replayPetStatus([
      ev(1, "status_changed", { to_status: "lost" }),
      ev(2, "status_changed", { to_status: "active" }),
    ]);
    expect(result.status).toBe("active");
  });

  it("returns lost again after lost → active → lost", () => {
    const result = replayPetStatus([
      ev(1, "status_changed", { to_status: "lost" }),
      ev(2, "status_changed", { to_status: "active" }),
      ev(3, "status_changed", { to_status: "lost" }),
    ]);
    expect(result.status).toBe("lost");
  });

  it("returns deceased + deceasedAt for a death_recorded event", () => {
    const deathDate = new Date(2026, 1, 15);
    const result = replayPetStatus([
      ev(1, "vaccination_administered"),
      ev(2, "death_recorded", {}, deathDate),
    ]);
    expect(result.status).toBe("deceased");
    expect(result.deceasedAt?.toISOString()).toBe(deathDate.toISOString());
  });

  it("deceased is terminal — later events do not flip it back", () => {
    const result = replayPetStatus([
      ev(1, "death_recorded"),
      // A status_changed after death would be a discipline break, but the
      // projection must not silently obey it.
      ev(2, "status_changed", { to_status: "active" }),
    ]);
    expect(result.status).toBe("deceased");
  });
});

describe("replayPetWeight", () => {
  it("returns null for an empty event list", () => {
    expect(replayPetWeight(overlayAmendments([]))).toEqual({ estimatedWeightKg: null });
  });

  it("returns null when no weight_recorded event exists", () => {
    expect(replayPetWeight(overlayAmendments([ev(1, "vaccination_administered")]))).toEqual({
      estimatedWeightKg: null,
    });
  });

  it("returns the weight for a single event", () => {
    expect(replayPetWeight(overlayAmendments([ev(1, "weight_recorded", { kg: "7.5" })]))).toEqual({
      estimatedWeightKg: "7.5",
    });
  });

  it("returns the latest weight when multiple events exist", () => {
    const result = replayPetWeight(
      overlayAmendments([
        ev(1, "weight_recorded", { kg: "5.0" }),
        ev(2, "weight_recorded", { kg: "7.5" }),
        ev(3, "weight_recorded", { kg: "8.2" }),
      ]),
    );
    expect(result.estimatedWeightKg).toBe("8.2");
  });

  it("accepts numeric payload values and stringifies", () => {
    const result = replayPetWeight(overlayAmendments([ev(1, "weight_recorded", { kg: 9.1 })]));
    expect(result.estimatedWeightKg).toBe("9.1");
  });

  it("ignores weight events from before another type — latest weight_recorded wins", () => {
    const result = replayPetWeight(
      overlayAmendments([
        ev(1, "weight_recorded", { kg: "5.0" }),
        ev(2, "vaccination_administered"),
        ev(3, "weight_recorded", { kg: "7.5" }),
      ]),
    );
    expect(result.estimatedWeightKg).toBe("7.5");
  });
});

describe("replayPetMicrochip", () => {
  const EMPTY = {
    microchipId: null,
    microchipCountryCode: null,
    microchipImplantedAt: null,
    microchipImplantedBy: null,
    microchipLocation: null,
  };

  it("returns the empty block for no microchip events", () => {
    expect(replayPetMicrochip([])).toEqual(EMPTY);
    expect(replayPetMicrochip([ev(1, "pet_registered"), ev(2, "weight_recorded")])).toEqual(EMPTY);
  });

  it("returns the EARLIEST microchip_implanted event (never overwritten)", () => {
    const result = replayPetMicrochip([
      ev(1, "microchip_implanted", {
        chip_number: "111",
        country_code: "858",
        implanted_by: "Dr. Garcia",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      }),
      // A second chip event would be a discipline break. Projection picks
      // the earliest as the binding fact.
      ev(2, "microchip_implanted", {
        chip_number: "222",
        country_code: "858",
        implanted_by: "Dr. Lopez",
        location_on_body: "neck",
        implant_date_known: true,
      }),
    ]);
    expect(result.microchipId).toBe("111");
    expect(result.microchipImplantedBy).toBe("Dr. Garcia");
  });

  it("uses event.occurredAt as the implant date when implant_date_known is true", () => {
    const implantDate = new Date(2025, 5, 12);
    const result = replayPetMicrochip([
      ev(
        1,
        "microchip_implanted",
        {
          chip_number: "123",
          country_code: "858",
          implant_date_known: true,
        },
        implantDate,
      ),
    ]);
    expect(result.microchipImplantedAt).toBe("2025-06-12");
  });

  it("returns null microchipImplantedAt when implant_date_known is false", () => {
    const result = replayPetMicrochip([
      ev(1, "microchip_implanted", {
        chip_number: "123",
        country_code: "858",
        implant_date_known: false,
      }),
    ]);
    expect(result.microchipImplantedAt).toBeNull();
  });

  it("skips malformed chip events (no chip_number) and picks the next valid one", () => {
    const result = replayPetMicrochip([
      ev(1, "microchip_implanted", { chip_number: null }),
      ev(2, "microchip_implanted", { chip_number: "456", country_code: "858" }),
    ]);
    expect(result.microchipId).toBe("456");
  });
});
