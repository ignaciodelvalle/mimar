// The coordinate pass's decision, pure (plan maestro A2). A homonym is settled
// only when the event's point sits clearly next to ONE candidate; every other
// case stays unresolved with its reason, and no case picks a winner by order.

import { describe, expect, it } from "vitest";

import {
  AUDIT_REASON,
  type CandidateCentroid,
  MAX_DISTANCE_KM,
  MIN_MARGIN_KM,
  MIN_RATIO,
  coordinateTargets,
  decideByCoordinates,
  haversineKm,
  usablePoint,
} from "@/lib/place/event-places-coordinate-pass";
import { refusal } from "@/scripts/place-resolve-event-places-by-coordinates";

// Two real-looking Córdoba homonyms ~150 km apart.
const NORTH: CandidateCentroid = {
  localityId: "00000000-0000-4000-8000-00000000000a",
  localityName: "San José",
  departmentName: "Norte",
  lat: -30.0,
  lng: -64.0,
};
const SOUTH: CandidateCentroid = {
  localityId: "00000000-0000-4000-8000-00000000000b",
  localityName: "San José",
  departmentName: "Sur",
  lat: -31.35,
  lng: -64.0,
};

/** A point `km` kilometres due south of `c`. */
function southOf(c: CandidateCentroid, km: number) {
  return { lat: (c.lat as number) - km / 111.195, lng: c.lng as number };
}

describe("haversineKm", () => {
  it("measures a degree of latitude as ~111 km and is symmetric", () => {
    const a = { lat: -31, lng: -64 };
    const b = { lat: -32, lng: -64 };
    expect(haversineKm(a, b)).toBeCloseTo(111.19, 1);
    expect(haversineKm(b, a)).toBeCloseTo(haversineKm(a, b), 9);
    expect(haversineKm(a, a)).toBe(0);
  });
});

describe("usablePoint", () => {
  it("accepts numbers and numeric strings (numeric columns arrive as text)", () => {
    expect(usablePoint(-31.4, -64.2)).toEqual({ lat: -31.4, lng: -64.2 });
    expect(usablePoint("-31.4000000", "-64.2000000")).toEqual({ lat: -31.4, lng: -64.2 });
  });

  it("refuses a missing, non-finite, off-globe or (0, 0) point", () => {
    expect(usablePoint(null, null)).toBeNull();
    expect(usablePoint(-31, null)).toBeNull();
    expect(usablePoint("abc", "-64")).toBeNull();
    expect(usablePoint(Number.NaN, -64)).toBeNull();
    expect(usablePoint(-91, -64)).toBeNull();
    expect(usablePoint(0, 0)).toBeNull();
  });
});

describe("decideByCoordinates — settles a homonym only on clear evidence", () => {
  // The fixtures below are written in literal kilometres. Pinning the
  // thresholds here is what makes them mean something: a fixture derived
  // from the constant would move with it, and a loosened threshold would
  // still read green.
  it("pins the thresholds the fixtures are written against", () => {
    expect(MAX_DISTANCE_KM).toBe(20);
    expect(MIN_MARGIN_KM).toBe(10);
    expect(MIN_RATIO).toBe(2);
  });

  it("picks the candidate the point sits next to", () => {
    const d = decideByCoordinates(southOf(NORTH, 3), [NORTH, SOUTH]);
    expect(d.verdict).toBe("resolved");
    expect(d.verdict === "resolved" && d.localityId).toBe(NORTH.localityId);
    // Order of the candidate list never decides.
    const swapped = decideByCoordinates(southOf(NORTH, 3), [SOUTH, NORTH]);
    expect(swapped.verdict === "resolved" && swapped.localityId).toBe(NORTH.localityId);
  });

  it("leaves a row with no point unresolved", () => {
    expect(decideByCoordinates(null, [NORTH, SOUTH])).toMatchObject({
      verdict: "unresolved",
      reason: "no_coords",
    });
  });

  it("never compares blind: a candidate without a centroid leaves it unresolved", () => {
    const blind = { ...SOUTH, lat: null, lng: null };
    expect(decideByCoordinates(southOf(NORTH, 1), [NORTH, blind])).toMatchObject({
      verdict: "unresolved",
      reason: "candidate_without_centroid",
    });
  });

  it("a point far from every candidate says nothing about which one is home", () => {
    // Nearest is NORTH at 25 km, SOUTH ~125 km: a clear margin, but too far.
    expect(decideByCoordinates(southOf(NORTH, 25), [NORTH, SOUTH])).toMatchObject({
      verdict: "unresolved",
      reason: "outside_all",
    });
    // 19 km from NORTH, ~131 km from SOUTH: inside the 20 km reach.
    expect(decideByCoordinates(southOf(NORTH, 19), [NORTH, SOUTH])).toMatchObject({
      verdict: "resolved",
      localityId: NORTH.localityId,
    });
  });

  it("two candidates about equally near: too close to call", () => {
    const near = { ...NORTH, localityId: "00000000-0000-4000-8000-00000000000c" };
    const twin = { ...near, lat: (NORTH.lat as number) - 8 / 111.195 };
    // Between two centroids 8 km apart, 3 km from one and 5 km from the other.
    const p = southOf(NORTH, 3);
    const d = decideByCoordinates(p, [near, twin]);
    expect(d).toMatchObject({ verdict: "unresolved", reason: "too_close_to_call" });
  });

  it("the margin is absolute AND relative", () => {
    // Winner 15 km, runner-up 26 km: margin 11 km passes, ratio 1.7 does not.
    const a = { ...NORTH, localityId: "00000000-0000-4000-8000-00000000000d" };
    const b = {
      ...NORTH,
      localityId: "00000000-0000-4000-8000-00000000000e",
      lat: (NORTH.lat as number) - 41 / 111.195,
    };
    const p = southOf(NORTH, 15);
    expect(decideByCoordinates(p, [a, b])).toMatchObject({ reason: "too_close_to_call" });
    // Winner 2 km, runner-up 9 km: ratio 4.5 passes, margin 7 km does not.
    const c = {
      ...NORTH,
      localityId: "00000000-0000-4000-8000-00000000000f",
      lat: (NORTH.lat as number) - 11 / 111.195,
    };
    expect(decideByCoordinates(southOf(NORTH, 2), [a, c])).toMatchObject({
      reason: "too_close_to_call",
    });
  });

  it("refuses to run on fewer than two candidates (that is the name pass's job)", () => {
    expect(() => decideByCoordinates(southOf(NORTH, 1), [NORTH])).toThrow();
  });
});

describe("coordinateTargets — what an apply may write", () => {
  const key = "AR-X\u0000San José";
  const pair = {
    provinceCode: "AR-X",
    locality: "San José",
    candidates: [NORTH, SOUTH],
    rows: 4,
    writableRows: 3,
    resolvedRows: 2,
    resolvedWritableRows: 1,
    byReason: { no_coords: 1, candidate_without_centroid: 0, outside_all: 0, too_close_to_call: 1 },
    chosen: { [NORTH.localityId]: 2 },
  };
  const resolved = {
    verdict: "resolved",
    localityId: NORTH.localityId,
    distanceKm: 2,
    runnerUpKm: 150,
  } as const;

  it("keeps ONLY the resolved decisions on spine-shaped rows", () => {
    const targets = coordinateTargets({
      pairs: [pair],
      decisions: [
        { eventId: "e-spine", spine: true, pairKey: key, decision: resolved },
        { eventId: "e-trigger", spine: false, pairKey: key, decision: resolved },
        {
          eventId: "e-close",
          spine: true,
          pairKey: key,
          decision: {
            verdict: "unresolved",
            reason: "too_close_to_call",
            nearestKm: 1,
            runnerUpKm: 2,
          },
        },
        {
          eventId: "e-nopoint",
          spine: true,
          pairKey: key,
          decision: {
            verdict: "unresolved",
            reason: "no_coords",
            nearestKm: null,
            runnerUpKm: null,
          },
        },
      ],
    });
    expect(targets).toEqual([
      {
        eventId: "e-spine",
        pairKey: key,
        provinceCode: "AR-X",
        localityId: NORTH.localityId,
        candidateIds: [NORTH.localityId, SOUTH.localityId],
        distanceKm: 2,
        runnerUpKm: 150,
      },
    ]);
  });

  it("audits the rule met, never a distance that would outlive an erasure", () => {
    expect(AUDIT_REASON).toContain(`${MAX_DISTANCE_KM} km`);
    // Only the thresholds may appear as numbers: no measured, decimal distance.
    expect(AUDIT_REASON).not.toMatch(/\d+\.\d/);
    expect(AUDIT_REASON.length).toBeLessThanOrEqual(1000);
  });
});

describe("the operator script's guard", () => {
  const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const REMOTE =
    "postgresql://postgres.abcdefghijklmnopqrst:x@aws-1-sa-east-1.pooler.supabase.com:5432/postgres";

  it("reads the local database without a flag", () => {
    expect(refusal(LOCAL, false, [])).toBeNull();
  });

  it("refuses a remote database unless --allow-remote is typed", () => {
    expect(refusal(REMOTE, false, [])).toContain("--allow-remote");
    expect(refusal(REMOTE, true, ["--allow-remote"])).toBeNull();
  });

  it("applies to the local database without a flag", () => {
    expect(refusal(LOCAL, false, ["--apply"])).toBeNull();
  });

  it("refuses to WRITE a remote database unless --allow-remote is typed", () => {
    expect(refusal(REMOTE, false, ["--apply"])).toContain("--allow-remote to write");
    expect(refusal(REMOTE, true, ["--apply", "--allow-remote"])).toBeNull();
  });

  it("refuses --apply together with --dry-run", () => {
    expect(refusal(LOCAL, false, ["--apply", "--dry-run"])).toContain("exclusive");
  });
});
