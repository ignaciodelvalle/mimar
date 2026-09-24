// Boundary tests for capRows() — the cap/truncate arithmetic shared by every
// #815-audit pagination fix (mascotas, transferencias, voluntarios, miembros,
// servicios). Exercises the exact off-by-one boundary that matters in
// production: the row AT the cap must render and NOT flag truncation, while
// the row ONE PAST the cap must be dropped and DOES flag truncation.

import { describe, expect, it } from "vitest";

import { capRows } from "@/lib/utils/list-pagination";

function rowsOfLength(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe("capRows", () => {
  it("returns all rows and truncated=false when under the cap", () => {
    const result = capRows(rowsOfLength(5), 200);
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("returns all rows and truncated=false when exactly AT the cap (boundary)", () => {
    const result = capRows(rowsOfLength(200), 200);
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(false);
  });

  it("caps at pageSize and flags truncated=true when ONE past the cap (boundary)", () => {
    const result = capRows(rowsOfLength(201), 200);
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    // The 201st row (index 200) must be dropped, not silently included.
    expect(result.rows.at(-1)).toBe(199);
  });

  it("caps correctly for a smaller page size (mascotas/voluntarios use non-200 sizes too)", () => {
    const result = capRows(rowsOfLength(51), 50);
    expect(result.rows).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("handles an empty input", () => {
    const result = capRows([], 200);
    expect(result.rows).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("never mutates the input array", () => {
    const input = rowsOfLength(201);
    const inputCopy = [...input];
    capRows(input, 200);
    expect(input).toEqual(inputCopy);
  });
});
