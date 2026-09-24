// Regression: a whitespace-only `location_description` must not hide the
// `last_known_location` fallback (fresh-context review, pre-push, item 4).
//
// queryLostListing's origin-event projection used to be a bare
// `coalesce(payload->>'location_description', payload->>'last_known_location')`.
// Postgres's coalesce treats a whitespace-only string as non-null, so a row
// carrying `location_description: " "` picked that blank value over a real
// `last_known_location` — the downstream JS-level trim then turned the blank
// pick into `null`, and the card rendered NO location at all even though a
// perfectly good fallback address sat right there in the same payload.
//
// Fixed by wrapping both keys in `nullif(trim(...), '')` inside the SQL
// coalesce itself, so a whitespace-only value is treated as absent and the
// coalesce actually falls through.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { queryLostListing } from "@/src/modules/lost/infrastructure/lost-listing-read";
import { withMutationOverride } from "./_helpers/db-overrides";

const TOKEN_PREFIX = "DIM-BLNK";
const NEEDLE_TOKEN = `${TOKEN_PREFIX}-NEEDLE`;

async function purge() {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`})`,
    );
    await tx.execute(sql`DELETE FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`}`);
  });
}

describe("queryLostListing — whitespace-only location_description falls through", () => {
  beforeAll(async () => {
    await purge();

    const [needle] = await db
      .insert(pets)
      .values({
        publicToken: NEEDLE_TOKEN,
        name: "Blanco Regresion",
        species: "dog",
        status: "lost",
        discloseLastLocationWhenLost: true,
      })
      .returning({ id: pets.id });

    await db.insert(petEvents).values([
      {
        petId: needle.id,
        eventType: "status_changed",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "owner",
        authorVerified: false,
        payload: {
          from_status: "active",
          to_status: "lost",
          // Whitespace-only canonical key — must NOT win over the real fallback.
          location_description: "   ",
          last_known_location: "Plaza San Martín, Retiro",
        },
      },
    ]);
  });

  afterAll(purge);

  it("falls back to last_known_location instead of rendering a blank", async () => {
    const { items } = await queryLostListing({}, null, 24, 500);
    const needleItem = items.find((i) => i.petPublicToken === NEEDLE_TOKEN);

    expect(needleItem).toBeDefined();
    expect(needleItem?.lastSeenDescription).toBe("Plaza San Martín, Retiro");
  });
});
