// Integration tests for lib/surveillance-metrics (Item 3 — surveillance
// hardening). Seeds the relevant events/outbox rows against the local Postgres
// and asserts each projection. Mirrors the ephemeral-fixture pattern in
// __tests__/govt-dashboards.test.ts (token-prefix cleanup + withMutationOverride
// for the pet_events append-only trigger).
//
// Per umbrella §5 the suite includes a k-anonymity suppression case
// (fetchReportableIncidence drops disease cells with count < 5) and a
// jurisdiction-scope case (govt sees only its assigned localities).

import { createClient } from "@supabase/supabase-js";
import { inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, eventNotificationOutbox, ownerships, petEvents, pets } from "@/db";
import {
  fetchAmrDensity,
  fetchEnoSla,
  fetchRabiesObservationCompliance,
  fetchReportableIncidence,
} from "@/lib/analytics/surveillance-metrics";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { buildProjectionContext, windows } from "@/lib/metrics";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "surv-compliance-owner@dim-test.local";
let ownerUserId: string;

const TEST_PET_TOKEN_PREFIX = "SC-TEST-";
const DAY_MS = 24 * 60 * 60 * 1000;

// Build a ProjectionContext with a wide (12m) reporting window so seeded
// events at realistic offsets fall inside the period.
function ctxFor(actor: DashboardActor, jurisdictions: DashboardJurisdiction[]) {
  return buildProjectionContext(actor, jurisdictions, windows.trailing12m());
}

async function ensureOwner(): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) return existing.id;
  const r = await createFreshTestUser(adminSdk, {
    email: OWNER_EMAIL,
    password: "SurvComplianceTest_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  return r.data.user.id;
}

async function cleanupFixtureRows() {
  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${TEST_PET_TOKEN_PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);
  if (ids.length === 0) return;

  // event_notification_outbox FK -> pet_events ON DELETE CASCADE, so deleting
  // the events also removes outbox rows. Delete events via the override.
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertFixturePet(input: {
  name: string;
  province: string;
  locality: string;
  species?: string;
  status?: "active" | "lost" | "deceased";
  rabiesObservationStatus?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TEST_PET_TOKEN_PREFIX}${generatePublicToken().slice(4)}`,
      name: input.name,
      species: input.species ?? "dog",
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: input.status ?? "active",
      rabiesObservationStatus: input.rabiesObservationStatus ?? null,
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: row.id, ownerUserId, role: "owner" });
  return row.id;
}

async function insertEvent(input: {
  petId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId: input.petId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      payload: { payload_version: 1, ...input.payload },
      authorRole: "system",
      recordedByUserId: null,
    })
    .returning({ id: petEvents.id });
  return row.id;
}

async function insertOutboxRow(input: {
  sourceEventId: string;
  province: string;
  locality: string;
  status: "pending" | "delivered" | "failed";
  createdAt: Date;
  slaDueAt: Date;
  deliveredAt?: Date | null;
}) {
  await db.insert(eventNotificationOutbox).values({
    sourceEventId: input.sourceEventId,
    targetKind: "eno_authority",
    targetJurisdictionProvince: input.province,
    targetJurisdictionLocality: input.locality,
    payloadSnapshot: {},
    status: input.status,
    createdAt: input.createdAt,
    slaDueAt: input.slaDueAt,
    deliveredAt: input.deliveredAt ?? null,
  });
}

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtureRows();
});

afterEach(cleanupFixtureRows);

// ===========================================================================
// A7 — ENO-notification SLA
// ===========================================================================

describe("fetchEnoSla", () => {
  it("computes on-time %, breached count, and median latency", async () => {
    const prov = "Mendoza";
    const loc = "Godoy Cruz";
    const pet = await insertFixturePet({ name: "EnoPet", province: prov, locality: loc });
    const ev = await insertEvent({
      petId: pet,
      eventType: "outbreak_signal",
      payload: { disease_code: "rabies_suspected" },
      occurredAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const now = Date.now();
    // Delivered ON TIME: created 5d ago, delivered 1h later, SLA 24h after creation.
    await insertOutboxRow({
      sourceEventId: ev,
      province: prov,
      locality: loc,
      status: "delivered",
      createdAt: new Date(now - 5 * DAY_MS),
      slaDueAt: new Date(now - 5 * DAY_MS + DAY_MS),
      deliveredAt: new Date(now - 5 * DAY_MS + 60 * 60 * 1000),
    });
    // Delivered LATE: delivered after the SLA deadline.
    await insertOutboxRow({
      sourceEventId: ev,
      province: prov,
      locality: loc,
      status: "delivered",
      createdAt: new Date(now - 4 * DAY_MS),
      slaDueAt: new Date(now - 4 * DAY_MS + DAY_MS),
      deliveredAt: new Date(now - 4 * DAY_MS + 3 * DAY_MS),
    });
    // PENDING + past SLA → a live breach.
    await insertOutboxRow({
      sourceEventId: ev,
      province: prov,
      locality: loc,
      status: "pending",
      createdAt: new Date(now - 3 * DAY_MS),
      slaDueAt: new Date(now - 2 * DAY_MS),
      deliveredAt: null,
    });

    const m = await fetchEnoSla(ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]));
    expect(m.total).toBeGreaterThanOrEqual(3);
    // 1 of 2 delivered rows was on time → 50%.
    expect(m.onTime).toBe(1);
    expect(m.onTimePct).toBe(50);
    expect(m.breachedOpen).toBeGreaterThanOrEqual(1);
    // Median latency over delivered rows is between the 1h and 3d values.
    expect(m.medianLatencyHours).not.toBeNull();
    if (m.medianLatencyHours !== null) {
      expect(m.medianLatencyHours).toBeGreaterThan(0);
    }
  });

  it("returns null on-time % when no rows are delivered", async () => {
    const prov = "Salta";
    const loc = "Salta Capital";
    const pet = await insertFixturePet({ name: "EnoPendingPet", province: prov, locality: loc });
    const ev = await insertEvent({
      petId: pet,
      eventType: "outbreak_signal",
      payload: { disease_code: "rabies_suspected" },
      occurredAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await insertOutboxRow({
      sourceEventId: ev,
      province: prov,
      locality: loc,
      status: "pending",
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      slaDueAt: new Date(Date.now() + DAY_MS),
      deliveredAt: null,
    });

    const m = await fetchEnoSla(ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]));
    expect(m.onTimePct).toBeNull();
    expect(m.medianLatencyHours).toBeNull();
  });

  it("scope: govt only sees outbox rows in its assigned localities", async () => {
    const prov = "Chubut";
    const inLoc = "Rawson";
    const outLoc = "Comodoro Rivadavia";
    const petIn = await insertFixturePet({ name: "EnoIn", province: prov, locality: inLoc });
    const petOut = await insertFixturePet({ name: "EnoOut", province: prov, locality: outLoc });
    const evIn = await insertEvent({
      petId: petIn,
      eventType: "outbreak_signal",
      payload: {},
      occurredAt: new Date(Date.now() - DAY_MS),
    });
    const evOut = await insertEvent({
      petId: petOut,
      eventType: "outbreak_signal",
      payload: {},
      occurredAt: new Date(Date.now() - DAY_MS),
    });
    const base = {
      status: "delivered" as const,
      createdAt: new Date(Date.now() - DAY_MS),
      slaDueAt: new Date(Date.now() - DAY_MS + DAY_MS),
      deliveredAt: new Date(Date.now() - DAY_MS + 60 * 60 * 1000),
    };
    await insertOutboxRow({ sourceEventId: evIn, province: prov, locality: inLoc, ...base });
    await insertOutboxRow({ sourceEventId: evOut, province: prov, locality: outLoc, ...base });

    const scoped = await fetchEnoSla(
      ctxFor({ role: "govt" }, [{ province: prov, locality: inLoc }]),
    );
    // Exactly the in-scope row — the out-of-scope locality must not inflate it.
    expect(scoped.total).toBe(1);
  });

  it("returns zeros for govt with no assignments", async () => {
    const m = await fetchEnoSla(ctxFor({ role: "govt" }, []));
    expect(m.total).toBe(0);
    expect(m.breachedOpen).toBe(0);
  });

  it("scope: whole-province operator (CABA) sees barrio-scoped deliveries", async () => {
    // A whole-CABA operator is assigned the whole-province INDEC locality
    // ("Ciudad Autónoma de Buenos Aires"). Outbox rows target a specific barrio
    // (or a null locality). Before whole-province subsumption the exact-pair
    // clause matched neither, so the operator saw "sin entregas" despite live
    // deliveries — the bug this test locks down.
    const prov = "CABA";
    const wholeProvince = "Ciudad Autónoma de Buenos Aires";
    const barrio = "Palermo";
    const pet = await insertFixturePet({ name: "EnoCaba", province: prov, locality: barrio });
    const ev = await insertEvent({
      petId: pet,
      eventType: "outbreak_signal",
      payload: {},
      occurredAt: new Date(Date.now() - DAY_MS),
    });
    await insertOutboxRow({
      sourceEventId: ev,
      province: prov,
      locality: barrio,
      status: "delivered",
      createdAt: new Date(Date.now() - DAY_MS),
      slaDueAt: new Date(Date.now()),
      deliveredAt: new Date(Date.now() - DAY_MS + 60 * 60 * 1000),
    });

    const scoped = await fetchEnoSla(
      ctxFor({ role: "govt" }, [{ province: prov, locality: wholeProvince }]),
    );
    // Whole-province subsumption: the barrio-scoped delivery is in scope.
    expect(scoped.total).toBe(1);
    expect(scoped.onTime).toBe(1);
  });
});

// ===========================================================================
// A8 / A9 — Rabies-observation 10-day compliance
// ===========================================================================

describe("fetchRabiesObservationCompliance", () => {
  async function seedObservation(input: {
    petId: string;
    startedDaysAgo: number;
    endedDaysAgo?: number | null;
  }): Promise<void> {
    const startedAt = new Date(Date.now() - input.startedDaysAgo * DAY_MS);
    const startId = await insertEvent({
      petId: input.petId,
      eventType: "rabies_observation_started",
      payload: {
        bite_event_id: "00000000-0000-0000-0000-000000000000",
        observation_until: new Date(startedAt.getTime() + 10 * DAY_MS).toISOString(),
        location: "in_situ",
        official_site_organization_id: null,
      },
      occurredAt: startedAt,
    });
    if (input.endedDaysAgo != null) {
      await insertEvent({
        petId: input.petId,
        eventType: "rabies_observation_ended",
        payload: {
          bite_event_id: "00000000-0000-0000-0000-000000000000",
          observation_started_event_id: startId,
          outcome: "negative",
          closed_by_role: "system",
          closure_notes: null,
          death_event_id: null,
        },
        occurredAt: new Date(Date.now() - input.endedDaysAgo * DAY_MS),
      });
    }
  }

  it("A8: one closed on day 8 (compliant), one closed on day 12 (late)", async () => {
    const prov = "Río Negro";
    const loc = "Bariloche";
    const petCompliant = await insertFixturePet({ name: "ObsOK", province: prov, locality: loc });
    const petLate = await insertFixturePet({ name: "ObsLate", province: prov, locality: loc });
    // Started 20d ago, closed 12d ago → elapsed 8d → within window.
    await seedObservation({ petId: petCompliant, startedDaysAgo: 20, endedDaysAgo: 12 });
    // Started 20d ago, closed 8d ago → elapsed 12d → outside window.
    await seedObservation({ petId: petLate, startedDaysAgo: 20, endedDaysAgo: 8 });

    const m = await fetchRabiesObservationCompliance(
      ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]),
    );
    expect(m.closed).toBe(2);
    expect(m.closedWithinWindow).toBe(1);
    expect(m.compliancePct).toBe(50);
  });

  it("A9: an observation open past day 10 is a live breach", async () => {
    const prov = "Neuquén";
    const loc = "Neuquén Capital";
    const petOpen = await insertFixturePet({
      name: "ObsOpen",
      province: prov,
      locality: loc,
      rabiesObservationStatus: "in_progress",
    });
    // Started 12 days ago, never ended → breach.
    await seedObservation({ petId: petOpen, startedDaysAgo: 12, endedDaysAgo: null });
    // A fresh open observation (2 days ago) is NOT yet a breach.
    const petFresh = await insertFixturePet({
      name: "ObsFresh",
      province: prov,
      locality: loc,
      rabiesObservationStatus: "in_progress",
    });
    await seedObservation({ petId: petFresh, startedDaysAgo: 2, endedDaysAgo: null });

    const m = await fetchRabiesObservationCompliance(
      ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]),
    );
    expect(m.openBreaches).toBe(1);
  });

  it("scope: govt does not see observations outside its jurisdiction", async () => {
    const prov = "Jujuy";
    const inLoc = "San Salvador de Jujuy";
    const outLoc = "Palpalá";
    const petIn = await insertFixturePet({ name: "ObsIn", province: prov, locality: inLoc });
    const petOut = await insertFixturePet({ name: "ObsOut", province: prov, locality: outLoc });
    await seedObservation({ petId: petIn, startedDaysAgo: 20, endedDaysAgo: 12 });
    await seedObservation({ petId: petOut, startedDaysAgo: 20, endedDaysAgo: 12 });

    const m = await fetchRabiesObservationCompliance(
      ctxFor({ role: "govt" }, [{ province: prov, locality: inLoc }]),
    );
    // Only the in-scope observation is counted.
    expect(m.closed).toBe(1);
  });
});

// ===========================================================================
// A12 — AMR / antimicrobial density
// ===========================================================================

describe("fetchAmrDensity", () => {
  async function seedMedication(petId: string, drugCode: string | null): Promise<string> {
    return insertEvent({
      petId,
      eventType: "medication_started",
      payload: {
        drug_name: drugCode ?? "unknown",
        dose: "10mg",
        frequency: "twice_daily",
        prescribed_by: null,
        drug_code: drugCode,
        first_dose_at: new Date().toISOString(),
        duration_days: 7,
        custom_hours: null,
        schedule_count: 14,
      },
      occurredAt: new Date(Date.now() - DAY_MS),
    });
  }

  it("counts only antimicrobials in the rate; computes per-1000", async () => {
    const prov = "San Juan";
    const loc = "Rivadavia";
    const pet1 = await insertFixturePet({ name: "AmrPet1", province: prov, locality: loc });
    const pet2 = await insertFixturePet({ name: "AmrPet2", province: prov, locality: loc });
    // Two antimicrobial starts and one NSAID (not counted).
    await seedMedication(pet1, "amoxicillin");
    await seedMedication(pet1, "enrofloxacin");
    await seedMedication(pet2, "meloxicam");

    const m = await fetchAmrDensity(ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]));
    expect(m.antimicrobialCount).toBe(2);
    expect(m.activePets).toBeGreaterThanOrEqual(2);
    // per1000 = antimicrobialCount / activePets * 1000. With 2 pets → 1000.
    expect(m.per1000).not.toBeNull();
    if (m.per1000 !== null) expect(m.per1000).toBeGreaterThan(0);
    // The NSAID is a KNOWN drug, so it is not provisional/unclassified.
    expect(m.provisionalUnclassified).toBe(0);
  });

  it("uncertain (uncatalogued) codes are counted as provisional, not in the rate", async () => {
    const prov = "Catamarca";
    const loc = "Andalgalá";
    const pet = await insertFixturePet({ name: "AmrUnknown", province: prov, locality: loc });
    await seedMedication(pet, "mystery_compound_x");
    await seedMedication(pet, null);

    const m = await fetchAmrDensity(ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]));
    // Neither uncatalogued nor null counts as a confident antimicrobial.
    expect(m.antimicrobialCount).toBe(0);
    expect(m.provisionalUnclassified).toBe(2);
  });

  it("scope: govt only counts medications for pets in its jurisdiction", async () => {
    const prov = "La Pampa";
    const inLoc = "General Pico";
    const outLoc = "Santa Rosa";
    const petIn = await insertFixturePet({ name: "AmrIn", province: prov, locality: inLoc });
    const petOut = await insertFixturePet({ name: "AmrOut", province: prov, locality: outLoc });
    await seedMedication(petIn, "amoxicillin");
    await seedMedication(petOut, "amoxicillin");

    const m = await fetchAmrDensity(
      ctxFor({ role: "govt" }, [{ province: prov, locality: inLoc }]),
    );
    expect(m.antimicrobialCount).toBe(1);
  });

  // Fresh security review, 2026-09-22: drug_code was read RAW through the
  // `med.payload` alias, so a corrected prescription kept counting as the
  // drug it was corrected away from.
  it("reads the CORRECTED drug_code: an amended prescription moves in and out of the rate", async () => {
    const prov = "Chubut";
    const loc = "Esquel";
    const pet = await insertFixturePet({ name: "AmrAmended", province: prov, locality: loc });
    // Two NSAIDs corrected INTO antimicrobials, one antimicrobial corrected
    // OUT. Raw read: 1 antimicrobial. Corrected read: 2.
    const corrections: Array<[string, string, string]> = [
      [await seedMedication(pet, "meloxicam"), "meloxicam", "amoxicillin"],
      [await seedMedication(pet, "meloxicam"), "meloxicam", "enrofloxacin"],
      [await seedMedication(pet, "amoxicillin"), "amoxicillin", "meloxicam"],
    ];
    for (const [target, from, to] of corrections) {
      await insertEvent({
        petId: pet,
        eventType: "event_amended",
        payload: {
          target_event_id: target,
          reason: null,
          changes: [{ field: "drug_code", old: from, new: to }],
        },
        occurredAt: new Date(),
      });
    }

    const m = await fetchAmrDensity(ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]));
    expect(m.antimicrobialCount).toBe(2);
    expect(m.provisionalUnclassified).toBe(0);
  });
});

// ===========================================================================
// A6 / A10 — Reportable incidence + lab-confirmation + k-anonymity
// ===========================================================================

describe("fetchReportableIncidence", () => {
  async function seedDiseaseReport(petId: string, disease: string, confirmed: boolean) {
    await insertEvent({
      petId,
      eventType: "disease_reported",
      payload: {
        disease,
        confirmed_by_lab: confirmed,
        date_of_onset: new Date().toISOString().slice(0, 10),
        clinical_notes: null,
      },
      occurredAt: new Date(Date.now() - DAY_MS),
    });
  }

  async function seedReportableDeath(petId: string, diseaseCode: string, confirmed: boolean) {
    await insertEvent({
      petId,
      eventType: "death_recorded",
      payload: {
        cause: "disease",
        disease_code: diseaseCode,
        confirmed_by_lab: confirmed,
        is_reportable: true,
      },
      occurredAt: new Date(Date.now() - DAY_MS),
    });
  }

  it("A6/A10: counts reportable events and computes lab-confirmation %", async () => {
    const prov = "Formosa";
    // Hermetic locality (not a real seeded barrio): fetchReportableIncidence
    // scopes by exact (province, locality), and the PANO demo seed populates
    // real localities like Clorinda with reportable events that would leak
    // into this exact-count assertion (shared-DB hygiene, cf. commit 49afcb3a).
    const loc = "Clorinda-SC-ISO";
    // Use one pet with many events so a single disease cell crosses k=5.
    const pet = await insertFixturePet({ name: "IncidencePet", province: prov, locality: loc });
    // 6 lepto disease reports (4 confirmed) → cell visible (>= 5).
    for (let i = 0; i < 6; i++) await seedDiseaseReport(pet, "lepto", i < 4);
    // 1 reportable death (confirmed) under disease 'lepto'.
    await seedReportableDeath(pet, "lepto", true);

    const m = await fetchReportableIncidence(
      ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]),
    );
    expect(m.totalReportable).toBe(7);
    expect(m.totalConfirmed).toBe(5);
    // 5/7 ≈ 71.4%.
    expect(m.labConfirmationPct).toBeCloseTo(71.4, 1);
    // lepto cell (7) survives suppression.
    const visible = m.byDisease.value as ReadonlyArray<{ key: string; count: number }>;
    const lepto = visible.find((c) => c.key === "lepto");
    expect(lepto?.count).toBe(7);
  });

  it("k-anonymity: a disease cell with count < 5 is suppressed", async () => {
    const prov = "Santa Cruz";
    // Synthetic locality: scope matching is by literal (province, locality)
    // pair, so a locality no seed will ever use keeps this cell isolated.
    // The original "Río Gallegos" broke when the panorama storyline seeds
    // (PANO-*) populated every real locality with reportable events.
    const loc = "Fixture K-Anonimato";
    const pet = await insertFixturePet({ name: "SmallCellPet", province: prov, locality: loc });
    // Only 2 hidatidosis reports → below k=5 → suppressed.
    await seedDiseaseReport(pet, "hidatidosis", true);
    await seedDiseaseReport(pet, "hidatidosis", false);

    const m = await fetchReportableIncidence(
      ctxFor({ role: "govt" }, [{ province: prov, locality: loc }]),
    );
    const visible = m.byDisease.value as ReadonlyArray<{ key: string; count: number }>;
    expect(visible.find((c) => c.key === "hidatidosis")).toBeUndefined();
    expect(m.byDisease.suppressedCount).toBeGreaterThanOrEqual(1);
    // Headline totals are still the unsuppressed aggregate (no per-pet exposure).
    expect(m.totalReportable).toBe(2);
  });

  it("scope: govt only sees reportable events in its jurisdiction", async () => {
    const prov = "Corrientes";
    // Synthetic localities — same reason as the k-anonymity case above: scope
    // matching is by literal (province, locality) pair, and the panorama
    // storyline seeds (PANO-*) put reportable events in every REAL locality.
    // The original Goya/Mercedes pair broke once a seeded disease_reported in
    // Goya landed inside the trailing-12m window (2026-07-04 gate failure #2 —
    // verified NOT a scope leak: the out-of-jurisdiction fixture stayed
    // excluded; the extra count was in-jurisdiction seed data).
    const inLoc = "Fixture Alcance Dentro";
    const outLoc = "Fixture Alcance Fuera";
    const petIn = await insertFixturePet({ name: "RepIn", province: prov, locality: inLoc });
    const petOut = await insertFixturePet({ name: "RepOut", province: prov, locality: outLoc });
    await seedDiseaseReport(petIn, "lepto", true);
    await seedDiseaseReport(petOut, "lepto", true);

    const m = await fetchReportableIncidence(
      ctxFor({ role: "govt" }, [{ province: prov, locality: inLoc }]),
    );
    expect(m.totalReportable).toBe(1);
  });

  it("returns empty/null for govt with no assignments", async () => {
    const m = await fetchReportableIncidence(ctxFor({ role: "govt" }, []));
    expect(m.totalReportable).toBe(0);
    expect(m.labConfirmationPct).toBeNull();
  });
});
