// Mandated-denominator cascade correctness against the REAL local DB
// (jurisdiction-compliance WU4a — T4.10, spec MN1/MN3 scenario:
// "a not_regulated override under a mandatory parent is excluded").
//
// Pins three contracts the pure classifier suite
// (lib/analytics/mandating-jurisdictions.test.ts) cannot:
//
// 1. END-TO-END EXCLUSION: with a MANDATORY province-level microchip rule and
//    a not_regulated LOCALITY override, fetchMicrochipComplianceInMandated's
//    denominator counts ONLY the pets outside the override — through the real
//    grouped SQL + the real rule rows.
// 2. CLASSIFIER ↔ RESOLVER PARITY: buildMandatingClassifier's in-memory
//    cascade agrees with resolveBusinessRule's DB cascade for every seeded
//    jurisdiction (the classifier is a mirror; drift here is the bug class).
// 3. HONEST EMPTY: a rule type with no rows in scope yields hasMandate=false.
//
// Shared-DB isolation (owner-dashboard-obligations-batch.test.ts pattern):
// provinces must be CANONICAL (jurisdiction_province_canonical CHECKs), so
// fictional isolation lives at the LOCALITY level ("ZZ Prueba WU4 ..."), and
// the ONE province-level row this file needs is guarded by a beforeAll
// existence check (fail loudly, never clobber a real row) + delete-by-id.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, govtBusinessRules, pets, profiles } from "@/db";
import {
  fetchMicrochipComplianceInMandated,
  fetchSterilizationComplianceInMandated,
} from "@/lib/analytics/compliance-metrics";
import { buildMandatingClassifier, rowMandates } from "@/lib/analytics/mandating-jurisdictions";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

// v4-shaped UUID for the rules' created_by FK.
const ACTOR_ID = "00000000-0000-4000-8000-00000000b4c1";
// Canonical province with the beforeAll guard asserting it has NO real
// province-level microchip rule to collide with.
const PROVINCE = "La Rioja";
const LOCALITY_MANDATED = "ZZ Prueba WU4 Norte";
const LOCALITY_OPTED_OUT = "ZZ Prueba WU4 Sur";

const seedPetIds: string[] = [];
const seedRuleIds: string[] = [];

beforeAll(async () => {
  // Fail loudly if the shared DB already has a province-level microchip rule
  // for this province — this test must never overwrite or shadow real data.
  const existing = await db
    .select({ id: govtBusinessRules.id })
    .from(govtBusinessRules)
    .where(
      and(
        eq(govtBusinessRules.ruleType, "microchip_required"),
        eq(govtBusinessRules.jurisdictionCountry, "AR"),
        eq(govtBusinessRules.jurisdictionProvince, PROVINCE),
        isNull(govtBusinessRules.jurisdictionLocality),
      ),
    );
  if (existing.length > 0) {
    throw new Error(
      `Pre-existing province-level microchip_required rule for ${PROVINCE} — pick another province for this test.`,
    );
  }

  // The auth.users insert fires handle_new_user(), which inserts the profiles
  // row — a stale profiles row from an aborted prior run makes THAT trigger
  // insert collide (profiles_pkey). Clear it first, then upsert both
  // explicitly (same belt-and-braces as owner-dashboard-obligations-batch).
  await db.delete(profiles).where(inArray(profiles.id, [ACTOR_ID]));
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${ACTOR_ID}::uuid, 'wu4-mandated-cascade@dim-test.local',
      'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  await db
    .insert(profiles)
    .values({ id: ACTOR_ID, displayName: "WU4 Cascade Actor" })
    .onConflictDoNothing({ target: profiles.id });

  // Province-level MANDATORY microchip rule + locality-level not_regulated
  // override — the exact not_regulated-under-mandatory cascade under test.
  const ruleRows = await db
    .insert(govtBusinessRules)
    .values([
      {
        jurisdictionCountry: "AR",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: null,
        ruleType: "microchip_required",
        rulePayload: { required: true },
        requirementLevel: "mandatory",
        createdByUserId: ACTOR_ID,
        updatedByUserId: ACTOR_ID,
      },
      {
        jurisdictionCountry: "AR",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: LOCALITY_OPTED_OUT,
        ruleType: "microchip_required",
        rulePayload: { required: false },
        requirementLevel: "not_regulated",
        createdByUserId: ACTOR_ID,
        updatedByUserId: ACTOR_ID,
      },
    ])
    .returning({ id: govtBusinessRules.id });
  seedRuleIds.push(...ruleRows.map((r) => r.id));

  // 2 pets in the mandated locality, 1 in the opted-out one. Cats (species is
  // irrelevant to the microchip denominator, and no PPP noise).
  const stamp = Date.now();
  const petValues = [
    { suffix: "A", locality: LOCALITY_MANDATED },
    { suffix: "B", locality: LOCALITY_MANDATED },
    { suffix: "C", locality: LOCALITY_OPTED_OUT },
  ];
  for (const { suffix, locality } of petValues) {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: `TEST-WU4-${stamp}-${suffix}`,
        name: `WU4 Cascade Test ${suffix}`,
        species: "cat",
        sex: "female",
        status: "active",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    seedPetIds.push(row.id);
  }
});

afterAll(async () => {
  if (seedRuleIds.length > 0)
    await db.delete(govtBusinessRules).where(inArray(govtBusinessRules.id, seedRuleIds));
  if (seedPetIds.length > 0) await db.delete(pets).where(inArray(pets.id, seedPetIds));
  // profiles BEFORE auth.users — the trigger-created row is not FK-cascaded,
  // and leaving it orphaned breaks the NEXT run's trigger insert.
  await db.delete(profiles).where(inArray(profiles.id, [ACTOR_ID]));
  await db.execute(sql`delete from auth.users where id = ${ACTOR_ID}::uuid`);
});

const ctx = () =>
  buildProjectionContext(
    { role: "govt" },
    [
      { province: PROVINCE, locality: LOCALITY_MANDATED },
      { province: PROVINCE, locality: LOCALITY_OPTED_OUT },
    ],
    windows.trailing12m(),
  );

describe("fetchMicrochipComplianceInMandated — cascade exclusion end-to-end (T4.10)", () => {
  it("counts pets under the mandatory province row and EXCLUDES the not_regulated locality override", async () => {
    const kpi = await fetchMicrochipComplianceInMandated(ctx());

    // Denominator: ONLY the 2 pets in the mandated locality; the opted-out
    // locality's pet never enters despite the mandatory province parent.
    expect(kpi.hasMandate).toBe(true);
    expect(kpi.mandatedJurisdictions).toBe(1);
    expect(kpi.inMandated).toBe(2);
    // None of the seeded pets carries a chip — 0% over a REAL denominator.
    expect(kpi.compliant).toBe(0);
    expect(kpi.ratePct).toBe(0);
  });

  it("a rule type with no rows for the scope reports hasMandate=false (honest empty)", async () => {
    // No sterilization rules exist for these fictional localities (and the
    // classifier requires a MATCHED row) — denominator must be 0, not 3.
    const kpi = await fetchSterilizationComplianceInMandated(ctx());
    expect(kpi.mandatedJurisdictions).toBe(0);
    expect(kpi.inMandated).toBe(0);
    expect(kpi.hasMandate).toBe(false);
  });
});

describe("in-memory classifier ↔ resolveBusinessRule parity", () => {
  it("agrees with the real cascade for every seeded jurisdiction", async () => {
    const rows = await db
      .select({
        province: govtBusinessRules.jurisdictionProvince,
        locality: govtBusinessRules.jurisdictionLocality,
        requirementLevel: govtBusinessRules.requirementLevel,
        payload: govtBusinessRules.rulePayload,
      })
      .from(govtBusinessRules)
      .where(
        and(
          eq(govtBusinessRules.ruleType, "microchip_required"),
          eq(govtBusinessRules.jurisdictionCountry, "AR"),
        ),
      );
    const classifier = buildMandatingClassifier("microchip_required", rows);

    for (const locality of [LOCALITY_MANDATED, LOCALITY_OPTED_OUT]) {
      const resolved = await resolveBusinessRule("microchip_required", {
        province: PROVINCE,
        locality,
      });
      const resolverMandates =
        resolved.matchedRow !== null &&
        rowMandates("microchip_required", {
          province: resolved.matchedRow.province,
          locality: resolved.matchedRow.locality,
          requirementLevel: resolved.requirementLevel ?? null,
          payload: resolved.payload,
        });
      expect(classifier.isMandated(PROVINCE, locality)).toBe(resolverMandates);
    }
    // Pin the actual verdicts too, so parity can't pass by both being wrong.
    expect(classifier.isMandated(PROVINCE, LOCALITY_MANDATED)).toBe(true);
    expect(classifier.isMandated(PROVINCE, LOCALITY_OPTED_OUT)).toBe(false);
  });
});
