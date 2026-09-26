// The pet's home as an event `place` (localidades-por-id D3): the id travels
// with the names the writer already snapshotted, and nothing is guessed.

import { describe, expect, it } from "vitest";

import { homePlace } from "./home-place";
import { eventPlaceSchema } from "./place-payload";

const ALBERTI = "11111111-1111-4111-8111-111111111111";

describe("homePlace", () => {
  it("a home with a catalogue row resolves to that row, with the pet's recorded method", () => {
    const p = homePlace({
      province: "Buenos Aires",
      locality: "Mechita",
      localityId: ALBERTI,
      placeMethod: "indec_id",
    });
    expect(p).toEqual({
      entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
      resolved: { locality_id: ALBERTI, province_code: "AR-B", method: "indec_id" },
    });
    expect(eventPlaceSchema.safeParse(p).success).toBe(true);
  });

  it("no recorded method → the id itself ('catalogue_id'), never 'unresolved' with a row", () => {
    const p = homePlace({ province: "Buenos Aires", locality: "Mechita", localityId: ALBERTI });
    expect(p?.resolved?.method).toBe("catalogue_id");
  });

  it("a home with no single row stays unresolved — the names kept, no row guessed", () => {
    const p = homePlace({ province: "Buenos Aires", locality: "Mechita", localityId: null });
    expect(p).toEqual({
      entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
      resolved: null,
    });
  });

  it("no id snapshot, or an unreadable province with a row → no place at all", () => {
    expect(homePlace({ province: "Buenos Aires", locality: "Mechita" })).toBeUndefined();
    expect(homePlace({ province: "Atlantis", locality: "X", localityId: ALBERTI })).toBeUndefined();
  });
});
