import { describe, expect, it } from "vitest";

import {
  coarsePin,
  creatorLabel,
  formatDistanceKm,
  haversineKm,
  rankCandidates,
  subjectKindLabel,
} from "@/lib/place/queue-context";

const CANDIDATES = [
  { localityId: "a", name: "Mechita", department: "Alberti", latitude: -35.0, longitude: -60.3 },
  { localityId: "b", name: "Mechita", department: "Bragado", latitude: -35.2, longitude: -60.5 },
  { localityId: "c", name: "Mechita", department: "Sin centro", latitude: null, longitude: null },
];

describe("queue decision context", () => {
  it("measures distance on the sphere", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.19, 1);
    expect(haversineKm({ lat: -35, lng: -60 }, { lat: -35, lng: -60 })).toBe(0);
  });

  it("sorts candidates nearest first when there is a pin, centroid-less last", () => {
    const ranked = rankCandidates(CANDIDATES, { lat: -35.19, lng: -60.49 });
    expect(ranked.map((c) => c.localityId)).toEqual(["b", "a", "c"]);
    expect(ranked[0]?.distanceKm).toBeLessThan(5);
    expect(ranked[2]?.distanceKm).toBeNull();
  });

  it("flags a candidate with no centroid once there is a pin", () => {
    const ranked = rankCandidates(CANDIDATES, { lat: -35.19, lng: -60.49 });
    expect(ranked.map((c) => c.noCentroid)).toEqual([false, false, true]);
    expect(rankCandidates(CANDIDATES, null).some((c) => c.noCentroid)).toBe(false);
  });

  it("degrades without a pin: input order kept, no distances", () => {
    const ranked = rankCandidates(CANDIDATES, null);
    expect(ranked.map((c) => c.localityId)).toEqual(["a", "b", "c"]);
    expect(ranked.every((c) => c.distanceKm === null)).toBe(true);
  });

  it("formats distances in es-AR", () => {
    expect(formatDistanceKm(0.05)).toBe("menos de 100 m");
    expect(formatDistanceKm(0.85)).toBe("850 m");
    expect(formatDistanceKm(12.34)).toBe("12,3 km");
    expect(formatDistanceKm(148.4)).toBe("148 km");
    // Round first, then branch: no "1000 m" and no "100,0 km".
    expect(formatDistanceKm(0.996)).toBe("1,0 km");
    expect(formatDistanceKm(99.96)).toBe("100 km");
    expect(formatDistanceKm(99.94)).toBe("99,9 km");
  });

  it("words the subject and its creator by role, never by name", () => {
    expect(subjectKindLabel("cases", "bite_incident")).toBe("Mordedura");
    expect(subjectKindLabel("welfare_reports", "abandonment")).toBe("Denuncia: abandono");
    expect(
      creatorLabel({ subjectTable: "welfare_reports", role: null, viaOrganization: false }),
    ).toBe("Anónimo");
    // A denuncia never discloses the role: only anonymous or with an account.
    expect(
      creatorLabel({ subjectTable: "welfare_reports", role: "vet", viaOrganization: false }),
    ).toBe("Con cuenta");
    expect(coarsePin({ lat: -35.19412, lng: -60.49488 })).toEqual({ lat: -35.19, lng: -60.49 });
    expect(creatorLabel({ subjectTable: "cases", role: "vet", viaOrganization: false })).toBe(
      "Veterinario/a",
    );
    expect(creatorLabel({ subjectTable: "cases", role: "owner", viaOrganization: true })).toBe(
      "Organización",
    );
  });
});
