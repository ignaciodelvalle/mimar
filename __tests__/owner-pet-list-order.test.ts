// The owner's pet list must come back in ONE order, not a different one per load.
//
// Every owner list is `ORDER BY pets.created_at DESC` with a cap (200 for the
// web index and `GET /api/v1/me/pets`, 50 for the dashboard). `created_at` is
// defaulted from Postgres's `now()`, which is the TRANSACTION start — so every
// pet written by one statement or one transaction shares it exactly. The nightly
// e2e creates more than 200 that way, and with nothing after `created_at` in the
// ORDER BY, Postgres is free to break the tie differently on every execution:
// the capped page was a different SUBSET per load, and the uncapped carousel
// ranking a different order.
//
// The fix is a unique secondary key (`pets.id`, then `ownerships.id`). These
// cases seed more tied pets than the largest cap and assert the order is the
// one that key defines — which is the property, and which a merely-repeatable
// heap order would not satisfy by accident — plus that two reads agree.
//
// Seed: one statement, one explicit `created_at` taken from the DATABASE's
// clock (`dbNow`), never the host's. Cleanup deletes the fixture pets (their
// ownerships cascade) and the user; nothing here touches `audit_log`.

import { createClient } from "@supabase/supabase-js";
import { like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, pets } from "@/db";
import {
  fetchLivePetsForCarouselRanking,
  fetchPetsForOwner,
} from "@/lib/analytics/owner-dashboard";
import {
  OWNER_PET_LIST_LIMIT,
  listOwnerPets,
} from "@/src/modules/pets/application/read/list-owner-pets";
import { dbNow } from "./_helpers/db-now";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL = "owner-pet-list-order@dim-test.local";
const PASS = "OwnerListOrder_2026!";

/** Every fixture pet's token starts with this, so a dead run's residue is findable. */
const TOKEN_PREFIX = "ORDER-TIE-";

/** More tied pets than the largest cap, so WHICH ones survive it is in question. */
const TIED_PET_COUNT = OWNER_PET_LIST_LIMIT + 50;

let userId: string;
/** The fixture's pet ids in the order the tiebreak defines: id descending. */
let expectedOrder: string[];

async function removeFixturePets(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.delete(pets).where(like(pets.publicToken, `${TOKEN_PREFIX}%`));
  });
}

beforeAll(async () => {
  // A run that died before `afterAll` leaves its pets behind; they would join
  // this run's tie and belong to nobody.
  await removeFixturePets();

  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  userId = data.user.id;

  const createdAt = await dbNow();
  const inserted = await db
    .insert(pets)
    .values(
      Array.from({ length: TIED_PET_COUNT }, (_, idx) => ({
        publicToken: `${TOKEN_PREFIX}${String(idx).padStart(5, "0")}`,
        name: `Empate ${idx}`,
        species: "dog" as const,
        sex: "unknown" as const,
        status: "active" as const,
        createdAt,
      })),
    )
    .returning({ id: pets.id });
  await db
    .insert(ownerships)
    .values(inserted.map(({ id }) => ({ petId: id, ownerUserId: userId, role: "owner" as const })));

  // Postgres orders uuids bytewise, which is the order of their canonical
  // lowercase hex text — so a plain string sort IS the database's order.
  expectedOrder = inserted.map(({ id }) => id).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}, 60_000);

afterAll(async () => {
  await removeFixturePets();
  await deleteTestUser(admin, db, EMAIL);
}, 60_000);

describe("owner pet lists — many pets registered at the same instant", () => {
  it("seeds a tie wider than the cap (precondition)", () => {
    expect(expectedOrder).toHaveLength(TIED_PET_COUNT);
  });

  it("listOwnerPets returns the same capped page, in the tiebreak's order, every time", async () => {
    const first = await listOwnerPets({ ownerUserId: userId });
    const second = await listOwnerPets({ ownerUserId: userId });

    const firstIds = first.rows.map((r) => r.pet.id);
    expect(first.total).toBe(TIED_PET_COUNT);
    expect(firstIds).toEqual(expectedOrder.slice(0, OWNER_PET_LIST_LIMIT));
    expect(second.rows.map((r) => r.pet.id)).toEqual(firstIds);
  });

  it("fetchPetsForOwner returns the same capped page, in the tiebreak's order, every time", async () => {
    const first = await fetchPetsForOwner(userId);
    const second = await fetchPetsForOwner(userId);

    const firstIds = first.pets.map((p) => p.id);
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds).toEqual(expectedOrder.slice(0, firstIds.length));
    expect(second.pets.map((p) => p.id)).toEqual(firstIds);
  });

  it("fetchLivePetsForCarouselRanking returns every pet in the tiebreak's order, every time", async () => {
    const first = await fetchLivePetsForCarouselRanking(userId);
    const second = await fetchLivePetsForCarouselRanking(userId);

    const firstIds = first.map((p) => p.id);
    expect(firstIds).toEqual(expectedOrder);
    expect(second.map((p) => p.id)).toEqual(firstIds);
  });
});
