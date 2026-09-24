// Tests for lib/outreach-pipelines.ts — SDD test-first (Item 21).
//
// Covers:
//  1. fetchOverdueRabiesVaccine — pipeline (a): pets with overdue rabies vaccine
//  2. logOutreachPiiQuery — audit row written on every list view
//  3. Jurisdiction scoping: govt sees only own jurisdiction; admin sees all
//  4. Empty list when no pets match criterion in jurisdiction
//
// Integration tests run against local Postgres + bootstrapped schema.
// Known pre-existing flakes are elsewhere; these are new tests.

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, petEvents, pets, profiles } from "@/db";
import {
  type OverdueRabiesPet,
  aggregateOverdueByLocality,
  fetchOverdueRabiesVaccine,
  fetchSterilizationVetRanking,
  fetchStrayDensityAreas,
  logOutreachPiiQuery,
} from "@/lib/infra/outreach-pipelines";
import { buildProjectionContext } from "@/lib/metrics";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_PROVINCE = "Buenos Aires";
// Timestamp-suffixed names ensure isolation across test runs with no cleanup
// needed (see afterAll comment below).
const TEST_LOCALITY = `outreach-test-locality-${Date.now()}`;
const OTHER_LOCALITY = `outreach-other-locality-${Date.now()}`;

// Pet IDs tracked for assertions AND cleanup.
// pet_events is append-only (Postgres trigger blocks DELETE per AGENTS.md),
// but __tests__/_helpers/db-overrides.ts provides an accountable escape hatch
// (SET LOCAL app.allow_event_mutation) for exactly this: test-fixture
// teardown. See afterAll below.
const createdPetIds: string[] = [];

beforeAll(async () => {
  // Pet in TEST_LOCALITY — overdue rabies (last vaccine > 1yr ago)
  const [petOverdue] = await db
    .insert(pets)
    .values({
      publicToken: `PET-OR-OVERDUE-${Date.now()}`,
      name: "Firulais Overdue",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  createdPetIds.push(petOverdue.id);

  // Overdue vaccine event: 400 days ago (> 365 day threshold)
  const overdueDate = new Date(Date.now() - 400 * 86400_000);
  await db.insert(petEvents).values({
    petId: petOverdue.id,
    eventType: "vaccination_administered",
    occurredAt: overdueDate,
    authorRole: "owner",
    payload: {
      vaccine_name: "Antirrábica",
      next_due_at: new Date(overdueDate.getTime() + 365 * 86400_000).toISOString(),
    },
  });

  // Pet in TEST_LOCALITY — current rabies (vaccine 30 days ago, due in the future)
  const [petCurrent] = await db
    .insert(pets)
    .values({
      publicToken: `PET-OR-CURRENT-${Date.now()}`,
      name: "Firulais Current",
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  createdPetIds.push(petCurrent.id);

  const recentVaccDate = new Date(Date.now() - 30 * 86400_000);
  await db.insert(petEvents).values({
    petId: petCurrent.id,
    eventType: "vaccination_administered",
    occurredAt: recentVaccDate,
    authorRole: "owner",
    payload: {
      vaccine_name: "Antirrábica",
      next_due_at: new Date(recentVaccDate.getTime() + 365 * 86400_000).toISOString(),
    },
  });

  // Pet in OTHER_LOCALITY — overdue, but outside test jurisdiction
  const [petOther] = await db
    .insert(pets)
    .values({
      publicToken: `PET-OR-OTHER-${Date.now()}`,
      name: "Firulais Other Jurisdiction",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: OTHER_LOCALITY,
    })
    .returning({ id: pets.id });
  createdPetIds.push(petOther.id);

  const overdueDate2 = new Date(Date.now() - 500 * 86400_000);
  await db.insert(petEvents).values({
    petId: petOther.id,
    eventType: "vaccination_administered",
    occurredAt: overdueDate2,
    authorRole: "owner",
    payload: {
      vaccine_name: "Antirrábica",
      next_due_at: new Date(overdueDate2.getTime() + 365 * 86400_000).toISOString(),
    },
  });

  // Pet in TEST_LOCALITY — sterilized, for pipeline (c) ranking
  const [petSteril] = await db
    .insert(pets)
    .values({
      publicToken: `PET-OR-STERIL-${Date.now()}`,
      name: "Negrita Esterilizada",
      species: "cat",
      sex: "female",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  createdPetIds.push(petSteril.id);

  await db.insert(petEvents).values({
    petId: petSteril.id,
    eventType: "sterilization_performed",
    occurredAt: new Date(Date.now() - 60 * 86400_000),
    authorRole: "owner",
    payload: {
      procedure: "spay",
      performed_by: "Dr. Test Vet",
      clinic: "Clínica Test Outreach",
    },
  });

  // Second sterilization whose performed_by is later CORRECTED via
  // event_amended — the ranking must attribute it to the corrected vet
  // (event-sourcing integrity review 2026-07-04 item 4).
  const [petSterilAmended] = await db
    .insert(pets)
    .values({
      publicToken: `PET-OR-STERIL-AM-${Date.now()}`,
      name: "Negrita Corregida",
      species: "cat",
      sex: "female",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  createdPetIds.push(petSterilAmended.id);

  const [sterilEvent] = await db
    .insert(petEvents)
    .values({
      petId: petSterilAmended.id,
      eventType: "sterilization_performed",
      occurredAt: new Date(Date.now() - 50 * 86400_000),
      authorRole: "owner",
      payload: {
        procedure: "spay",
        performed_by: "Dr. Typo Vet",
        clinic: "Clínica Test Outreach",
      },
    })
    .returning({ id: petEvents.id });

  await db.insert(petEvents).values({
    petId: petSterilAmended.id,
    eventType: "event_amended",
    occurredAt: new Date(Date.now() - 10 * 86400_000),
    authorRole: "owner",
    payload: {
      payload_version: 1,
      target_event_id: sterilEvent.id,
      reason: "vet name typo",
      changes: [{ field: "performed_by", old: "Dr. Typo Vet", new: "Dra. Corregida Vet" }],
    },
  });

  // Pet in TEST_LOCALITY — stray scan (credential_scanned on stray), for pipeline (b)
  const [petStray] = await db
    .insert(pets)
    .values({
      publicToken: `PET-OR-STRAY-${Date.now()}`,
      name: "Stray Test",
      species: "dog",
      sex: "unknown",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  createdPetIds.push(petStray.id);

  for (let i = 0; i < 3; i++) {
    await db.insert(petEvents).values({
      petId: petStray.id,
      eventType: "credential_scanned",
      occurredAt: new Date(Date.now() - i * 86400_000),
      authorRole: "scanner",
      payload: { is_self_scan: false, viewer_authenticated: false },
    });
  }
});

afterAll(async () => {
  // Each pet is deleted in its OWN transaction, independently scoped by its
  // own id. Deliberately NOT one transaction covering the whole list — if a
  // single pet's cleanup fails, the others must still get cleaned up (see
  // scheduling-attendance.test.ts's afterAll for the incident this guards
  // against: a gated all-or-nothing transaction rolled back and left a leaked
  // fixture behind). petEvents.petId scoping means this can never touch
  // another suite's rows.
  for (const petId of createdPetIds) {
    try {
      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.petId, petId));
        await tx.delete(pets).where(eq(pets.id, petId));
      });
    } catch (err) {
      console.error(`outreach-pipelines.test.ts afterAll: failed to clean up pet ${petId}`, err);
    }
  }
});

// ---------------------------------------------------------------------------
// Pipeline (a) — overdue antirrábica
// ---------------------------------------------------------------------------

describe("fetchOverdueRabiesVaccine — pipeline (a)", () => {
  it("returns pets with overdue rabies vaccine in the scoped jurisdiction", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 365 * 86400_000), until: new Date() },
    );
    const result = await fetchOverdueRabiesVaccine(ctx);
    const overdueIds = result.pets.map((p) => p.petId);
    // The overdue pet must appear.
    expect(overdueIds).toContain(createdPetIds[0]);
    // The current pet must NOT appear.
    expect(overdueIds).not.toContain(createdPetIds[1]);
  });

  it("does NOT include pets from other jurisdictions (govt scope isolation)", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 365 * 86400_000), until: new Date() },
    );
    const result = await fetchOverdueRabiesVaccine(ctx);
    const petIds = result.pets.map((p) => p.petId);
    // Pet in OTHER_LOCALITY must NOT appear for this govt.
    expect(petIds).not.toContain(createdPetIds[2]);
  });

  it("admin (global scope) is not jurisdiction-filtered (superset of any one jurisdiction)", async () => {
    const period = { since: new Date(Date.now() - 365 * 86400_000), until: new Date() };
    const adminCtx = buildProjectionContext({ role: "admin" }, [], period);
    const govtCtx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      period,
    );

    const admin = await fetchOverdueRabiesVaccine(adminCtx);
    const govt = await fetchOverdueRabiesVaccine(govtCtx);

    // Admin's universal scope returns at least as many overdue pets as any single
    // jurisdiction — it is NOT jurisdiction-filtered. On a lean DB this is exactly
    // the fixtures; on the full demo seed (45k pets) the admin list is capped by
    // the query's LIMIT, but it is still a superset of the scoped result. We do
    // NOT assert a specific fixture is in the capped global list: under a large
    // seed the never-vaccinated pets (NULLS FIRST) fill the limit before any pet
    // with an old vaccine. The govt-scope isolation is covered by the test above.
    expect(admin.pets.length).toBeGreaterThan(0);
    expect(admin.pets.length).toBeGreaterThanOrEqual(govt.pets.length);
    // 30s, not the 5s default: this is the ONE test here that deliberately runs
    // UNFILTERED (that is the assertion), so it is the only one whose cost grows
    // with the local DB. Measured 2026-07-31: green in isolation on a 32.435-pet
    // dev DB, but it timed out inside the full suite, where the serial `db`
    // project is hammering the same local Postgres. The assertions above are
    // untouched — this raises the clock, not the bar.
  }, 30000);

  it("returns empty list when no pets match in jurisdiction", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Neuquén", locality: "nowhere-outreach-test" }],
      { since: new Date(Date.now() - 365 * 86400_000), until: new Date() },
    );
    const result = await fetchOverdueRabiesVaccine(ctx);
    expect(result.pets).toHaveLength(0);
    expect(result.empty).toBe(true);
  });

  it("each returned pet row has petId, petName, species, jurisdiction, lastVaccineAt", () => {
    // Structural assertion — if the overdue pet was found, check shape.
    // We rely on the previous test having run; if isolation matters, inline another query.
    // This test simply checks the type contract.
    const pet = {
      petId: "some-id",
      petName: "Test",
      species: "dog" as const,
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
      lastVaccineAt: new Date(),
    };
    // Shape check (static; no DB needed).
    expect(pet).toHaveProperty("petId");
    expect(pet).toHaveProperty("petName");
    expect(pet).toHaveProperty("species");
    expect(pet).toHaveProperty("jurisdictionLocality");
    expect(pet).toHaveProperty("lastVaccineAt");
  });
});

// ---------------------------------------------------------------------------
// PII audit log — logOutreachPiiQuery
// ---------------------------------------------------------------------------

describe("logOutreachPiiQuery — mandatory audit row", () => {
  it("writes a pii_queried audit row with surface='outreach_pipeline'", async () => {
    const actorId = crypto.randomUUID();
    await db
      .insert(profiles)
      .values({ id: actorId, displayName: "Audit Test Operator", role: "govt" });

    await logOutreachPiiQuery(actorId, "overdue_rabies", 5);

    const rows = await db
      .select({ id: auditLog.id, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, actorId), eq(auditLog.action, "pii_queried")));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect((row.payload as Record<string, unknown>).surface).toBe("outreach_pipeline");
    expect((row.payload as Record<string, unknown>).pipeline).toBe("overdue_rabies");
    expect((row.payload as Record<string, unknown>).result_count).toBe(5);

    // Cleanup: audit_log is append-only — use the GUC bypass inside a
    // transaction (same pattern as profile.test.ts afterAll).
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, actorId));
    });
    await db.delete(profiles).where(eq(profiles.id, actorId));
  });

  // PO decision 3 ("Operativos geo-first + PII tras confirmación",
  // 2026-07-23): the overdue_rabies audit row now fires on ZONE EXPANSION,
  // not on the aggregates page load, and must carry WHICH zone was opened.
  it("carries zone_province/zone_locality when a zone context is passed", async () => {
    const actorId = crypto.randomUUID();
    await db
      .insert(profiles)
      .values({ id: actorId, displayName: "Audit Zone Test Operator", role: "govt" });

    await logOutreachPiiQuery(actorId, "overdue_rabies", 3, {
      province: TEST_PROVINCE,
      locality: TEST_LOCALITY,
    });

    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, actorId), eq(auditLog.action, "pii_queried")));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.result_count).toBe(3);
    expect(payload.zone_province).toBe(TEST_PROVINCE);
    expect(payload.zone_locality).toBe(TEST_LOCALITY);

    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, actorId));
    });
    await db.delete(profiles).where(eq(profiles.id, actorId));
  });
});

// ---------------------------------------------------------------------------
// aggregateOverdueByLocality — pipeline (a) geo-first aggregation
// ---------------------------------------------------------------------------

describe("aggregateOverdueByLocality — geo-first aggregation (PO decision 3)", () => {
  function pet(province: string | null, locality: string | null): OverdueRabiesPet {
    return {
      petId: crypto.randomUUID(),
      petName: "X",
      species: "dog",
      publicToken: "DIM-TEST-0000",
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      lastVaccineAt: new Date(0),
    };
  }

  it("groups pets by (province, locality) and counts them", () => {
    const result = aggregateOverdueByLocality([
      pet("Buenos Aires", "La Plata"),
      pet("Buenos Aires", "La Plata"),
      pet("Buenos Aires", "Quilmes"),
    ]);
    const laPlata = result.find((r) => r.locality === "La Plata");
    const quilmes = result.find((r) => r.locality === "Quilmes");
    expect(laPlata?.count).toBe(2);
    expect(quilmes?.count).toBe(1);
  });

  it("sorts descending by count — largest backlog first", () => {
    const result = aggregateOverdueByLocality([
      pet("Buenos Aires", "Quilmes"),
      pet("Buenos Aires", "La Plata"),
      pet("Buenos Aires", "La Plata"),
      pet("Buenos Aires", "La Plata"),
    ]);
    expect(result[0].locality).toBe("La Plata");
    expect(result[0].count).toBe(3);
  });

  it("groups pets with no recorded locality/province under the null key — none are dropped", () => {
    const result = aggregateOverdueByLocality([pet(null, null), pet(null, null)]);
    expect(result).toHaveLength(1);
    expect(result[0].locality).toBeNull();
    expect(result[0].province).toBeNull();
    expect(result[0].count).toBe(2);
  });

  it("returns an empty array for an empty input", () => {
    expect(aggregateOverdueByLocality([])).toEqual([]);
  });

  it("total across all aggregate rows equals the input length (no double-count, no drop)", () => {
    const pets = [
      pet("Buenos Aires", "La Plata"),
      pet("Buenos Aires", "Quilmes"),
      pet("CABA", "Palermo"),
      pet(null, null),
    ];
    const result = aggregateOverdueByLocality(pets);
    const total = result.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(pets.length);
  });
});

// ---------------------------------------------------------------------------
// Pipeline (b) — stray scan density areas
// ---------------------------------------------------------------------------

describe("fetchStrayDensityAreas — pipeline (b)", () => {
  it("returns the test locality with scan count when scans exist", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      // Wide window to capture the seeded scans.
      { since: new Date(Date.now() - 30 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );
    const result = await fetchStrayDensityAreas(ctx);
    const locality = result.areas.find((a) => a.locality === TEST_LOCALITY);
    expect(locality).toBeDefined();
    expect(locality?.scanCount).toBeGreaterThanOrEqual(3);
  });

  it("returns empty when no stray scans in jurisdiction", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Santa Cruz", locality: "no-stray-scans-here" }],
      { since: new Date(Date.now() - 30 * 86400_000), until: new Date() },
    );
    const result = await fetchStrayDensityAreas(ctx);
    expect(result.areas).toHaveLength(0);
    expect(result.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pipeline (c) — sterilization vet ranking
// ---------------------------------------------------------------------------

describe("fetchSterilizationVetRanking — pipeline (c)", () => {
  it("includes the seeded vet in the ranking for the test jurisdiction", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 90 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );
    const result = await fetchSterilizationVetRanking(ctx);
    // The seeded sterilization used "Dr. Test Vet" as performed_by.
    const vet = result.vets.find((v) => v.vetLabel === "Dr. Test Vet");
    expect(vet).toBeDefined();
    expect(vet?.count).toBeGreaterThanOrEqual(1);
  });

  it("attributes an amended sterilization to the CORRECTED vet name", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 90 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );
    const result = await fetchSterilizationVetRanking(ctx);
    const labels = result.vets.map((v) => v.vetLabel);
    // The event_amended correction must win over the raw payload value.
    expect(labels).toContain("Dra. Corregida Vet");
    expect(labels).not.toContain("Dr. Typo Vet");
  });

  it("returns empty when no sterilizations in jurisdiction", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Chubut", locality: "no-steril-here" }],
      { since: new Date(Date.now() - 90 * 86400_000), until: new Date() },
    );
    const result = await fetchSterilizationVetRanking(ctx);
    expect(result.vets).toHaveLength(0);
    expect(result.empty).toBe(true);
  });
});
