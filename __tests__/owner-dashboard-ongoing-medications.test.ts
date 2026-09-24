// fetchOngoingMedications (lib/analytics/owner-dashboard.ts) — the /inicio
// widget listing open treatments. Fresh security review, 2026-09-22: it read
// drug_name/frequency RAW through the `e.payload` alias, so a prescription
// corrected via event_amended kept showing the drug it was corrected AWAY
// from. Fixed with amendedPayloadText (the same SQL-twin fix as
// fetchAmrDensity in lib/analytics/surveillance-metrics.ts).
//
// Fixture pattern mirrors __tests__/surveillance-compliance.test.ts
// (token-prefix cleanup, direct petEvents insert — INSERT is not the
// append-only trigger's concern, so no withMutationOverride is needed to
// SEED; it IS needed to delete the fixture events in cleanup).

import { createClient } from "@supabase/supabase-js";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets } from "@/db";
import { fetchOngoingMedications } from "@/lib/analytics/owner-dashboard";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "ongoing-meds-owner@dim-test.local";
const TEST_PET_TOKEN_PREFIX = "OM-TEST-";
let ownerUserId: string;

async function ensureOwner(): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) return existing.id;
  const r = await createFreshTestUser(adminSdk, {
    email: OWNER_EMAIL,
    password: "OngoingMedsTest_2026!",
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

  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertFixturePet(name: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TEST_PET_TOKEN_PREFIX}${generatePublicToken().slice(4)}`,
      name,
      species: "dog",
      status: "active",
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

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtureRows();
});

afterAll(cleanupFixtureRows);

describe("fetchOngoingMedications", () => {
  it("reads the CORRECTED drug_name and frequency: an amended prescription is not shown as the drug it was corrected away from", async () => {
    const petId = await insertFixturePet("OM Amended");
    const startedEventId = await insertEvent({
      petId,
      eventType: "medication_started",
      payload: {
        drug_name: "Amoxicilina",
        dose: "10mg",
        frequency: "cada 8 horas",
        prescribed_by: null,
        drug_code: "amoxicillin",
        first_dose_at: new Date().toISOString(),
        duration_days: 7,
        custom_hours: null,
        schedule_count: 21,
      },
      occurredAt: new Date(Date.now() - 60_000),
    });
    await insertEvent({
      petId,
      eventType: "event_amended",
      payload: {
        target_event_id: startedEventId,
        reason: "Error de tipeo",
        changes: [
          { field: "drug_name", old: "Amoxicilina", new: "Meloxicam" },
          { field: "frequency", old: "cada 8 horas", new: "cada 24 horas" },
        ],
      },
      occurredAt: new Date(),
    });

    const rows = await fetchOngoingMedications(ownerUserId);
    const row = rows.find((r) => r.eventId === startedEventId);
    expect(row).toBeDefined();
    expect(row?.drugName).toBe("Meloxicam");
    expect(row?.frequency).toBe("cada 24 horas");
    // Not the raw payload value the correction replaced.
    expect(row?.drugName).not.toBe("Amoxicilina");
    expect(row?.frequency).not.toBe("cada 8 horas");
  });

  it("shows the raw value when a medication has no amendment", async () => {
    const petId = await insertFixturePet("OM Unamended");
    const startedEventId = await insertEvent({
      petId,
      eventType: "medication_started",
      payload: {
        drug_name: "Meloxicam",
        dose: "5mg",
        frequency: "cada 12 horas",
        prescribed_by: null,
        drug_code: "meloxicam",
        first_dose_at: new Date().toISOString(),
        duration_days: 5,
        custom_hours: null,
        schedule_count: 10,
      },
      occurredAt: new Date(Date.now() - 60_000),
    });

    const rows = await fetchOngoingMedications(ownerUserId);
    const row = rows.find((r) => r.eventId === startedEventId);
    expect(row).toBeDefined();
    expect(row?.drugName).toBe("Meloxicam");
    expect(row?.frequency).toBe("cada 12 horas");
  });
});
