// Integration tests for the adoption listing projection. Verifies the four
// cross-spec exclusion guards (D18 lost, D19 not-eligible, D20 dispute,
// D21 rabies-active) plus the basic filters / keyset cursor behavior.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, ownerships, pets } from "@/db";
import {
  type AdoptionListingFilters,
  buildSearchParams,
  energyLabel,
  parseSearchParams,
} from "@/lib/infra/adoption-listing";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";

// QA histórico 2026-07-08 item 2: energyLabel previously ignored the pet's
// sex entirely and always returned the "/a" fallback form ("Activo/a"),
// disagreeing with the sex-driven gendering already used for ageBucketLabel
// right next to it on every /adoptar card. Pure-function test — no DB needed.
describe("energyLabel", () => {
  it("genders by sex", () => {
    expect(energyLabel("high", "male")).toBe("Activo");
    expect(energyLabel("high", "female")).toBe("Activa");
    expect(energyLabel("low", "male")).toBe("Tranquilo");
    expect(energyLabel("low", "female")).toBe("Tranquila");
    expect(energyLabel("medium", "male")).toBe("Moderado");
    expect(energyLabel("medium", "female")).toBe("Moderada");
  });

  it("falls back to masculine for unknown sex (matches ageBucketLabel convention)", () => {
    expect(energyLabel("high", "unknown")).toBe("Activo");
  });
});

// Fixtures live under a single org so cleanup is easy.
const ORG_TOKEN = "DIM-ADOPTLIST-TEST";

let orgId: string;
let basePetIds: string[] = [];

async function insertOrg() {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Adoption Listing Test Refugio SRL",
      displayName: "Test Refugio",
      orgType: "shelter",
      email: "adopt-listing-test@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;
}

type PetOverrides = {
  name: string;
  status?: "active" | "lost" | "deceased";
  adoptionEligible?: boolean;
  inCustodyDispute?: boolean;
  rabiesObservationStatus?: string | null;
  adoptionListedAt?: Date | null;
  adoptionListingPausedAt?: Date | null;
  adoptionAgeBucket?: "puppy" | "junior" | "young" | "adult" | "senior" | null;
  species?: string;
  seedTag?: string | null;
};

async function insertPet(opts: PetOverrides): Promise<string> {
  const token = `DIM-AL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const eligible = opts.adoptionEligible ?? true;
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: opts.name,
      species: opts.species ?? "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      status: opts.status ?? "active",
      adoptionEligible: eligible,
      // CHECK constraint pets_adoption_eligibility_consistent: eligibility
      // flag and set_at must be both null or both non-null.
      adoptionEligibilitySetAt: new Date(),
      // CHECK constraint pets_adoption_ineligible_reason_required: when
      // eligible=false, reason must be present.
      adoptionIneligibleReason: eligible ? null : "medical_treatment",
      inCustodyDispute: opts.inCustodyDispute ?? false,
      rabiesObservationStatus: opts.rabiesObservationStatus ?? null,
      // `adoptionListedAt: null` is a legitimate test input ("AL-Unlisted"),
      // so we use `in` rather than `??` which would coerce null → default.
      adoptionListedAt: "adoptionListedAt" in opts ? opts.adoptionListedAt : new Date(),
      adoptionListingPausedAt: opts.adoptionListingPausedAt ?? null,
      adoptionAgeBucket: opts.adoptionAgeBucket ?? "adult",
      seedTag: opts.seedTag ?? null,
    })
    .returning();
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: new Date(),
  });
  basePetIds.push(pet.id);
  return pet.id;
}

beforeAll(async () => {
  await insertOrg();
});

afterAll(async () => {
  for (const id of basePetIds) {
    await db.delete(ownerships).where(eq(ownerships.petId, id));
    await db.delete(pets).where(eq(pets.id, id));
  }
  await db.delete(organizations).where(eq(organizations.id, orgId));
  basePetIds = [];
});

describe("queryAdoptionListing — cross-spec guards", () => {
  it("includes a listed-eligible-not-disputed-not-quarantined-active pet", async () => {
    await insertPet({ name: "AL-Happy" });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Happy")).toBe(true);
  });

  it("excludes pets whose status is 'lost' (D18)", async () => {
    await insertPet({ name: "AL-Lost", status: "lost" });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Lost")).toBe(false);
  });

  it("excludes pets whose status is 'deceased' (D18)", async () => {
    await insertPet({ name: "AL-Deceased", status: "deceased" });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Deceased")).toBe(false);
  });

  it("excludes pets with adoption_eligible=false (D19)", async () => {
    await insertPet({ name: "AL-NotEligible", adoptionEligible: false });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-NotEligible")).toBe(false);
  });

  it("excludes pets with in_custody_dispute=true (D20)", async () => {
    await insertPet({ name: "AL-Disputed", inCustodyDispute: true });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Disputed")).toBe(false);
  });

  it("excludes pets in active rabies observation (D21)", async () => {
    await insertPet({
      name: "AL-RabiesActive",
      rabiesObservationStatus: "in_progress",
    });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-RabiesActive")).toBe(false);
  });

  it("excludes paused listings (D3)", async () => {
    await insertPet({ name: "AL-Paused", adoptionListingPausedAt: new Date() });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Paused")).toBe(false);
  });

  // Security review 2026-09: a real application on a seeded pet is a real act
  // the govt queues then hide as synthetic. Seeded pets are never offered.
  it("excludes seed-tagged (synthetic) pets", async () => {
    await insertPet({ name: "AL-Seeded", seedTag: "panorama" });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Seeded")).toBe(false);
  });

  it("excludes pets without a listed_at timestamp", async () => {
    await insertPet({ name: "AL-Unlisted", adoptionListedAt: null });
    const { items } = await queryAdoptionListing({ organizationToken: ORG_TOKEN }, null, 50);
    expect(items.some((i) => i.name === "AL-Unlisted")).toBe(false);
  });
});

describe("queryAdoptionListing — filters", () => {
  it("filters by ageBucket", async () => {
    await insertPet({ name: "AL-Puppy", adoptionAgeBucket: "puppy" });
    await insertPet({ name: "AL-AdultDog", adoptionAgeBucket: "adult" });

    const f: AdoptionListingFilters = {
      organizationToken: ORG_TOKEN,
      ageBucket: "puppy",
    };
    const { items } = await queryAdoptionListing(f, null, 50);
    expect(items.some((i) => i.name === "AL-Puppy")).toBe(true);
    expect(items.some((i) => i.name === "AL-AdultDog")).toBe(false);
  });

  it("filters by species", async () => {
    await insertPet({ name: "AL-Cat", species: "cat" });
    const { items } = await queryAdoptionListing(
      { organizationToken: ORG_TOKEN, species: "cat" },
      null,
      50,
    );
    expect(items.some((i) => i.name === "AL-Cat")).toBe(true);
    expect(items.every((i) => i.species === "cat")).toBe(true);
  });

  // Accent-parity: unaccented searchQuery must find a pet whose name
  // contains diacritics. PostgreSQL ILIKE folds case but NOT diacritics;
  // unaccent() on both column and pattern is required for this to work.
  it("searchQuery finds pet with accented name via unaccented term", async () => {
    await insertPet({ name: "Léón" });
    const { items } = await queryAdoptionListing(
      { organizationToken: ORG_TOKEN, searchQuery: "leon" },
      null,
      50,
    );
    expect(items.some((i) => i.name === "Léón")).toBe(true);
  });

  it("searchQuery wildcard chars are escaped and do not act as patterns", async () => {
    await insertPet({ name: "AL-WildcardSafe" });
    const { items } = await queryAdoptionListing(
      { organizationToken: ORG_TOKEN, searchQuery: "%" },
      null,
      50,
    );
    // "%" as a literal — must not match everything.
    expect(items.some((i) => i.name === "AL-WildcardSafe")).toBe(false);
  });
});

describe("parseSearchParams / buildSearchParams", () => {
  it("round-trips filters through URL params", () => {
    const filters: AdoptionListingFilters = {
      species: "dog",
      province: "Buenos Aires",
      ageBucket: "young",
      sizeEstimate: "medium",
      energyLevel: "high",
      goodWithKids: true,
      needsYard: false,
    };
    const params = buildSearchParams(filters, null);
    const rec: Record<string, string> = {};
    params.forEach((v, k) => {
      rec[k] = v;
    });
    const { filters: parsed } = parseSearchParams(rec);
    expect(parsed.species).toBe("dog");
    expect(parsed.province).toBe("Buenos Aires");
    expect(parsed.ageBucket).toBe("young");
    expect(parsed.sizeEstimate).toBe("medium");
    expect(parsed.energyLevel).toBe("high");
    expect(parsed.goodWithKids).toBe(true);
    expect(parsed.needsYard).toBe(false);
  });

  it("encodes and parses the cursor", () => {
    const cursor = { listedAt: "2026-05-18T12:00:00.000Z", id: "abc-123" };
    const params = buildSearchParams({}, cursor);
    expect(params.get("cursor")).toBe("2026-05-18T12:00:00.000Z|abc-123");
    const { cursor: parsed } = parseSearchParams({ cursor: params.get("cursor")! });
    expect(parsed).toEqual(cursor);
  });

  it("ignores unknown enum values defensively", () => {
    const { filters } = parseSearchParams({
      edad: "anciano", // not in ADOPTION_AGE_BUCKETS
      talle: "gigante", // not in ADOPTION_SIZE_ESTIMATES
    });
    expect(filters.ageBucket).toBeUndefined();
    expect(filters.sizeEstimate).toBeUndefined();
  });
});
