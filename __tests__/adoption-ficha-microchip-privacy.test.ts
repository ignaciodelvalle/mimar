// PO-1 (2026-08-05) — the public adoption ficha may say THAT a pet is chipped,
// never any part of the number.
//
// The ficha used to render `••••` + the last four digits of the canonical
// microchip to an anonymous visitor: of the 16 canonical-identifier read sites
// swept in Q3, it was the ONE not gated by role. The PO decided: boolean only.
//
// Two fences, because "don't render it" is the weaker half of the fix:
//   1. hasActiveMicrochip() answers the question with a CONSTANT projection
//      (`select 1`), so the code never leaves Postgres — a future render on
//      this ungated route has nothing to leak by accident.
//   2. A source scan of the ficha: it must not import the code-bearing helper
//      and must not carry a masking fragment.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petIdentifications, pets } from "@/db";
import { hasActiveMicrochip } from "@/lib/infra/pet-identifiers";
import { withMutationOverride } from "./_helpers/db-overrides";

const TOKEN_PREFIX = "DIM-CHIPBOOL";

type Fixture = {
  chipped: string;
  bare: string;
  replacedChip: string;
  codelessChip: string;
  tattooOnly: string;
};

const petIds: Fixture = {
  chipped: "",
  bare: "",
  replacedChip: "",
  codelessChip: "",
  tattooOnly: "",
};

async function insertPet(suffix: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TOKEN_PREFIX}-${suffix}`,
      name: `Chip Bool ${suffix}`,
      species: "dog",
      sex: "female",
      status: "active",
    })
    .returning({ id: pets.id });
  return row.id;
}

async function cleanup() {
  await withMutationOverride(async (tx) => {
    for (const suffix of ["A", "B", "C", "D", "E"]) {
      const stale = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, `${TOKEN_PREFIX}-${suffix}`));
      // pet_identifications.pet_id cascades on delete.
      for (const { id } of stale) await tx.delete(pets).where(eq(pets.id, id));
    }
  });
}

beforeAll(async () => {
  await cleanup();

  petIds.chipped = await insertPet("A");
  petIds.bare = await insertPet("B");
  petIds.replacedChip = await insertPet("C");
  petIds.codelessChip = await insertPet("D");
  petIds.tattooOnly = await insertPet("E");

  await db.insert(petIdentifications).values([
    {
      id: randomUUID(),
      petId: petIds.chipped,
      kind: "microchip_iso",
      status: "active",
      code: "982000123456789",
    },
    {
      id: randomUUID(),
      petId: petIds.replacedChip,
      kind: "microchip_iso",
      status: "replaced",
      code: "982000987654321",
    },
    {
      id: randomUUID(),
      petId: petIds.tattooOnly,
      kind: "tattoo",
      status: "active",
      code: "TAT-0001",
    },
  ]);
}, 30_000);

afterAll(async () => {
  await cleanup();
}, 30_000);

describe("hasActiveMicrochip — boolean-only microchip read (PO-1)", () => {
  it("is true for a pet with an ACTIVE chip row", async () => {
    expect(await hasActiveMicrochip(petIds.chipped)).toBe(true);
  });

  it("is false for a pet with no identifications at all", async () => {
    expect(await hasActiveMicrochip(petIds.bare)).toBe(false);
  });

  it("is false for a REPLACED chip (only the active row counts)", async () => {
    expect(await hasActiveMicrochip(petIds.replacedChip)).toBe(false);
  });

  it("cannot be fed a codeless chip row — the DB refuses one (chip_requires_iso_fields)", async () => {
    // The helper carries `isNotNull(code)` for parity with
    // rowsToIdentifications (which needs `row.code` truthy before it builds a
    // microchip object). Postgres makes that branch unreachable: a
    // microchip_iso row must carry a 15-char code. Pinned so a future
    // relaxation of the constraint surfaces here instead of silently making
    // the two helpers disagree about what "has a chip" means.
    // Drizzle wraps the driver error, so the constraint name lives on `cause`.
    const err: unknown = await db
      .insert(petIdentifications)
      .values({
        id: randomUUID(),
        petId: petIds.codelessChip,
        kind: "microchip_iso",
        status: "active",
        code: null,
      })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).not.toBeNull();
    expect(String((err as { cause?: unknown })?.cause ?? err)).toContain(
      "chip_requires_iso_fields",
    );
    expect(await hasActiveMicrochip(petIds.codelessChip)).toBe(false);
  });

  it("is false for a pet whose only identification is a tattoo", async () => {
    expect(await hasActiveMicrochip(petIds.tattooOnly)).toBe(false);
  });
});

describe("/adoptar/[petToken] — the ficha never reaches for the code (PO-1)", () => {
  const source = readFileSync(
    new URL("../app/(public)/adoptar/[petToken]/page.tsx", import.meta.url),
    "utf8",
  );

  it("does not fetch the canonical identification rows (which carry the code)", () => {
    expect(source).not.toContain("fetchActiveIdentifications");
    expect(source).toContain("hasActiveMicrochip");
  });

  it("renders no masked microchip fragment", () => {
    // The masking dots are the exact artifact the PO removed: a partial
    // identifier shown to an anonymous visitor is still an identifier.
    expect(source).not.toContain("••••");
    expect(source).not.toContain("slice(-4)");
  });
});
