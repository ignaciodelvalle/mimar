// Tests for lib/tattoo-lookup.ts — D2 cross-check.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petIdentifications, pets } from "@/db";
import { lookupByTattoo, normalizeTattooCode } from "@/lib/infra/tattoo-lookup";
import { withMutationOverride } from "./_helpers/db-overrides";

let petAId: string;
let petBId: string;
let petB2Id: string;

beforeAll(async () => {
  // Clean any prior fixtures keyed on our test codes.
  // ARCH-S: tattoo_code column dropped from pets — scan pet_identifications instead.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT DISTINCT pet_id FROM pet_identifications WHERE kind = 'tattoo' AND code IN ('LOOKUP-A', 'LOOKUP-DUP')
    )`);
    await tx.execute(sql`DELETE FROM attachments WHERE pet_id IN (
      SELECT DISTINCT pet_id FROM pet_identifications WHERE kind = 'tattoo' AND code IN ('LOOKUP-A', 'LOOKUP-DUP')
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT DISTINCT pet_id FROM pet_identifications WHERE kind = 'tattoo' AND code IN ('LOOKUP-A', 'LOOKUP-DUP')
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE id IN (
      SELECT DISTINCT pet_id FROM pet_identifications WHERE kind = 'tattoo' AND code IN ('LOOKUP-A', 'LOOKUP-DUP')
    )`);
  });

  const today = new Date().toISOString().slice(0, 10);

  const [petA] = await db
    .insert(pets)
    .values({
      publicToken: `TAT-LU-A-${Date.now()}`,
      name: "Lookup Test A",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning();
  petAId = petA.id;
  await db.insert(petIdentifications).values({
    petId: petAId,
    kind: "tattoo",
    code: "LOOKUP-A",
    tattooLocation: "inner_ear_left",
    recordedAt: today,
  });

  const [petB] = await db
    .insert(pets)
    .values({
      publicToken: `TAT-LU-B-${Date.now()}`,
      name: "Lookup Test B (dup)",
      species: "dog",
      sex: "female",
      status: "lost",
    })
    .returning();
  petBId = petB.id;
  await db.insert(petIdentifications).values({
    petId: petBId,
    kind: "tattoo",
    code: "LOOKUP-DUP",
    tattooLocation: "belly",
    recordedAt: today,
  });

  // Second pet with the SAME code to exercise the collision behavior.
  const [petB2] = await db
    .insert(pets)
    .values({
      publicToken: `TAT-LU-B2-${Date.now()}`,
      name: "Lookup Test B2 (collision)",
      species: "cat",
      sex: "male",
      status: "active",
    })
    .returning();
  petB2Id = petB2.id;
  await db.insert(petIdentifications).values({
    petId: petB2Id,
    kind: "tattoo",
    code: "LOOKUP-DUP",
    tattooLocation: "inner_thigh",
    recordedAt: today,
  });
});

afterAll(async () => {
  // ARCH-S: tattoo_code column dropped from pets — scan pet_identifications.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT DISTINCT pet_id FROM pet_identifications WHERE kind = 'tattoo' AND code IN ('LOOKUP-A', 'LOOKUP-DUP')
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE id IN (
      SELECT DISTINCT pet_id FROM pet_identifications WHERE kind = 'tattoo' AND code IN ('LOOKUP-A', 'LOOKUP-DUP')
    )`);
  });
});

describe("normalizeTattooCode", () => {
  it("matches the writer's normalization (uppercase + collapse whitespace)", () => {
    expect(normalizeTattooCode("lookup-a")).toBe("LOOKUP-A");
    expect(normalizeTattooCode("  lookup a  ")).toBe("LOOKUPA");
    expect(normalizeTattooCode("X")).toBe("X");
    expect(normalizeTattooCode("")).toBe("");
  });
});

describe("lookupByTattoo", () => {
  it("returns null when no pet matches", async () => {
    const result = await lookupByTattoo("DOES-NOT-EXIST-XYZ");
    expect(result).toBeNull();
  });

  it("returns the pet when the normalized code matches", async () => {
    const result = await lookupByTattoo("LOOKUP-A");
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected match");
    expect(result.pet.id).toBe(petAId);
    expect(result.pet.name).toBe("Lookup Test A");
    expect(result.pet.tattooLocation).toBe("inner_ear_left");
    expect(result.pet.status).toBe("active");
  });

  it("normalizes input before querying (whitespace + case)", async () => {
    const result = await lookupByTattoo("  lookup-a  ");
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected match");
    expect(result.pet.id).toBe(petAId);
  });

  it("returns one match when codes collide across pets — caller resolves ambiguity", async () => {
    const result = await lookupByTattoo("LOOKUP-DUP");
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected match");
    // We don't assert WHICH of the two matches — only that the lookup picks one
    // and the semantic contract holds: "posible coincidencia, verificá con foto".
    // Caller resolves ambiguity via the photo, never the lookup.
    expect([petBId, petB2Id]).toContain(result.pet.id);
    expect(["active", "lost"]).toContain(result.pet.status);
  });

  it("returns null for empty / whitespace-only input", async () => {
    expect(await lookupByTattoo("")).toBeNull();
    expect(await lookupByTattoo("   ")).toBeNull();
  });
});
