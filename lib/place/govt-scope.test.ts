// Folding public.govt_scope rows into one place per grant (localidades-por-id
// D2). A legacy grant gets NO place — it stays on its name pair, so the id
// path answers exactly like the name path for it. A provincial unit grant is
// its whole province; any other unit grant is its member localities by id.

import { describe, expect, it } from "vitest";

import { type GovtScopeRow, grantPlacesByAssignment } from "./govt-scope";

const row = (over: Partial<GovtScopeRow>): GovtScopeRow => ({
  assignmentId: "g1",
  source: "legacy",
  provinceCode: null,
  localityId: null,
  jurisdictionProvince: null,
  jurisdictionLocality: null,
  ...over,
});

describe("grantPlacesByAssignment", () => {
  it("gives a legacy grant no place at all", () => {
    const places = grantPlacesByAssignment([
      row({
        assignmentId: "legacy",
        jurisdictionProvince: "Mendoza",
        jurisdictionLocality: "Las Heras",
      }),
    ]);
    expect(places.has("legacy")).toBe(false);
  });

  it("gives a provincial unit grant its province", () => {
    const places = grantPlacesByAssignment([
      row({ assignmentId: "caba", source: "province", provinceCode: "AR-C" }),
    ]);
    expect(places.get("caba")).toEqual({ path: "province", provinceCode: "AR-C" });
  });

  it("collects a unit grant's member localities, distinct and sorted", () => {
    const places = grantPlacesByAssignment([
      row({ assignmentId: "alberti", source: "locality", provinceCode: "AR-B", localityId: "l2" }),
      row({ assignmentId: "alberti", source: "locality", provinceCode: "AR-B", localityId: "l1" }),
      row({ assignmentId: "alberti", source: "locality", provinceCode: "AR-B", localityId: "l2" }),
      row({ assignmentId: "bragado", source: "locality", provinceCode: "AR-B", localityId: "l9" }),
    ]);
    expect(places.get("alberti")).toEqual({
      path: "locality",
      provinceCode: "AR-B",
      localityIds: ["l1", "l2"],
    });
    expect(places.get("bragado")).toEqual({
      path: "locality",
      provinceCode: "AR-B",
      localityIds: ["l9"],
    });
  });
});
