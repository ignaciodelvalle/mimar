// WP0 / A2 — registryCounts integration regression.
//
// Regression: registryCounts() interpolated a raw JS Date into a sql`` fragment
// for the dormancy cutoff. postgres-js (prepare:false) tried to serialize the
// Date via a Buffer/string path and threw ERR_INVALID_ARG_TYPE ("Received an
// instance of Date"), which crashed /admin/programa, /censo and /poblacion.
// The fix binds dormancyCutoff.toISOString(). This test proves registryCounts
// resolves against real Postgres with a real period.until and returns the
// expected dormant/active/total/incomplete counts.
//
// Integration test — requires the local Supabase + Postgres stack.

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext, registryCounts } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "./_helpers/db-overrides";

// Unique jurisdiction so the govt-scoped query sees ONLY these fixtures and is
// not polluted by the national seed. The locality string is invented; the
// province must be a canonical name (24-value CHECK constraint).
const PROVINCE = "Santa Fe";
const LOCALITY = "WP0-CENSUS-REGISTRY-ISO";

const fixtureIds: string[] = [];

async function insertPet(token: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: token,
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  fixtureIds.push(row.id);
  return row.id;
}

async function insertOwnerEvent(petId: string, occurredAt: Date): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "weight_recorded",
    occurredAt,
    payload: { payload_version: 1, weight_kg: 12 },
    authorRole: "owner",
    recordedByUserId: null,
  });
}

/**
 * Remove the fixtures by their JURISDICTION, not by an in-memory id list.
 *
 * IT USED TO BE `inArray(pets.id, fixtureIds)` GUARDED BY
 * `if (fixtureIds.length === 0) return`, and that combination made the
 * `beforeAll` pre-clean structurally incapable of doing its job: `fixtureIds` is
 * module state, so in a fresh process it is empty and the guard returns before
 * touching anything. The pre-clean only ever cleaned up after ITSELF, within one
 * run.
 *
 * That was fine until a vitest worker died mid-file (2026-08-26). `afterAll`
 * never ran, three `pets` rows survived with their tokens, and every subsequent
 * run of this file — on any branch, by any author — failed on
 * `pets_public_token_unique` for `DIM-WP0-RECENT`. A crashed worker left a
 * booby trap that looked like a code defect in whatever change ran next.
 *
 * `LOCALITY` is the durable handle, and the file already invented it for
 * exactly this property: the header says it is a unique jurisdiction so the
 * govt-scoped query sees ONLY these fixtures. Deleting by it clears debris from
 * a previous process as well as from this one.
 */
async function cleanup() {
  const orphans = await db
    .select({ id: pets.id })
    .from(pets)
    .where(eq(pets.jurisdictionLocality, LOCALITY));
  fixtureIds.length = 0;
  if (orphans.length === 0) return;

  const ids = orphans.map((row) => row.id);
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(pets).where(inArray(pets.id, ids));
}

beforeAll(async () => {
  await cleanup();

  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  // pet1: recent owner activity (now) → NOT dormant.
  const pet1 = await insertPet("DIM-WP0-RECENT");
  await insertOwnerEvent(pet1, now);

  // pet2: only old owner activity (2 years ago, past the 12m cutoff) → dormant.
  const pet2 = await insertPet("DIM-WP0-STALE");
  await insertOwnerEvent(pet2, twoYearsAgo);

  // pet3: no qualifying events at all → dormant.
  await insertPet("DIM-WP0-EMPTY");
});

afterAll(cleanup);

describe("registryCounts — dormancy cutoff binds an ISO string, not a raw Date", () => {
  it("resolves without ERR_INVALID_ARG_TYPE and returns the expected counts", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: PROVINCE, locality: LOCALITY }],
      windows.trailing12m(),
    );

    const counts = await registryCounts(ctx);

    expect(counts.total).toBe(3);
    expect(counts.active).toBe(3);
    // pet2 (stale) + pet3 (no events) are dormant; pet1 (recent) is not.
    expect(counts.dormant).toBe(2);
    // none have an active microchip_iso → all incomplete.
    expect(counts.incomplete).toBe(3);
    // byLocality resolves (the single cell is k-anon suppressed at k=5).
    expect(counts.byLocality).toBeDefined();
  });

  it("honours a custom dormancy threshold without throwing", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: PROVINCE, locality: LOCALITY }],
      windows.trailing12m(),
    );

    // A 36-month threshold pushes the cutoff before pet2's 2-year-old event, so
    // only pet3 (no events) stays dormant.
    const counts = await registryCounts(ctx, 36);
    expect(counts.dormant).toBe(1);
  });
});
