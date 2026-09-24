// fetchComplianceStatesForPets — jurisdiction-tiered obligations threading
// (jurisdiction-compliance WU3, spec CS1/CS4/CS6 + the no-N+1 fence).
//
// Two contracts pinned against the real local DB:
//
// 1. NO NEW N+1: the three obligation rule types resolve via
//    resolveBusinessRuleForJurisdictions once EACH, over the DISTINCT
//    jurisdiction set — 3 batched calls for any number of pets, never
//    O(pets × rules). (The pre-WU3 code resolved microchip_required only,
//    per-jurisdiction; widening to 3 types must not reintroduce per-pet
//    resolution.)
// 2. TIER + CITATION THREADING: a `not_regulated` rabies rule removes the
//    rabies obligation from that jurisdiction's pets (and from N-de-M), while
//    pets in another jurisdiction keep it; a microchip rule's legal metadata
//    reaches that jurisdiction's footnote and NEVER leaks into another
//    jurisdiction's cards (CS6 — the Ushuaia-never-sees-CABA class).
//
// Provinces must be CANONICAL (pets_jurisdiction_province_canonical +
// govt_business_rules_jurisdiction_province_canonical CHECKs), so the
// fictional isolation lives at the LOCALITY level: "ZZ Prueba WU3" localities
// guarantee the unique (rule_type, country, province, locality) tuples can
// never collide with real rows on the shared local DB; cleanup deletes by
// returned id only.

import { inArray, sql } from "drizzle-orm";
import { type Mock, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db, govtBusinessRules, ownerships, pets, profiles } from "@/db";
import { fetchComplianceStatesForPets } from "@/lib/analytics/owner-dashboard";
import { resolveBusinessRuleForJurisdictions } from "@/lib/infra/business-rules-resolver";

// Spy wrapper around the REAL batch resolver — the queries still hit the local
// DB; only call count + arguments are observed.
vi.mock("@/lib/infra/business-rules-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/business-rules-resolver")>();
  return {
    ...actual,
    resolveBusinessRuleForJurisdictions: vi.fn(actual.resolveBusinessRuleForJurisdictions),
  };
});

const batchResolverSpy = resolveBusinessRuleForJurisdictions as unknown as Mock;

// v4-shaped UUID (zod's uuid format wants the version/variant nibbles).
const OWNER_ID = "00000000-0000-4000-8000-00000000a3f1";
// Real (canonical) provinces chosen for having no seeded/pilot rules; the
// rules under test sit at locality level, on fictional localities, so the
// cascade for these pets can only ever hit the rows this file created.
const PROVINCE_RULED = "Tierra del Fuego";
const LOCALITY_RULED = "ZZ Prueba WU3";
const PROVINCE_OTHER = "La Pampa";
const LOCALITY_OTHER = "ZZ Prueba WU3 Sur";
const CITATION_BASIS = "Ley Prueba 123";
const CITATION_AUTHORITY = "Municipalidad ZZ";

const seedPetIds: string[] = [];
const seedRuleIds: string[] = [];

beforeAll(async () => {
  // Actor for the rules' created_by FK (auth.users) + pet ownership.
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${OWNER_ID}::uuid, 'wu3-obligations-batch@dim-test.local',
      'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  await db
    .insert(profiles)
    .values({ id: OWNER_ID, displayName: "WU3 Obligations Owner" })
    .onConflictDoNothing({ target: profiles.id });

  // 3 pets, 2 DISTINCT jurisdictions (A + B share one) — cats, so the PPP
  // determinability card never enters the counts under test.
  const stamp = Date.now();
  const petValues = [
    { suffix: "A", province: PROVINCE_RULED, locality: LOCALITY_RULED },
    { suffix: "B", province: PROVINCE_RULED, locality: LOCALITY_RULED },
    { suffix: "C", province: PROVINCE_OTHER, locality: LOCALITY_OTHER },
  ];
  for (const { suffix, province, locality } of petValues) {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: `TEST-WU3-${stamp}-${suffix}`,
        name: `WU3 Batch Test ${suffix}`,
        species: "cat",
        sex: "female",
        status: "active",
        jurisdictionProvince: province,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    seedPetIds.push(row.id);
  }
  await db
    .insert(ownerships)
    .values(seedPetIds.map((petId) => ({ petId, ownerUserId: OWNER_ID, role: "owner" as const })));

  // Rules for the RULED locality only: rabies is not_regulated there, and the
  // microchip rule carries legal metadata for the citation-threading assert.
  const ruleRows = await db
    .insert(govtBusinessRules)
    .values([
      {
        jurisdictionCountry: "AR",
        jurisdictionProvince: PROVINCE_RULED,
        jurisdictionLocality: LOCALITY_RULED,
        ruleType: "rabies_vaccination",
        rulePayload: {},
        requirementLevel: "not_regulated",
        legalBasis: "Ordenanza Prueba 999",
        createdByUserId: OWNER_ID,
        updatedByUserId: OWNER_ID,
      },
      {
        jurisdictionCountry: "AR",
        jurisdictionProvince: PROVINCE_RULED,
        jurisdictionLocality: LOCALITY_RULED,
        ruleType: "microchip_required",
        rulePayload: { required: true },
        requirementLevel: "mandatory",
        legalBasis: CITATION_BASIS,
        authority: CITATION_AUTHORITY,
        createdByUserId: OWNER_ID,
        updatedByUserId: OWNER_ID,
      },
    ])
    .returning({ id: govtBusinessRules.id });
  seedRuleIds.push(...ruleRows.map((r) => r.id));
});

afterAll(async () => {
  if (seedRuleIds.length > 0)
    await db.delete(govtBusinessRules).where(inArray(govtBusinessRules.id, seedRuleIds));
  if (seedPetIds.length > 0) {
    await db.delete(ownerships).where(inArray(ownerships.petId, seedPetIds));
    await db.delete(pets).where(inArray(pets.id, seedPetIds));
  }
  await db.delete(profiles).where(inArray(profiles.id, [OWNER_ID]));
  await db.execute(sql`delete from auth.users where id = ${OWNER_ID}::uuid`);
});

beforeEach(() => {
  batchResolverSpy.mockClear();
});

describe("fetchComplianceStatesForPets — batched obligation resolution (no N+1)", () => {
  it("resolves 3 rule types over the DISTINCT jurisdiction set — 3 calls for 3 pets in 2 jurisdictions", async () => {
    await fetchComplianceStatesForPets(OWNER_ID, seedPetIds);

    expect(batchResolverSpy).toHaveBeenCalledTimes(3);
    const ruleTypes = batchResolverSpy.mock.calls.map((c) => c[0]).sort();
    expect(ruleTypes).toEqual(["microchip_required", "rabies_vaccination", "sterilization"]);
    for (const call of batchResolverSpy.mock.calls) {
      // Deduped: 3 pets, but only the 2 distinct jurisdictions are resolved.
      expect(call[1]).toHaveLength(2);
    }
  });
});

describe("fetchComplianceStatesForPets — tier + citation threading (CS1/CS4/CS6)", () => {
  it("a not_regulated rabies rule removes the obligation there — and only there", async () => {
    const states = await fetchComplianceStatesForPets(OWNER_ID, seedPetIds);

    const ruled = states.get(seedPetIds[0]);
    expect(ruled?.cards.some((c) => c.key === "rabies")).toBe(false);
    expect(ruled?.summary.total).toBe(2); // sterilization + microchip only

    // The OTHER jurisdiction matched no rules: rabies/sterilization keep the
    // pre-tier fallback (obligations), while microchip is NOT claimed (RG2,
    // ratified 2026-08-16 — the no-rule default is not_regulated, so with no
    // chip on record the card is omitted, honestly).
    const other = states.get(seedPetIds[2]);
    expect(other?.cards.some((c) => c.key === "rabies")).toBe(true);
    expect(other?.cards.some((c) => c.key === "microchip")).toBe(false);
    expect(other?.summary.total).toBe(2); // rabies + sterilization
  });

  it("the microchip citation reaches its own jurisdiction and never leaks into another (CS6 + RG2)", async () => {
    const states = await fetchComplianceStatesForPets(OWNER_ID, seedPetIds);

    const ruledChip = states.get(seedPetIds[0])?.cards.find((c) => c.key === "microchip");
    expect(ruledChip?.legalFootnote).toBe(
      `Identificación · ${CITATION_BASIS} · ${CITATION_AUTHORITY}`,
    );

    // The OTHER jurisdiction resolved nothing → since RG2 (ratified
    // 2026-08-16) there is NO microchip obligation card at all (the pre-RG2
    // behavior was a generic-stopgap card), and the ruled province's citation
    // appears NOWHERE in its serialized state.
    const otherState = states.get(seedPetIds[2]);
    const otherChip = otherState?.cards.find((c) => c.key === "microchip");
    expect(otherChip).toBeUndefined();
    expect(JSON.stringify(otherState)).not.toContain(CITATION_BASIS);
  });
});
