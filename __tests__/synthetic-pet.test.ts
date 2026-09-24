// The seeded-pet boundary every public write shares (lib/domain/synthetic-pet.ts).
// Same boundary as syntheticRowExclusion.pets: `seed_tag IS NOT NULL`.

import { describe, expect, it } from "vitest";

import { SYNTHETIC_PET_WRITE_REFUSED, isSyntheticPet } from "@/lib/domain/synthetic-pet";

describe("isSyntheticPet", () => {
  it("is true for any seed_tag value", () => {
    expect(isSyntheticPet({ seedTag: "panorama" })).toBe(true);
    expect(isSyntheticPet({ seedTag: "perf" })).toBe(true);
  });

  it("is false for a real pet (NULL seed_tag)", () => {
    expect(isSyntheticPet({ seedTag: null })).toBe(false);
  });
});

describe("SYNTHETIC_PET_WRITE_REFUSED", () => {
  it("is the neutral es-AR refusal", () => {
    expect(SYNTHETIC_PET_WRITE_REFUSED).toBe(
      "No es posible registrar esta acción para esta mascota.",
    );
  });
});
