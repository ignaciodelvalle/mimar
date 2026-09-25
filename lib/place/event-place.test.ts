// toEventPlace — the `place` an event payload keeps: as entered, as resolved.
//
// localidades-por-id A5/A8 (P2: never lose an event's origin place). A
// resolved place names ONE catalogue row, its province code and HOW it was
// reached; an unresolved one keeps what the person entered and says `resolved:
// null` — never a guessed row. The point and the address are not copied here:
// they live on the event row under the erasure policy (see the payload fence).

import { describe, expect, it } from "vitest";

import { toEventPlace, toEventPlaceOrNull } from "@/lib/place/event-place";
import type { ReportedPlace } from "@/lib/place/reported-place";

const RESOLVED: ReportedPlace = {
  province: "Córdoba",
  locality: "Villa María",
  localityId: "00000000-0000-4000-8000-0000000014e2",
  method: "geocode_unique",
  unresolvedReason: null,
  mismatch: false,
  entered: { province: "AR-X", locality: "Villa María", indecId: null },
};

describe("toEventPlace", () => {
  it("a resolved place names its row, its province code and the method", () => {
    expect(toEventPlace(RESOLVED)).toEqual({
      entered: { province: "AR-X", locality: "Villa María", indec_id: null },
      resolved: {
        locality_id: "00000000-0000-4000-8000-0000000014e2",
        province_code: "AR-X",
        method: "geocode_unique",
      },
    });
  });

  it("an unresolved place keeps what was entered and resolves to nothing", () => {
    expect(
      toEventPlace({
        ...RESOLVED,
        province: "Buenos Aires",
        locality: null,
        localityId: null,
        method: "unresolved",
        unresolvedReason: "ambiguous",
        entered: { province: "Buenos Aires", locality: "Mechita", indecId: null },
      }),
    ).toEqual({
      entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
      resolved: null,
    });
  });

  it("the province code is the catalogue's, whatever spelling was entered", () => {
    const out = toEventPlace({
      ...RESOLVED,
      province: "CABA",
      locality: "Palermo",
      entered: { province: "Ciudad Autónoma de Buenos Aires", locality: "Palermo", indecId: null },
    });
    expect(out.resolved?.province_code).toBe("AR-C");
    expect(out.entered.province).toBe("Ciudad Autónoma de Buenos Aires");
  });
});

describe("toEventPlaceOrNull", () => {
  it("records no place when nothing was entered — a text-only update", () => {
    expect(
      toEventPlaceOrNull({
        ...RESOLVED,
        province: null,
        locality: null,
        localityId: null,
        method: "unresolved",
        unresolvedReason: "none_entered",
        entered: { province: null, locality: null, indecId: null },
      }),
    ).toBeNull();
  });

  it("records a pin that resolved to nothing, as resolved: null", () => {
    expect(
      toEventPlaceOrNull({
        ...RESOLVED,
        province: "Córdoba",
        locality: null,
        localityId: null,
        method: "unresolved",
        unresolvedReason: "pin_only",
        entered: { province: null, locality: null, indecId: null },
      }),
    ).toEqual({ entered: { province: null, locality: null, indec_id: null }, resolved: null });
  });
});
