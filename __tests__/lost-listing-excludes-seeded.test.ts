// /perdidas never offers a seeded (synthetic) pet — security review 2026-09.
//
// lib/metrics/scope.ts hides every case and event whose PET carries seed_tag
// from the govt queues. /perdidas used to list seeded lost pets like any other,
// so a real neighbour could report a sighting on one and that real act vanished
// from the govt side. The listing, its counts and (through the listing) the
// sitemap now leave seeded pets out; curated demo pets carry no seed_tag and
// stay. The sighting refusal itself is pinned in pet-sighting-action.test.ts.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import {
  countAllLost,
  queryLostListing,
} from "@/src/modules/lost/infrastructure/lost-listing-read";
import { withMutationOverride } from "./_helpers/db-overrides";

const TOKEN_PREFIX = "DIM-SEEDLL";
const SEEDED_TOKEN = `${TOKEN_PREFIX}-SEED`;
const REAL_TOKEN = `${TOKEN_PREFIX}-REAL`;
// A locality nobody else uses, so the page holds exactly this fixture.
const LOCALITY = "Localidad Prueba Sintetica";

async function purge() {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`})`,
    );
    await tx.execute(sql`DELETE FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`}`);
  });
}

async function insertLostPet(publicToken: string, seedTag: string | null) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken,
      name: publicToken,
      species: "dog",
      status: "lost",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: LOCALITY,
      seedTag,
    })
    .returning({ id: pets.id });
  const occurredAt = new Date("2026-09-01T12:00:00.000Z");
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "status_changed",
    occurredAt,
    recordedAt: occurredAt,
    authorRole: "owner",
    authorVerified: false,
    payload: { from_status: "active", to_status: "lost" },
  });
}

describe("queryLostListing / countAllLost — seeded pets are not offered", () => {
  beforeAll(purge);
  afterAll(purge);

  it("leaves the seeded pet out of the count and the page, and keeps the real one", async () => {
    const before = await countAllLost();

    await insertLostPet(SEEDED_TOKEN, "panorama");
    expect(await countAllLost()).toBe(before);

    await insertLostPet(REAL_TOKEN, null);
    expect(await countAllLost()).toBe(before + 1);

    const { items } = await queryLostListing({ locality: LOCALITY }, null, 24);
    expect(items.map((i) => i.petPublicToken)).toEqual([REAL_TOKEN]);
  });
});
