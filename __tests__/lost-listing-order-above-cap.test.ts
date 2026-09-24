// Regression: /perdidas must order the fetch SUPERSET, not just the page.
//
// queryLostListing pulls a `fetchCap` superset, sorts it by markedLostAt in JS,
// and slices the page out of that. Until 2026-08-01 the superset LIMIT ran with
// no ORDER BY. Below the cap nothing is wrong — the limit takes every row and
// the JS sort is the whole answer. Past it, Postgres returns an ARBITRARY set,
// the JS sort orders that accidental window, and the page presents it as "the
// most recent".
//
// Staging crossed the line with 4011 lost pets. The three genuinely newest were
// absent from page 1, and one of them was the only lost pet in the database
// carrying a photo. Found by diffing the live page against an ORDER BY query —
// no test saw it, because every existing lost-listing fixture is far under 500.
//
// WHY THE CAP IS OVERRIDDEN HERE: reproducing it at the real 500 needs 500+
// pets AND 500+ spine events, and pet_events cannot be torn down — deleting a
// pet cascades into it and the append-only trigger refuses (verified
// 2026-08-01). Teardown would have to go through the audited
// app.allow_event_mutation hatch and leave 500 override rows in audit_log for
// every run. The defect is about ORDERING, which is indifferent to the
// constant, so the same mechanism is probed at six rows.
//
// THE PROBE: five filler pets are inserted first, then the needle — newest by
// timestamp, physically last in the heap. An unordered `LIMIT 5` returns the
// physically-first five and drops it. That is what makes this fail against the
// old code rather than pass by luck. It is a seq-scan assumption and it is the
// one part that could rot: if this ever starts passing against an unordered
// LIMIT, the fixture stopped being a probe — the bug did not stop existing.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { queryLostListing } from "@/src/modules/lost/infrastructure/lost-listing-read";
import { withMutationOverride } from "./_helpers/db-overrides";

const TOKEN_PREFIX = "DIM-CAPT";
const NEEDLE_TOKEN = `${TOKEN_PREFIX}-NEEDLE`;
const FILLER_COUNT = 5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TEST_FETCH_CAP = FILLER_COUNT; // one short of the total — the needle falls off

// The pets rows are disposable; their events are not. Deleting a pet cascades
// into pet_events and the append-only trigger refuses, so teardown routes
// through the documented override hatch (migration 0127, Path 1). The hatch
// demands an actor uuid that EXISTS in profiles — accountability is enforced by
// a foreign key, not by convention — and writes one audit_log row per event.
// withMutationOverride already resolves that actor and scopes the grant to a
// single transaction; do not hand-roll the GUCs.
async function purge() {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`})`,
    );
    await tx.execute(sql`DELETE FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}%`}`);
  });
}

describe("queryLostListing — the fetch superset is ordered", () => {
  beforeAll(async () => {
    await purge();

    // The needle has to be the newest lost pet in the WHOLE database, not just
    // the newest in this fixture — the assertion reads position 0 of a page
    // drawn from every lost pet present. A hardcoded date would silently stop
    // being newest the day a seed lands past it, and the test would fail for a
    // reason that has nothing to do with ordering. So derive it.
    const [{ newest }] = (await db.execute(sql`
      SELECT coalesce(max(e.occurred_at), now()) AS newest
      FROM pet_events e
      JOIN pets p ON p.id = e.pet_id AND p.status = 'lost'
      WHERE e.event_type = 'status_changed' AND e.payload->>'to_status' = 'lost'
    `)) as Array<{ newest: Date | string }>;
    const base = new Date(newest).getTime() + ONE_DAY_MS;

    const filler = await db
      .insert(pets)
      .values(
        Array.from({ length: FILLER_COUNT }, (_, i): typeof pets.$inferInsert => ({
          publicToken: `${TOKEN_PREFIX}-${String(i).padStart(4, "0")}`,
          name: `Relleno ${i}`,
          species: "dog",
          status: "lost",
        })),
      )
      .returning({ id: pets.id });

    const [needle] = await db
      .insert(pets)
      .values({
        publicToken: NEEDLE_TOKEN,
        name: "Aguja Regresion Cap",
        species: "dog",
        status: "lost",
      })
      .returning({ id: pets.id });

    const event = (petId: string, occurredAt: Date) => ({
      petId,
      eventType: "status_changed" as const,
      occurredAt,
      recordedAt: occurredAt,
      authorRole: "owner" as const,
      authorVerified: false,
      payload: { from_status: "active", to_status: "lost" },
    });

    await db.insert(petEvents).values([
      ...filler.map((row, i) => event(row.id, new Date(base + i * 60_000))),
      // A year past the newest filler — unambiguously first in any correct order.
      event(needle.id, new Date(base + 365 * ONE_DAY_MS)),
    ]);
  });

  afterAll(purge);

  it("returns the newest lost pet first even when it sits past the fetch cap", async () => {
    const { items } = await queryLostListing({}, null, 24, TEST_FETCH_CAP);

    const tokens = items.map((i) => i.petPublicToken);
    // FIRST, not merely present: asserting presence would still pass if the cap
    // happened to include the needle while the ordering stayed broken.
    expect(tokens[0]).toBe(NEEDLE_TOKEN);
  });
});
