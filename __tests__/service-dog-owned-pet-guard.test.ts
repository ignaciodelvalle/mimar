// `loadOwnedPetWithServiceDog` — the one guard all four owner service-dog
// use-cases resolve the pet through, on both doors (the web actions and
// `POST /api/v1/pets/{token}/profile`).
//
// WHAT THIS HAS TO PROVE: a DECEASED animal resolves to nothing, so no door can
// file a verification request for a dead dog into the authority's queue. The
// live owner still resolves, so the refusal is the status and not the fixture.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, pets } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { loadOwnedPetWithServiceDog } from "@/src/modules/pets/application/service-dog/helpers";

let userId: string;
const created: Array<{ id: string; publicToken: string }> = [];

async function ownedDog(status: "active" | "deceased") {
  const publicToken = generatePublicToken();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken,
      species: "dog",
      name: `ServiceDogGuard-${status}`,
      potentiallyDangerousBreed: false,
      status,
      deceasedAt: status === "deceased" ? new Date() : null,
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: userId,
    role: "owner",
    startedAt: new Date(),
  });
  created.push({ id: pet.id, publicToken });
  return publicToken;
}

beforeAll(async () => {
  const [profile] = await db.execute<{ id: string }>(
    sql`SELECT id FROM auth.users WHERE email = 'owner@dim.test' LIMIT 1`,
  );
  if (!profile?.id) throw new Error("seed user owner@dim.test missing — run `pnpm seed:test`");
  userId = profile.id;
});

afterAll(async () => {
  for (const pet of created) {
    await db.delete(ownerships).where(eq(ownerships.petId, pet.id));
    await db.delete(pets).where(eq(pets.id, pet.id));
  }
});

describe("loadOwnedPetWithServiceDog", () => {
  it("resolves the legal owner's living dog", async () => {
    const token = await ownedDog("active");
    const target = await loadOwnedPetWithServiceDog(userId, token);
    expect(target?.pet.publicToken).toBe(token);
  });

  it("resolves NOTHING for a deceased dog, so every owner use-case refuses", async () => {
    const token = await ownedDog("deceased");
    expect(await loadOwnedPetWithServiceDog(userId, token)).toBeNull();
  });
});
