// Unit tests for lib/pet-pipeline.ts — Wave 3 Item 18: Animal pipeline board.
//
// Coverage:
//   1. derivePipelineColumn — all 6 columns + priority rules.
//   2. groupIntoPipelineColumns — empty input, single card, multi-card,
//      foster priority, todos los estados.
//   3. Output column ordering matches PIPELINE_COLUMNS display order.
//   4. Empty columns still present in output (board always shows all columns).
//
// Pure unit tests — no DB access required.

import { describe, expect, it } from "vitest";

import type { PetCardData } from "@/app/org/[orgToken]/mascotas/OrgMascotasBulkList";
import {
  PIPELINE_COLUMNS,
  derivePipelineColumn,
  groupIntoPipelineColumns,
} from "@/lib/infra/pet-pipeline";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<PetCardData> = {}): PetCardData {
  return {
    petId: "pet-default",
    publicToken: "TOKEN-DEFAULT",
    name: "Luna",
    species: "dog",
    breed: null,
    color: null,
    dateOfBirth: null,
    birthDateIsEstimated: false,
    status: "active",
    adoptionEligible: null,
    adoptionListedAt: null,
    adoptionListingPausedAt: null,
    ownershipRole: "shelter_custody",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

const NO_FOSTER = new Set<string>();

// ---------------------------------------------------------------------------
// derivePipelineColumn
// ---------------------------------------------------------------------------

describe("derivePipelineColumn", () => {
  it("ingreso — shelter_custody with no evaluation", () => {
    const card = makeCard({ ownershipRole: "shelter_custody", adoptionEligible: null });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("ingreso");
  });

  it("evaluacion — shelter_custody marked not eligible", () => {
    const card = makeCard({ ownershipRole: "shelter_custody", adoptionEligible: false });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("evaluacion");
  });

  it("disponible — shelter_custody, eligible, not listed", () => {
    const card = makeCard({
      ownershipRole: "shelter_custody",
      adoptionEligible: true,
      adoptionListedAt: null,
    });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("disponible");
  });

  it("en_adopcion — shelter_custody, listed (published)", () => {
    const card = makeCard({
      ownershipRole: "shelter_custody",
      adoptionEligible: true,
      adoptionListedAt: "2026-01-01T00:00:00Z",
      adoptionListingPausedAt: null,
    });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("en_adopcion");
  });

  it("en_adopcion — shelter_custody, listed but paused", () => {
    const card = makeCard({
      ownershipRole: "shelter_custody",
      adoptionEligible: true,
      adoptionListedAt: "2026-01-01T00:00:00Z",
      adoptionListingPausedAt: "2026-01-15T00:00:00Z",
    });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("en_adopcion");
  });

  it("transito — shelter_custody card with active foster row", () => {
    const card = makeCard({ petId: "pet-123", ownershipRole: "shelter_custody" });
    const fostered = new Set(["pet-123"]);
    expect(derivePipelineColumn(card, fostered)).toBe("transito");
  });

  it("transito — foster priority overrides listed state", () => {
    // A pet can simultaneously be listed AND in foster; foster wins for column.
    const card = makeCard({
      petId: "pet-456",
      ownershipRole: "shelter_custody",
      adoptionEligible: true,
      adoptionListedAt: "2026-01-01T00:00:00Z",
    });
    const fostered = new Set(["pet-456"]);
    expect(derivePipelineColumn(card, fostered)).toBe("transito");
  });

  it("otros — owner role", () => {
    const card = makeCard({ ownershipRole: "owner" });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("otros");
  });

  it("otros — co_owner role", () => {
    const card = makeCard({ ownershipRole: "co_owner" });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("otros");
  });

  it("otros — caretaker role", () => {
    const card = makeCard({ ownershipRole: "caretaker" });
    expect(derivePipelineColumn(card, NO_FOSTER)).toBe("otros");
  });
});

// ---------------------------------------------------------------------------
// groupIntoPipelineColumns
// ---------------------------------------------------------------------------

describe("groupIntoPipelineColumns", () => {
  it("returns all 6 columns even when input is empty", () => {
    const result = groupIntoPipelineColumns([], NO_FOSTER);
    expect(result).toHaveLength(PIPELINE_COLUMNS.length);
    expect(result.every((col) => col.cards.length === 0)).toBe(true);
  });

  it("output order matches PIPELINE_COLUMNS display order", () => {
    const result = groupIntoPipelineColumns([], NO_FOSTER);
    const keys = result.map((col) => col.key);
    const expectedKeys = PIPELINE_COLUMNS.map((col) => col.key);
    expect(keys).toEqual(expectedKeys);
  });

  it("places a single ingreso card in the correct column", () => {
    const card = makeCard({
      petId: "p1",
      ownershipRole: "shelter_custody",
      adoptionEligible: null,
    });
    const result = groupIntoPipelineColumns([card], NO_FOSTER);
    const ingresoCol = result.find((c) => c.key === "ingreso");
    expect(ingresoCol?.cards).toHaveLength(1);
    expect(ingresoCol?.cards[0].petId).toBe("p1");
  });

  it("distributes multiple cards across correct columns", () => {
    const cards = [
      makeCard({ petId: "p-ingreso", ownershipRole: "shelter_custody", adoptionEligible: null }),
      makeCard({ petId: "p-eval", ownershipRole: "shelter_custody", adoptionEligible: false }),
      makeCard({
        petId: "p-disp",
        ownershipRole: "shelter_custody",
        adoptionEligible: true,
        adoptionListedAt: null,
      }),
      makeCard({
        petId: "p-adopt",
        ownershipRole: "shelter_custody",
        adoptionEligible: true,
        adoptionListedAt: "2026-01-01T00:00:00Z",
      }),
      makeCard({ petId: "p-otros", ownershipRole: "owner" }),
    ];
    // p-transito: shelter_custody with a foster row
    const transitoCard = makeCard({ petId: "p-transito", ownershipRole: "shelter_custody" });
    const fostered = new Set(["p-transito"]);

    const result = groupIntoPipelineColumns([...cards, transitoCard], fostered);

    const byKey = Object.fromEntries(result.map((col) => [col.key, col]));
    expect(byKey.ingreso.cards.map((c) => c.petId)).toEqual(["p-ingreso"]);
    expect(byKey.evaluacion.cards.map((c) => c.petId)).toEqual(["p-eval"]);
    expect(byKey.disponible.cards.map((c) => c.petId)).toEqual(["p-disp"]);
    expect(byKey.en_adopcion.cards.map((c) => c.petId)).toEqual(["p-adopt"]);
    expect(byKey.transito.cards.map((c) => c.petId)).toEqual(["p-transito"]);
    expect(byKey.otros.cards.map((c) => c.petId)).toEqual(["p-otros"]);
  });

  it("multiple cards in the same column preserve insertion order", () => {
    const cards = [
      makeCard({ petId: "p1", ownershipRole: "shelter_custody", adoptionEligible: null }),
      makeCard({ petId: "p2", ownershipRole: "shelter_custody", adoptionEligible: null }),
      makeCard({ petId: "p3", ownershipRole: "shelter_custody", adoptionEligible: null }),
    ];
    const result = groupIntoPipelineColumns(cards, NO_FOSTER);
    const ingresoCol = result.find((c) => c.key === "ingreso");
    expect(ingresoCol?.cards.map((c) => c.petId)).toEqual(["p1", "p2", "p3"]);
  });

  it("column labels match PIPELINE_COLUMNS", () => {
    const result = groupIntoPipelineColumns([], NO_FOSTER);
    for (const col of result) {
      const expected = PIPELINE_COLUMNS.find((c) => c.key === col.key);
      expect(col.label).toBe(expected?.label);
    }
  });
});
