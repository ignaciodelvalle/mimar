// Armed fence for the ONE-LIVE-ORGANISATION-SHELTER-CUSTODY-PER-PET index
// (rehome-by-titular, WU3 — design ADR-1, task 3.8; scoped to organisations by
// the WU3 review, H-1).
//
// THE RACE THIS INDEX CLOSES
// ---------------------------------------------------------------------------
// `ownerships_one_active_owner_per_pet` covers `role='owner'` only. Before 0195
// the only shelter_custody index was PER (pet, org) — so two orgs could both
// hold live custody of one animal at once, which is exactly what two concurrent
// accepts of the same rehome request would produce, permanently, with nothing
// to detect it. The accept transaction takes `SELECT ... FOR UPDATE` on the
// case (mitigation 1); this index is mitigation 2, and it is the one that holds
// when the lock is bypassed by a path nobody wrote yet.
//
// WHY IT IS SCOPED TO `owner_organization_id IS NOT NULL`
// ---------------------------------------------------------------------------
// `shelter_custody` is ALSO written with a user holder: a neighbour who picks
// up a found pet (confirm-chip-match-vecino.ts). The per-(pet, org) index
// treated NULL orgs as distinct, so two neighbours finding the same lost pet
// weeks apart were never constrained — and ADR-1 only ever needed "two
// ORGANISATIONS cannot both hold live custody". A per-pet index would have
// turned the second neighbour's confirmation into an unhandled 23505. So the
// predicate says organisations, and the user-held population keeps its
// pre-0195 behaviour, on purpose and documented here.
//
// WHY THIS HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The invariant IS a partial unique index. A mocked repository has no index; a
// mocked test passes against a database that lost it. Same reasoning as
// __tests__/rehome-finalize-ownership.test.ts's armed-fence control.
//
// TEST ORDER IS LOAD-BEARING: the cases build on one another's rows.

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, organizations, ownerships, petEvents, pets, profiles } from "@/db";

import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

const ORG_A_TOKEN = "DIM-RHIX-0001";
const ORG_B_TOKEN = "DIM-RHIX-0002";
const PET_TOKEN = "DIM-RHIX-PET1";

const NEW_INDEX = "ownerships_one_active_org_shelter_custody_per_pet";
/** 0077's per-(pet, org) index, dropped by 0195. */
const SUPERSEDED_INDEX = "ownerships_one_active_shelter_custody_per_pet_org";
/** WU3's first draft of 0195 — per pet, any holder. Never published; must not exist. */
const DRAFT_PER_PET_INDEX = "ownerships_one_active_shelter_custody_per_pet";

const vecino1Id = randomUUID();
const vecino2Id = randomUUID();

let orgAId: string;
let orgBId: string;
let petId: string;
let firstCustodyId: string;

async function purge(): Promise<void> {
  await withMutationOverride(async (tx) => {
    const stale = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stale) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
    await tx
      .delete(profiles)
      .where(sql`${profiles.displayName} IN ('Rehome Index Vecino 1', 'Rehome Index Vecino 2')`);
  });
  for (const token of [ORG_A_TOKEN, ORG_B_TOKEN]) {
    await db.delete(organizations).where(eq(organizations.publicToken, token));
  }
}

beforeAll(async () => {
  await purge();
  const [a] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_A_TOKEN,
      legalName: "Rehome Index Refugio A",
      displayName: "Refugio A",
      orgType: "shelter",
      email: "rehome-index-a@dim-test.local",
      verified: true,
    })
    .returning({ id: organizations.id });
  const [b] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_B_TOKEN,
      legalName: "Rehome Index Refugio B",
      displayName: "Refugio B",
      orgType: "shelter",
      email: "rehome-index-b@dim-test.local",
      verified: true,
    })
    .returning({ id: organizations.id });
  orgAId = a.id;
  orgBId = b.id;

  // Two neighbours — the user-held shelter_custody population the index must
  // leave alone.
  await db.insert(profiles).values([
    { id: vecino1Id, displayName: "Rehome Index Vecino 1", role: "owner", accountType: "personal" },
    { id: vecino2Id, displayName: "Rehome Index Vecino 2", role: "owner", accountType: "personal" },
  ]);

  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Índice", species: "dog", sex: "male" })
    .returning({ id: pets.id });
  petId = pet.id;

  const [custody] = await db
    .insert(ownerships)
    .values({ petId, ownerOrganizationId: orgAId, role: "shelter_custody", startedAt: new Date() })
    .returning({ id: ownerships.id });
  firstCustodyId = custody.id;
});

afterAll(async () => {
  await purge();
});

async function liveCustodyRows(): Promise<
  Array<{ id: string; orgId: string | null; userId: string | null }>
> {
  return db
    .select({
      id: ownerships.id,
      orgId: ownerships.ownerOrganizationId,
      userId: ownerships.ownerUserId,
    })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    );
}

describe("ownerships — one live ORGANISATION shelter_custody row per pet", () => {
  it("a second org's live custody row on the same pet raises 23505 on the org-scoped index", async () => {
    const info = await expectDbError(
      db.insert(ownerships).values({
        petId,
        ownerOrganizationId: orgBId,
        role: "shelter_custody",
        startedAt: new Date(),
      }),
      { code: "23505", constraint: NEW_INDEX },
    );
    expect(info?.constraint).toBe(NEW_INDEX);
  });

  it("the same org twice is caught by the SAME index — the per-(pet,org) one is gone", async () => {
    const info = await expectDbError(
      db.insert(ownerships).values({
        petId,
        ownerOrganizationId: orgAId,
        role: "shelter_custody",
        startedAt: new Date(),
      }),
      { code: "23505", constraint: NEW_INDEX },
    );
    expect(info?.constraint).toBe(NEW_INDEX);
  });

  it("neither rejected insert landed — exactly one live custody row remains", async () => {
    const live = await liveCustodyRows();
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(firstCustodyId);
  });

  it("a neighbour's user-held custody row coexists with the org's — the index is scoped to organisations", async () => {
    await db.insert(ownerships).values({
      petId,
      ownerUserId: vecino1Id,
      role: "shelter_custody",
      startedAt: new Date(),
    });
    const live = await liveCustodyRows();
    expect(live.map((r) => r.orgId ?? r.userId).sort()).toEqual([orgAId, vecino1Id].sort());
  });

  it("two neighbours' rows coexist too — user-held custody keeps its pre-0195 behaviour, on purpose", async () => {
    // The per-(pet, org) index never constrained NULL orgs; 0195 does not start
    // to. This case documents that the population is untouched, not fixed.
    await db.insert(ownerships).values({
      petId,
      ownerUserId: vecino2Id,
      role: "shelter_custody",
      startedAt: new Date(),
    });
    const live = await liveCustodyRows();
    expect(live).toHaveLength(3);
    expect(live.filter((r) => r.userId !== null)).toHaveLength(2);
    expect(live.filter((r) => r.orgId !== null).map((r) => r.orgId)).toEqual([orgAId]);
  });

  it("an ENDED org row frees the slot for the next org — the index is partial on ended_at", async () => {
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(eq(ownerships.id, firstCustodyId));
    await db.insert(ownerships).values({
      petId,
      ownerOrganizationId: orgBId,
      role: "shelter_custody",
      startedAt: new Date(),
    });
    const live = await liveCustodyRows();
    expect(live.filter((r) => r.orgId !== null).map((r) => r.orgId)).toEqual([orgBId]);
    // The two neighbours are still there: ending an org row touches nothing else.
    expect(live.filter((r) => r.userId !== null)).toHaveLength(2);
  });

  it("pg_indexes: the superseded and the draft indexes are absent; the org-scoped one carries the full predicate", async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'ownerships'
        AND indexname IN (${NEW_INDEX}, ${SUPERSEDED_INDEX}, ${DRAFT_PER_PET_INDEX})
    `);
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.has(SUPERSEDED_INDEX)).toBe(false);
    expect(byName.has(DRAFT_PER_PET_INDEX)).toBe(false);
    const def = byName.get(NEW_INDEX);
    expect(def).toContain("UNIQUE INDEX");
    expect(def).toContain("(pet_id)");
    expect(def).toContain("shelter_custody");
    expect(def).toContain("ended_at IS NULL");
    expect(def).toContain("owner_organization_id IS NOT NULL");
  });
});
