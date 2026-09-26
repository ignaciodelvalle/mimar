// The per-row gate on the ID path (localidades-por-id, stage D audit
// addendum (a)).
//
// jurisdictionScopeContains is the in-memory twin of jurisdictionPairClause.
// When a grant carries its id-path `place` (a unit grant, `scope` flag on
// 'id') and the caller passes the row's locality_id, the gate compares
// catalogue rows: a Bragado unit operator cannot open Alberti's Mechita by
// URL, and a locality the unit governs is readable even when its stored name
// differs from the grant's. A legacy grant (no place), and a caller that
// passes no row id, keep the name rule — exactly as before.

import { describe, expect, it } from "vitest";

import { jurisdictionScopeContains } from "./jurisdiction-canonical";

const bragadoUnit = {
  province: "Buenos Aires",
  locality: "Mechita",
  place: { path: "locality" as const, provinceCode: "AR-B", localityIds: ["loc-bragado"] },
};
const wholeBa = {
  province: "Buenos Aires",
  locality: "",
  place: { path: "province" as const, provinceCode: "AR-B" },
};
const legacy = { province: "Buenos Aires", locality: "Mechita" };

describe("jurisdictionScopeContains — id path", () => {
  it("a unit grant refuses the homonym's row and admits its own", () => {
    expect(jurisdictionScopeContains([bragadoUnit], "Buenos Aires", "Mechita", "loc-alberti")).toBe(
      false,
    );
    expect(jurisdictionScopeContains([bragadoUnit], "Buenos Aires", "Mechita", "loc-bragado")).toBe(
      true,
    );
    // Its member locality is readable whatever name the row stored.
    expect(
      jurisdictionScopeContains([bragadoUnit], "Buenos Aires", "Otro nombre", "loc-bragado"),
    ).toBe(true);
  });

  it("an unresolved row reaches a provincial unit, never a municipal one", () => {
    expect(jurisdictionScopeContains([bragadoUnit], "Buenos Aires", "Mechita", null)).toBe(false);
    expect(jurisdictionScopeContains([wholeBa], "Buenos Aires", "Mechita", null)).toBe(true);
    expect(jurisdictionScopeContains([wholeBa], "Córdoba", "Villa María", "loc-x")).toBe(false);
  });

  it("a legacy grant, or a caller that passes no row id, keeps the name rule", () => {
    expect(jurisdictionScopeContains([legacy], "Buenos Aires", "Mechita", "loc-alberti")).toBe(
      true,
    );
    expect(jurisdictionScopeContains([bragadoUnit], "Buenos Aires", "Mechita")).toBe(true);
  });
});
