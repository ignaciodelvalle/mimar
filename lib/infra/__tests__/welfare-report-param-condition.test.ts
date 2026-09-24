// Resolver test for the /gob/moderacion (and /gob/maltrato) detail path.
//
// welfareReportParamCondition is the ONE place the user-visible identifier maps
// to a row: a public reference code (DEN-XXXX-XXXX) resolves via
// welfare_reports.reference_code, a legacy uuid resolves via welfare_reports.id.
// The moderacion detail page (app/gob/moderacion/[id]/page.tsx) now runs its
// query through this predicate, so its links stopped leaking a raw UUID while
// keeping the govt scope guard byte-for-byte identical (the guard still runs on
// the fetched row). These tests lock the column-selection decision directly,
// using the REAL drizzle predicate (no @/db mock) so the choice can't silently
// regress to eq(id) for a DEN- code.

import { describe, expect, it } from "vitest";

import { welfareReportParamCondition } from "../welfare-inspector-detail";

// Extract the DB column name a drizzle `eq(column, value)` predicate targets.
// The predicate's queryChunks carry the column object (the only chunk exposing a
// string `.name`), a Param for the value, and StringChunks for the operator.
function targetColumn(condition: unknown): string | undefined {
  const chunks = (condition as { queryChunks?: Array<{ name?: unknown }> }).queryChunks ?? [];
  const col = chunks.find((c) => c && typeof c.name === "string");
  return col?.name as string | undefined;
}

describe("welfareReportParamCondition — code-or-uuid addressing", () => {
  it("resolves a canonical DEN- code via reference_code, not id", () => {
    expect(targetColumn(welfareReportParamCondition("DEN-ABCD-2345"))).toBe("reference_code");
  });

  it("normalizes lowercase/spaced input before deciding it is a code", () => {
    expect(targetColumn(welfareReportParamCondition(" den-abcd-2345 "))).toBe("reference_code");
  });

  it("resolves a legacy uuid via id (transition links keep working)", () => {
    expect(targetColumn(welfareReportParamCondition("11111111-2222-3333-4444-555555555555"))).toBe(
      "id",
    );
  });

  it("falls back to id for anything not matching the DEN- format", () => {
    expect(targetColumn(welfareReportParamCondition("not-a-code"))).toBe("id");
  });
});
