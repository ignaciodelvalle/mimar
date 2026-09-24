// Integration tests for performed_by autocomplete search
// (spec 2026-05-19-performed-by-autocomplete-design §4.2).

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, profiles } from "@/db";
import { type PerformedBySuggestion, searchVetsAndClinics } from "@/lib/infra/performed-by-search";

const SUFFIX = "PB-TEST";

let orgClinicCabaId: string;
let orgClinicBaId: string;
let orgUnverifiedId: string;
let vetVerifiedId: string;
let vetUnverifiedId: string;
// Accent-parity fixtures: accented names searched with unaccented queries.
let orgAccentedId: string;
let vetAccentedId: string;

beforeAll(async () => {
  // Cleanup any leftover fixtures from prior runs.
  await db.execute(sql`DELETE FROM organizations WHERE display_name LIKE ${`%${SUFFIX}%`}`);
  await db.execute(sql`DELETE FROM profiles WHERE display_name LIKE ${`%${SUFFIX}%`}`);

  const [orgCaba] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-PB-CABA",
      legalName: `Clínica San Pablo ${SUFFIX} SRL`,
      displayName: `San Pablo ${SUFFIX}`,
      orgType: "clinic",
      email: "san-pablo-pb@dim-test.local",
      verified: true,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  orgClinicCabaId = orgCaba.id;

  const [orgBa] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-PB-BA",
      legalName: `Clínica San Pedro ${SUFFIX} SRL`,
      displayName: `San Pedro ${SUFFIX}`,
      orgType: "clinic",
      email: "san-pedro-pb@dim-test.local",
      verified: true,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning();
  orgClinicBaId = orgBa.id;

  const [orgUnverified] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-PB-UNV",
      legalName: `Clínica San Lucas ${SUFFIX} SRL`,
      displayName: `San Lucas ${SUFFIX}`,
      orgType: "clinic",
      email: "san-lucas-pb@dim-test.local",
      verified: false,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  orgUnverifiedId = orgUnverified.id;

  vetVerifiedId = "00000000-0000-0000-0000-00000000ab01";
  await db
    .insert(profiles)
    .values({
      id: vetVerifiedId,
      displayName: `Dr. Juan Perez ${SUFFIX}`,
      role: "vet",
      matriculaVerified: true,
      matriculaJurisdiccion: "M.N. 12345",
    })
    .onConflictDoNothing({ target: profiles.id });

  vetUnverifiedId = "00000000-0000-0000-0000-00000000ab02";
  await db
    .insert(profiles)
    .values({
      id: vetUnverifiedId,
      displayName: `Dra. Sofia Perez ${SUFFIX}`,
      role: "vet",
      matriculaVerified: false,
    })
    .onConflictDoNothing({ target: profiles.id });

  // Accent-parity fixtures: names with diacritics must be found by
  // queries typed without them (unaccent() on both sides).
  const [orgAccented] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-PB-ACC",
      legalName: `Clínica González ${SUFFIX} SRL`,
      displayName: `González ${SUFFIX}`,
      orgType: "clinic",
      email: "gonzalez-pb@dim-test.local",
      verified: true,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  orgAccentedId = orgAccented.id;

  vetAccentedId = "00000000-0000-0000-0000-00000000ab03";
  await db
    .insert(profiles)
    .values({
      id: vetAccentedId,
      displayName: `Dra. Sofía Ramírez ${SUFFIX}`,
      role: "vet",
      matriculaVerified: true,
    })
    .onConflictDoNothing({ target: profiles.id });
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM organizations WHERE id IN (
    ${orgClinicCabaId}::uuid, ${orgClinicBaId}::uuid, ${orgUnverifiedId}::uuid, ${orgAccentedId}::uuid
  )`);
  await db.execute(sql`DELETE FROM profiles WHERE id IN (
    ${vetVerifiedId}::uuid, ${vetUnverifiedId}::uuid, ${vetAccentedId}::uuid
  )`);
});

describe("searchVetsAndClinics", () => {
  it("returns [] for queries shorter than 2 chars", async () => {
    expect(await searchVetsAndClinics("")).toEqual([]);
    expect(await searchVetsAndClinics("a")).toEqual([]);
  });

  it("finds the verified CABA + BA clinics by substring match", async () => {
    const results = await searchVetsAndClinics(SUFFIX);
    const orgIds = results.filter((r) => r.kind === "organization").map((r) => r.id);
    expect(orgIds).toContain(orgClinicCabaId);
    expect(orgIds).toContain(orgClinicBaId);
  });

  it("excludes unverified organizations", async () => {
    const results = await searchVetsAndClinics(`San Lucas ${SUFFIX}`);
    const orgIds = results.filter((r) => r.kind === "organization").map((r) => r.id);
    expect(orgIds).not.toContain(orgUnverifiedId);
  });

  it("excludes unverified vet profiles", async () => {
    const results = await searchVetsAndClinics(`Perez ${SUFFIX}`);
    const profIds = results.filter((r) => r.kind === "profile").map((r) => r.id);
    expect(profIds).toContain(vetVerifiedId);
    expect(profIds).not.toContain(vetUnverifiedId);
  });

  // Position AMONG THIS SUITE'S OWN orgs — never "the first organization in the
  // result", which is a claim about every row in the database.
  function ownRank(results: PerformedBySuggestion[], id: string): number {
    const ownIds = [orgClinicCabaId, orgClinicBaId];
    return results
      .filter((r) => r.kind === "organization" && ownIds.includes(r.id))
      .findIndex((r) => r.id === id);
  }

  it("boosts jurisdiction-matching organizations to the top", async () => {
    // The boost is a RELATIVE claim, and it is asserted as one. The absolute
    // "first organization overall" version of this test was flaky under full-
    // suite contention: the accented CABA fixture scores EXACTLY the same as
    // the CABA clinic (+10 substring, +50 locality), ties are broken by
    // Array#sort's stability, i.e. by the order Postgres happens to return
    // unordered rows in — which moves when other suites write concurrently.
    const cabaFirst = await searchVetsAndClinics(SUFFIX, {
      province: "CABA",
      locality: "Palermo",
    });
    expect(ownRank(cabaFirst, orgClinicCabaId)).toBeGreaterThanOrEqual(0);
    expect(ownRank(cabaFirst, orgClinicBaId)).toBeGreaterThanOrEqual(0);
    // CABA context: the CABA clinic outranks the Buenos Aires one.
    expect(ownRank(cabaFirst, orgClinicCabaId)).toBeLessThan(ownRank(cabaFirst, orgClinicBaId));

    const baFirst = await searchVetsAndClinics(SUFFIX, {
      province: "Buenos Aires",
      locality: "La Plata",
    });
    expect(ownRank(baFirst, orgClinicCabaId)).toBeGreaterThanOrEqual(0);
    expect(ownRank(baFirst, orgClinicBaId)).toBeGreaterThanOrEqual(0);
    // Same query, other jurisdiction: the ranking flips. That IS the boost.
    expect(ownRank(baFirst, orgClinicBaId)).toBeLessThan(ownRank(baFirst, orgClinicCabaId));
  });

  it("returns organizations + profiles mixed (verified vets included)", async () => {
    const results = await searchVetsAndClinics(SUFFIX);
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds.has("organization")).toBe(true);
    expect(kinds.has("profile")).toBe(true);
  });

  // Accent-parity: unaccented query must find accented display names.
  // PostgreSQL ILIKE folds case but NOT diacritics; unaccent() on both
  // sides is required for "gonzalez" to match "González".
  it("finds accented org displayName via unaccented query", async () => {
    const results = await searchVetsAndClinics(`gonzalez ${SUFFIX}`);
    const orgIds = results.filter((r) => r.kind === "organization").map((r) => r.id);
    expect(orgIds).toContain(orgAccentedId);
  });

  it("finds accented vet displayName via unaccented query", async () => {
    const results = await searchVetsAndClinics(`sofia ramirez ${SUFFIX}`);
    const profIds = results.filter((r) => r.kind === "profile").map((r) => r.id);
    expect(profIds).toContain(vetAccentedId);
  });
});
