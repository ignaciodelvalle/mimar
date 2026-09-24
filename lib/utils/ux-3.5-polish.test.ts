// Unit tests for UX 3.5 owner-facing polish helpers.
//
// These are pure function tests — no DB, no network, no rendering.

import { describe, expect, it } from "vitest";

import { capCount } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Item 6 — capCount: caps large aggregate counts for display
// ---------------------------------------------------------------------------

describe("capCount", () => {
  it("returns the number as string when <= default cap (99)", () => {
    expect(capCount(0)).toBe("0");
    expect(capCount(1)).toBe("1");
    expect(capCount(5)).toBe("5");
    expect(capCount(98)).toBe("98");
    expect(capCount(99)).toBe("99");
  });

  it("returns '99+' when above the default cap", () => {
    expect(capCount(100)).toBe("99+");
    expect(capCount(264)).toBe("99+");
    expect(capCount(1459)).toBe("99+");
    expect(capCount(9999)).toBe("99+");
  });

  it("respects a custom cap", () => {
    expect(capCount(10, 9)).toBe("9+");
    expect(capCount(9, 9)).toBe("9");
    expect(capCount(0, 5)).toBe("0");
    expect(capCount(5, 5)).toBe("5");
    expect(capCount(6, 5)).toBe("5+");
  });
});

// ---------------------------------------------------------------------------
// Item 1 — first-pet step label: gated on petCount
// ---------------------------------------------------------------------------

function stepLabelForPetCount(petCount: number): string {
  return petCount === 0 ? "Registrar tu primera mascota" : "Registrar mascota";
}

describe("stepLabelForPetCount (first-pet copy gate)", () => {
  it("shows first-pet framing when owner has 0 pets", () => {
    expect(stepLabelForPetCount(0)).toBe("Registrar tu primera mascota");
  });

  it("shows neutral copy when owner has 1 pet", () => {
    expect(stepLabelForPetCount(1)).toBe("Registrar mascota");
  });

  it("shows neutral copy when owner has many pets", () => {
    expect(stepLabelForPetCount(10)).toBe("Registrar mascota");
    expect(stepLabelForPetCount(264)).toBe("Registrar mascota");
  });
});

// ---------------------------------------------------------------------------
// Item 3 — /adoptar empty state: true-empty vs filter-empty
// ---------------------------------------------------------------------------

/** Returns the heading shown in the empty state for the adoption listing page. */
function adoptionEmptyHeading(hasActiveFilters: boolean): string {
  return hasActiveFilters
    ? "No hay mascotas con esos filtros."
    : "Todavía no hay animales en adopción.";
}

describe("adoptionEmptyHeading", () => {
  it("shows filter-specific message when filters are active", () => {
    expect(adoptionEmptyHeading(true)).toBe("No hay mascotas con esos filtros.");
  });

  it("shows true-empty message when no filters are active", () => {
    expect(adoptionEmptyHeading(false)).toBe("Todavía no hay animales en adopción.");
  });
});
