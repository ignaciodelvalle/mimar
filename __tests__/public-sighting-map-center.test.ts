// publicSightingMapCenter — ciclo-perdido tester fix #5.
//
// The public sighting form centers its map on the pet's last-known lost
// location — but ONLY when the owner chose to publish that location
// (discloseLastLocationWhenLost). Pure-function tests cover both privacy
// branches plus coordinate hygiene.

import { describe, expect, it } from "vitest";

import { publicSightingMapCenter } from "@/lib/infra/lost-mode";

describe("publicSightingMapCenter", () => {
  it("returns the parsed center when the owner disclosed the location", () => {
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: true,
        lastSeenLat: "-34.5885",
        lastSeenLng: "-58.4359",
      }),
    ).toEqual({ lat: -34.5885, lng: -58.4359 });
  });

  it("PRIVACY: returns null when the owner did NOT disclose — even with coords on record", () => {
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: false,
        lastSeenLat: "-34.5885",
        lastSeenLng: "-58.4359",
      }),
    ).toBeNull();
  });

  it("returns null when disclosed but no point was ever recorded", () => {
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: true,
        lastSeenLat: null,
        lastSeenLng: null,
      }),
    ).toBeNull();
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: true,
        lastSeenLat: "-34.5885",
        lastSeenLng: null,
      }),
    ).toBeNull();
  });

  it("returns null for non-numeric or out-of-range coordinate strings", () => {
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: true,
        lastSeenLat: "garbage",
        lastSeenLng: "-58.4",
      }),
    ).toBeNull();
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: true,
        lastSeenLat: "91",
        lastSeenLng: "-58.4",
      }),
    ).toBeNull();
    expect(
      publicSightingMapCenter({
        discloseLastLocationWhenLost: true,
        lastSeenLat: "-34.6",
        lastSeenLng: "181",
      }),
    ).toBeNull();
  });
});
