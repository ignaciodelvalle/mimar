import { describe, expect, it } from "vitest";

import { replayPetMicrochip } from "@/lib/projections/pet-microchip";
import type { ProjectionEvent } from "@/lib/projections/types";

// NOTE (WS-D provenance flag): replayPetMicrochip binds the microchip on the
// mere PRESENCE of a microchip_implanted event with a chip_number — it cannot
// check who authored it, because ProjectionEvent deliberately omits author_role.
// This is the H1-class "clears on presence" pattern; whether the chip fact
// should require professional/institutional provenance is a product decision
// (flagged for follow-up, not changed here).

function ev(
  eventType: string,
  payload: unknown,
  occurredAt = "2026-01-01T00:00:00Z",
): ProjectionEvent {
  return { id: `e-${occurredAt}`, eventType, occurredAt, recordedAt: occurredAt, payload };
}

const chip = (n: string, extra: Record<string, unknown> = {}, occurredAt?: string) =>
  ev("microchip_implanted", { chip_number: n, ...extra }, occurredAt);

describe("replayPetMicrochip", () => {
  it("returns EMPTY when there are no events", () => {
    expect(replayPetMicrochip([])).toEqual({
      microchipId: null,
      microchipCountryCode: null,
      microchipImplantedAt: null,
      microchipImplantedBy: null,
      microchipLocation: null,
    });
  });

  it("ignores non-microchip events", () => {
    expect(replayPetMicrochip([ev("weight_recorded", { kg: "10" })]).microchipId).toBeNull();
  });

  it("EARLIEST chip wins (a chip is a permanent implant)", () => {
    const events = [
      chip("111111111111111", {}, "2026-01-01T00:00:00Z"),
      chip("222222222222222", {}, "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetMicrochip(events).microchipId).toBe("111111111111111");
  });

  it("skips a malformed chip event with no chip_number and uses the next", () => {
    const events = [
      ev("microchip_implanted", { chip_number: "" }, "2026-01-01T00:00:00Z"),
      chip("333333333333333", {}, "2026-02-01T00:00:00Z"),
    ];
    expect(replayPetMicrochip(events).microchipId).toBe("333333333333333");
  });

  it("surfaces implantedAt only when implant_date_known is true", () => {
    const known = chip("444444444444444", { implant_date_known: true }, "2026-03-04T00:00:00Z");
    expect(replayPetMicrochip([known]).microchipImplantedAt).toBe("2026-03-04");

    const unknown = chip("555555555555555", { implant_date_known: false });
    expect(replayPetMicrochip([unknown]).microchipImplantedAt).toBeNull();
  });

  it("maps country_code / implanted_by / location_on_body", () => {
    const e = chip("858000000000001", {
      country_code: "858",
      implanted_by: "Dr. Gómez",
      location_on_body: "cuello",
    });
    const p = replayPetMicrochip([e]);
    expect(p.microchipCountryCode).toBe("858");
    expect(p.microchipImplantedBy).toBe("Dr. Gómez");
    expect(p.microchipLocation).toBe("cuello");
  });

  // --- microchip_replaced lifecycle (folded into the replay) ----------------

  const replaced = (
    prev: string,
    next: string | null,
    extra: Record<string, unknown> = {},
    occurredAt?: string,
  ) =>
    ev(
      "microchip_replaced",
      { previous_chip_number: prev, new_chip_number: next, reason: "damaged", ...extra },
      occurredAt,
    );

  it("a replacement makes the NEW chip active (mirrors the canonical row)", () => {
    const events = [
      chip("858000000000001", { country_code: "858" }, "2026-01-01T00:00:00Z"),
      replaced(
        "858000000000001",
        "858000000000002",
        { replaced_by: "Dr. Ruiz" },
        "2026-03-04T00:00:00Z",
      ),
    ];
    const p = replayPetMicrochip(events);
    expect(p.microchipId).toBe("858000000000002");
    // country code mirrors newChip.slice(0,3), as the writer sets iso_country_code.
    expect(p.microchipCountryCode).toBe("858");
    // implant date is the replace date (event.occurredAt), matching recorded_at.
    expect(p.microchipImplantedAt).toBe("2026-03-04");
    expect(p.microchipImplantedBy).toBe("Dr. Ruiz");
    // replace does not carry a location — canonical implantation_site is null.
    expect(p.microchipLocation).toBeNull();
  });

  it("a pure revocation (new_chip_number=null) leaves NO active chip", () => {
    const events = [
      chip("858000000000001", {}, "2026-01-01T00:00:00Z"),
      replaced("858000000000001", null, { reason: "owner_request" }, "2026-03-04T00:00:00Z"),
    ];
    expect(replayPetMicrochip(events)).toEqual({
      microchipId: null,
      microchipCountryCode: null,
      microchipImplantedAt: null,
      microchipImplantedBy: null,
      microchipLocation: null,
    });
  });

  it("implant → replace → revoke ends with no active chip", () => {
    const events = [
      chip("858000000000001", {}, "2026-01-01T00:00:00Z"),
      replaced("858000000000001", "858000000000002", {}, "2026-02-01T00:00:00Z"),
      replaced("858000000000002", null, { reason: "device_failure" }, "2026-03-01T00:00:00Z"),
    ];
    expect(replayPetMicrochip(events).microchipId).toBeNull();
  });

  it("an implant AFTER a revocation re-binds a fresh chip", () => {
    const events = [
      chip("858000000000001", {}, "2026-01-01T00:00:00Z"),
      replaced("858000000000001", null, { reason: "owner_request" }, "2026-02-01T00:00:00Z"),
      chip("858000000000009", { country_code: "858" }, "2026-03-01T00:00:00Z"),
    ];
    expect(replayPetMicrochip(events).microchipId).toBe("858000000000009");
  });

  it("a replace with no preceding implant still binds the new chip (canonical parity)", () => {
    // A chip seeded directly into pet_identifications (no implant event) then
    // replaced: canonical active row = new chip, so derived must agree.
    const events = [replaced("858000000000001", "858000000000002", {}, "2026-03-04T00:00:00Z")];
    expect(replayPetMicrochip(events).microchipId).toBe("858000000000002");
  });
});
