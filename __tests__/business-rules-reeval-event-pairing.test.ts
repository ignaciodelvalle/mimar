// Integration test: the PPP re-evaluation sweep must emit a paired pet_events
// fact whenever it flips pets.potentiallyDangerousBreed (F4, review 22/1d).
//
// pets.potentiallyDangerousBreed is a dual-write cache. Before this fix the
// sweep flipped it with a bare UPDATE and NO corresponding event — an
// event-pairing violation (Invariant #3): the classification change existed
// only in the cache, unauditable and non-replayable. Now the flip + a
// system-authored pet_profile_updated commit in one tx.
//
// Runs against the local Postgres (vitest setup forces 127.0.0.1:54322).

import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import { reEvaluatePppClassificationChange } from "@/lib/infra/business-rules-reeval";
import { withMutationOverride } from "./_helpers/db-overrides";

const ACTOR_ID = "22222222-3333-4444-8555-888888888888";
// A canonical province (CHECK constraint pets_jurisdiction_province_canonical)
// paired with a locality UNIQUE to this run so the locality-scoped sweep only
// touches our pet. No jurisdiction rule row exists for this locality, so
// classification falls back to the DEFAULT ppp_breed_list (which lists the
// pit-bull breed below) and flips to true.
const TEST_PROVINCE = "Tierra del Fuego";
const TEST_LOCALITY = `ReevalPairLocality-${Date.now()}`;
const insertedPetIds: string[] = [];

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${ACTOR_ID}::uuid, 'reeval-pairing-actor@dim-test.local',
      'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  await db
    .insert(profiles)
    .values({
      id: ACTOR_ID,
      role: "owner",
      accountType: "personal",
      displayName: "reeval-pairing-actor",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
});

describe("reEvaluatePppClassificationChange — event pairing (F4)", () => {
  it("emits a pet_profile_updated fact when it flips potentiallyDangerousBreed", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `REEVALPAIR-${Date.now()}`,
        name: "ReevalPairDog",
        species: "dog",
        sex: "male",
        status: "active",
        breed: "American Pit Bull Terrier", // in the default PPP breed list
        potentiallyDangerousBreed: false, // stale — the sweep should flip it
        jurisdictionCountry: "AR",
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: TEST_LOCALITY,
      })
      .returning();
    insertedPetIds.push(pet.id);
    await db.insert(ownerships).values({ petId: pet.id, ownerUserId: ACTOR_ID, role: "owner" });

    const result = await reEvaluatePppClassificationChange({
      country: "AR",
      province: TEST_PROVINCE,
      locality: TEST_LOCALITY,
    });

    expect(result.flippedToPpp).toBe(1);

    // Flag flipped in the cache.
    const [after] = await db
      .select({ ppp: pets.potentiallyDangerousBreed })
      .from(pets)
      .where(eq(pets.id, pet.id));
    expect(after.ppp).toBe(true);

    // Paired fact emitted (the fix under test): a system-authored
    // pet_profile_updated carrying the single flag change.
    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "pet_profile_updated")));
    expect(events).toHaveLength(1);
    expect(events[0].authorRole).toBe("system");
    expect(events[0].recordedByUserId).toBeNull();
    const changes = (
      events[0].payload as { changes: { field: string; old: unknown; new: unknown }[] }
    ).changes;
    expect(changes).toEqual([{ field: "potentially_dangerous_breed", old: false, new: true }]);
  });
});
