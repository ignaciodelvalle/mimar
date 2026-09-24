// Tests for lib/org-census.ts — Wave 3 Item 16: Shelter census & occupancy.
//
// Coverage (as per spec):
//   1. Occupancy projection over a seed of shelter_custody rows; excludes non-custody.
//   2. Capacity nullable → census without %.
//   3. Additive migration doesn't break existing orgs (smoke: existing rows unaffected).
//
// Integration tests run against the local Supabase + Postgres stack (127.0.0.1:54321/54322).
// The suite creates ephemeral orgs + ownerships and cleans them up in afterEach.

import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db, organizations, ownerships, pets } from "@/db";
import { computeOccupancyBreakdown, fetchOrgCensus } from "@/lib/analytics/org-census";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

// Fixture tracking for cleanup
const fixtureOrgIds: string[] = [];
const fixturePetIds: string[] = [];

let tokenCounter = 0;
function nextToken(prefix = "ORG"): string {
  tokenCounter += 1;
  return `${prefix}-CENSUS-T${String(tokenCounter).padStart(4, "0")}`;
}

async function insertFixtureOrg(
  extra: Partial<typeof organizations.$inferInsert> = {},
): Promise<string> {
  const token = nextToken("ORG");
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: "Test Shelter Census",
      displayName: "Test Shelter Census",
      orgType: "shelter",
      email: `census-shelter-${tokenCounter}@dim-test.local`,
      ...extra,
    })
    .returning({ id: organizations.id });
  fixtureOrgIds.push(row.id);
  return row.id;
}

async function insertFixturePet(species: string): Promise<string> {
  const token = nextToken("DIM");
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `Census Pet ${token}`,
      species,
      sex: "unknown",
    })
    .returning({ id: pets.id });
  fixturePetIds.push(row.id);
  return row.id;
}

async function insertOwnership(
  petId: string,
  organizationId: string,
  role: "shelter_custody" | "owner" | "foster",
  endedAt: Date | null = null,
): Promise<void> {
  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: organizationId,
    role,
    startedAt: new Date(),
    endedAt: endedAt ?? undefined,
  });
}

afterEach(async () => {
  // Delete ownerships first (FK references both pets and organizations).
  if (fixturePetIds.length > 0) {
    await db.delete(ownerships).where(inArray(ownerships.petId, fixturePetIds));
    await db.delete(pets).where(inArray(pets.id, fixturePetIds));
  }
  if (fixtureOrgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, fixtureOrgIds));
  }
  fixtureOrgIds.length = 0;
  fixturePetIds.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchOrgCensus — projection over shelter_custody rows", () => {
  it("counts active shelter_custody by species, excluding ended rows and non-custody roles", async () => {
    const orgId = await insertFixtureOrg();

    // 2 dogs, 1 cat, 1 rabbit under active shelter_custody
    const dog1 = await insertFixturePet("dog");
    const dog2 = await insertFixturePet("dog");
    const cat1 = await insertFixturePet("cat");
    const rabbit1 = await insertFixturePet("rabbit");

    // 1 ended shelter_custody (should NOT be counted)
    const dog3 = await insertFixturePet("dog");

    await insertOwnership(dog1, orgId, "shelter_custody");
    await insertOwnership(dog2, orgId, "shelter_custody");
    await insertOwnership(cat1, orgId, "shelter_custody");
    await insertOwnership(rabbit1, orgId, "shelter_custody");
    await insertOwnership(dog3, orgId, "shelter_custody", new Date()); // ended → excluded

    const census = await fetchOrgCensus(orgId);

    expect(census.dogs).toBe(2);
    expect(census.cats).toBe(1);
    expect(census.other).toBe(1); // rabbit → other
    expect(census.total).toBe(4);
  });

  it("does not count 'owner' role rows (only shelter_custody)", async () => {
    const orgId = await insertFixtureOrg();

    // org-owned pet (e.g. legal permanent owner) — not shelter_custody occupancy
    const dog = await insertFixturePet("dog");
    await insertOwnership(dog, orgId, "owner");

    const census = await fetchOrgCensus(orgId);
    expect(census.total).toBe(0);
  });

  it("returns zeros for an org with no custody rows", async () => {
    const orgId = await insertFixtureOrg();
    const census = await fetchOrgCensus(orgId);
    expect(census.dogs).toBe(0);
    expect(census.cats).toBe(0);
    expect(census.other).toBe(0);
    expect(census.total).toBe(0);
  });

  it("does not count shelter_custody rows belonging to other orgs", async () => {
    const orgA = await insertFixtureOrg();
    const orgB = await insertFixtureOrg();

    const dogA = await insertFixturePet("dog");
    const dogB = await insertFixturePet("dog");

    await insertOwnership(dogA, orgA, "shelter_custody");
    await insertOwnership(dogB, orgB, "shelter_custody");

    const censusA = await fetchOrgCensus(orgA);
    expect(censusA.total).toBe(1);

    const censusB = await fetchOrgCensus(orgB);
    expect(censusB.total).toBe(1);
  });
});

describe("computeOccupancyBreakdown — pure computation", () => {
  it("returns null pct for all species when no capacity declared", () => {
    const census = { dogs: 5, cats: 3, other: 1, total: 9 };
    const capacity = {
      capacityDogs: null,
      capacityCats: null,
      capacityOther: null,
      capacityTotal: null,
    };

    const breakdown = computeOccupancyBreakdown(census, capacity);

    expect(breakdown.noCapacityDeclared).toBe(true);
    expect(breakdown.dogs.pct).toBeNull();
    expect(breakdown.cats.pct).toBeNull();
    expect(breakdown.other.pct).toBeNull();
    expect(breakdown.total.pct).toBeNull();
    expect(breakdown.anyOverCapacity).toBe(false);
  });

  it("computes pct when capacity is declared", () => {
    const census = { dogs: 5, cats: 2, other: 0, total: 7 };
    const capacity = {
      capacityDogs: 10,
      capacityCats: 4,
      capacityOther: null,
      capacityTotal: 20,
    };

    const breakdown = computeOccupancyBreakdown(census, capacity);

    expect(breakdown.noCapacityDeclared).toBe(false);
    expect(breakdown.dogs.pct).toBe(50); // 5/10
    expect(breakdown.cats.pct).toBe(50); // 2/4
    expect(breakdown.other.pct).toBeNull(); // capacityOther = null
    expect(breakdown.total.pct).toBe(35); // 7/20
    expect(breakdown.anyOverCapacity).toBe(false);
  });

  it("flags over-capacity when count > capacity", () => {
    const census = { dogs: 12, cats: 0, other: 0, total: 12 };
    const capacity = {
      capacityDogs: 10,
      capacityCats: null,
      capacityOther: null,
      capacityTotal: 10,
    };

    const breakdown = computeOccupancyBreakdown(census, capacity);

    expect(breakdown.dogs.overCapacity).toBe(true);
    expect(breakdown.dogs.pct).toBe(120);
    expect(breakdown.anyOverCapacity).toBe(true);
  });

  it("is not over-capacity when count equals capacity", () => {
    const census = { dogs: 10, cats: 0, other: 0, total: 10 };
    const capacity = {
      capacityDogs: 10,
      capacityCats: null,
      capacityOther: null,
      capacityTotal: 10,
    };

    const breakdown = computeOccupancyBreakdown(census, capacity);

    expect(breakdown.dogs.overCapacity).toBe(false);
    expect(breakdown.anyOverCapacity).toBe(false);
  });

  it("handles zero capacity without divide-by-zero", () => {
    const census = { dogs: 3, cats: 0, other: 0, total: 3 };
    const capacity = {
      capacityDogs: 0,
      capacityCats: null,
      capacityOther: null,
      capacityTotal: 0,
    };

    const breakdown = computeOccupancyBreakdown(census, capacity);

    // capacity=0 → pct=0 (avoid Infinity); but count > capacity → overCapacity
    expect(breakdown.dogs.pct).toBe(0);
    expect(breakdown.dogs.overCapacity).toBe(true);
  });
});

describe("schema smoke — additive migration doesn't break existing orgs", () => {
  it("inserts an org without capacity columns (all null by default)", async () => {
    const orgId = await insertFixtureOrg();
    const [row] = await db
      .select({
        id: organizations.id,
        capacityDogs: organizations.capacityDogs,
        capacityCats: organizations.capacityCats,
        capacityOther: organizations.capacityOther,
        capacityTotal: organizations.capacityTotal,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    expect(row.capacityDogs).toBeNull();
    expect(row.capacityCats).toBeNull();
    expect(row.capacityOther).toBeNull();
    expect(row.capacityTotal).toBeNull();
  });

  it("can update capacity columns and read them back", async () => {
    const orgId = await insertFixtureOrg();

    await db
      .update(organizations)
      .set({ capacityDogs: 20, capacityCats: 15, capacityOther: 5, capacityTotal: 40 })
      .where(eq(organizations.id, orgId));

    const [row] = await db
      .select({
        capacityDogs: organizations.capacityDogs,
        capacityCats: organizations.capacityCats,
        capacityOther: organizations.capacityOther,
        capacityTotal: organizations.capacityTotal,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    expect(row.capacityDogs).toBe(20);
    expect(row.capacityCats).toBe(15);
    expect(row.capacityOther).toBe(5);
    expect(row.capacityTotal).toBe(40);
  });
});
