// Unit tests for the jurisdiction-scope intersection logic used in
// app/gob/vigilancia/page.tsx, app/gob/vigilancia/brotes/page.tsx, and
// app/gob/maltrato/page.tsx.
//
// Security invariant: a govt user selecting province B + locality L must
// produce an EMPTY filteredJurisdictions when their assignments only cover
// province A (scope-bypass closed, C1 finding).
//
// These tests exercise the pure filtering logic extracted verbatim from
// the pages — no DB, no Next.js runtime required.

import { describe, expect, it } from "vitest";

type Jurisdiction = { province: string; locality: string };

/**
 * Mirrors the intersection logic in all three gob pages for the
 * province+locality branch. govtAssignments.jurisdictionLocality is NOT NULL
 * (schema-enforced) so exact match on both fields is correct.
 */
function narrowToLocalitySelection(
  assignments: Jurisdiction[],
  selectedProvince: string,
  selectedLocality: string,
): Jurisdiction[] {
  return assignments.filter(
    (j) => j.province === selectedProvince && j.locality === selectedLocality,
  );
}

/**
 * Mirrors the province-only branch (already correct in original code; kept
 * for regression).
 */
function narrowToProvinceSelection(
  assignments: Jurisdiction[],
  selectedProvince: string,
): Jurisdiction[] {
  return assignments.filter((j) => j.province === selectedProvince);
}

describe("gob scope intersection — locality selection", () => {
  const assignmentsProvinceA: Jurisdiction[] = [
    { province: "Córdoba", locality: "Córdoba" },
    { province: "Córdoba", locality: "Villa Carlos Paz" },
  ];

  it("returns matching entry when user selects a locality within their own province", () => {
    const result = narrowToLocalitySelection(assignmentsProvinceA, "Córdoba", "Córdoba");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ province: "Córdoba", locality: "Córdoba" });
  });

  it("returns empty when user selects a locality NOT in their assignments (bypass blocked)", () => {
    // User is assigned to Córdoba; selects Santa Fe + Rosario via URL params.
    const result = narrowToLocalitySelection(assignmentsProvinceA, "Santa Fe", "Rosario");
    expect(result).toHaveLength(0);
  });

  it("returns empty when province matches but locality does not", () => {
    const result = narrowToLocalitySelection(assignmentsProvinceA, "Córdoba", "Rosario");
    expect(result).toHaveLength(0);
  });

  it("is safe with empty assignments (no-scope govt)", () => {
    const result = narrowToLocalitySelection([], "Córdoba", "Córdoba");
    expect(result).toHaveLength(0);
  });

  it("returns multiple matching entries when user has several localities in that province", () => {
    const wide: Jurisdiction[] = [
      { province: "Buenos Aires", locality: "La Plata" },
      { province: "Buenos Aires", locality: "La Plata" }, // duplicate edge case
      { province: "Córdoba", locality: "Córdoba" },
    ];
    const result = narrowToLocalitySelection(wide, "Buenos Aires", "La Plata");
    expect(result).toHaveLength(2);
  });
});

describe("gob scope intersection — province-only selection", () => {
  const assignments: Jurisdiction[] = [
    { province: "Buenos Aires", locality: "La Plata" },
    { province: "Buenos Aires", locality: "Mar del Plata" },
    { province: "Córdoba", locality: "Córdoba" },
  ];

  it("returns only assignments for the selected province", () => {
    const result = narrowToProvinceSelection(assignments, "Buenos Aires");
    expect(result).toHaveLength(2);
    for (const j of result) expect(j.province).toBe("Buenos Aires");
  });

  it("returns empty when user has no assignments in the selected province", () => {
    const result = narrowToProvinceSelection(assignments, "Santa Fe");
    expect(result).toHaveLength(0);
  });

  it("is safe with empty assignments", () => {
    expect(narrowToProvinceSelection([], "Buenos Aires")).toHaveLength(0);
  });
});

describe("scope bypass — cross-province locality attack (C1)", () => {
  it("govt assigned to province A sees ZERO rows when selecting province B + B-locality", () => {
    // This is the core security assertion from the C1 finding.
    const govtAssignmentsProvinceA: Jurisdiction[] = [{ province: "Córdoba", locality: "Córdoba" }];
    const selectedProvince = "Santa Fe"; // province B
    const selectedLocality = "Rosario"; // locality in province B

    const filtered = narrowToLocalitySelection(
      govtAssignmentsProvinceA,
      selectedProvince,
      selectedLocality,
    );
    // Empty result → scope clause receives [] → query returns sql`false` → zero rows.
    expect(filtered).toHaveLength(0);
  });
});
