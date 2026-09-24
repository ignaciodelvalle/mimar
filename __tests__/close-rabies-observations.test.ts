// Cron invariants test — close-rabies-observations handler (P7-1).
//
// Three invariants per the handoff:
//  1. Runtime window — only obs whose period elapsed move to window_expired_unclosed;
//     future obs stay in_progress. NOTHING is closed here: since 2026-08-17 the
//     sweep asserts no clinical outcome (only a professional may).
//  2. Idempotency — second run on already-transitioned pets is a no-op (scanned=0).
//  3. Recovery — bad payload (missing observation_until) is recorded as an error but does
//     not abort the batch.
//
// Mirrors the fixture pattern of foster-proposal-expirer.test.ts.

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, petEvents, pets, profiles } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { closeEligibleRabiesObservations } from "@/lib/infra/rabies-observation-closer";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const OWNER_EMAIL = "rabies-cron-owner@dim-test.local";
const PASS = "RabCron_2026!";

let ownerUserId: string;
const createdPetIds: string[] = [];

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  if (!found) return;
  // Deleting a profile cascades a SET NULL onto pet_events.recorded_by_user_id
  // (an UPDATE), which the pet_events append-only trigger blocks unless the
  // mutation-override GUC is set. Leftover events from a prior run can
  // reference this user, so the purge must run under the override to stay
  // hermetic against a polluted local DB (mirrors the afterAll cleanup).
  await withMutationOverride(async (tx) => {
    await tx.delete(notifications).where(eq(notifications.userId, found.id));
    await tx.delete(profiles).where(eq(profiles.id, found.id));
  });
  await supabase.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  const { data, error } = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser owner: ${error?.message}`);
  ownerUserId = data.user.id;
});

afterAll(async () => {
  if (createdPetIds.length > 0) {
    await db
      .delete(notifications)
      .where(and(...createdPetIds.map((id) => eq(notifications.relatedPetId, id))))
      .catch(() => {});
    await withMutationOverride(async (tx) => {
      for (const id of createdPetIds) {
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(ownerships).where(eq(ownerships.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    });
  }
  await purgeUserByEmail(OWNER_EMAIL);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeRabiesPet(opts: {
  observationUntil: Date | null | "missing";
  status?: "in_progress" | "completed_negative" | "window_expired_unclosed";
}): Promise<{ id: string; publicToken: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "RabiesTestPet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      rabiesObservationStatus: opts.status ?? "in_progress",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    })
    .returning();
  createdPetIds.push(pet.id);

  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });

  // Insert the rabies_observation_started event. authorRole=govt because the
  // event-schema requires that or admin/vet; the closer just reads
  // observation_until from the payload.
  const occurredAt = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000); // 11d ago
  const payload: Record<string, unknown> = {
    payload_version: 1,
    bite_event_id: crypto.randomUUID(),
    incident_severity: "low",
    observation_started_role: "govt",
    closure_target_role: "vet",
  };
  if (opts.observationUntil !== "missing" && opts.observationUntil !== null) {
    payload.observation_until = opts.observationUntil.toISOString();
  }

  await withMutationOverride(async (tx) => {
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "rabies_observation_started",
      occurredAt,
      recordedAt: occurredAt,
      recordedByUserId: ownerUserId,
      authorRole: "govt",
      payload,
    });
  });

  return { id: pet.id, publicToken: pet.publicToken };
}

/**
 * A pet flagged in_progress but with NO rabies_observation_started event at
 * all — the still-real error path (commit 923e5079 replaced the "missing
 * observation_until" error with a computeObservationUntil fallback, but a
 * pet with no started event has nothing to fall back to).
 */
async function makeRabiesPetWithNoStartedEvent(): Promise<{ id: string; publicToken: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "RabiesTestPetNoEvent",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      rabiesObservationStatus: "in_progress",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    })
    .returning();
  createdPetIds.push(pet.id);

  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });

  return { id: pet.id, publicToken: pet.publicToken };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("closeEligibleRabiesObservations", () => {
  it("runtime window — pets past observation_until are closed; future pets are skipped", async () => {
    const stale = await makeRabiesPet({
      observationUntil: new Date(Date.now() - 60 * 1000), // expired 1m ago
    });
    const fresh = await makeRabiesPet({
      observationUntil: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
    });

    const stats = await closeEligibleRabiesObservations();

    expect(stats.scanned).toBeGreaterThanOrEqual(2);
    expect(stats.windowExpiredUnclosed).toBeGreaterThanOrEqual(1);
    expect(stats.skippedNotYetDue).toBeGreaterThanOrEqual(1);

    const [staleRow] = await db
      .select({ status: pets.rabiesObservationStatus })
      .from(pets)
      .where(eq(pets.id, stale.id));
    expect(staleRow.status).toBe("window_expired_unclosed");

    const [freshRow] = await db
      .select({ status: pets.rabiesObservationStatus })
      .from(pets)
      .where(eq(pets.id, fresh.id));
    expect(freshRow.status).toBe("in_progress");
  });

  it("A1 prospective — a stored per-jurisdiction deadline beats the hardcoded 10 days", async () => {
    // occurredAt is 11 days ago (past the OLD hardcoded 10-day mark), but the
    // stored observation_until reflects a 14-day jurisdiction rule → 3 days
    // out. The cron reads the stored deadline VERBATIM: the pet must stay in
    // observation. This is what makes the A1 rule change prospective — the
    // sweep never recomputes a deadline that was already written.
    const jurisdictionRuled = await makeRabiesPet({
      observationUntil: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    await closeEligibleRabiesObservations();

    const [row] = await db
      .select({ status: pets.rabiesObservationStatus })
      .from(pets)
      .where(eq(pets.id, jurisdictionRuled.id));
    expect(row.status).toBe("in_progress");
  });

  it("idempotency — second run on the same closed pet is a no-op", async () => {
    const pet = await makeRabiesPet({
      observationUntil: new Date(Date.now() - 5 * 60 * 1000),
    });

    const first = await closeEligibleRabiesObservations();
    expect(first.windowExpiredUnclosed).toBeGreaterThanOrEqual(1);

    const second = await closeEligibleRabiesObservations();
    // The pet is now window_expired_unclosed; the scanner only picks in_progress.
    const [row] = await db
      .select({ status: pets.rabiesObservationStatus })
      .from(pets)
      .where(eq(pets.id, pet.id));
    expect(row.status).toBe("window_expired_unclosed");
    // Stats from the second run: the closed pet must not appear in scanned.
    // (Other in_progress pets may, so we only assert this pet stayed terminal.)
    expect(second.windowExpiredUnclosed).toBe(0);
  });

  it("recovery — missing observation_until falls back to the computed 10-day deadline and transitions (commit 923e5079)", async () => {
    // No observation_until in the started payload, but the event occurred 11
    // days ago (see makeRabiesPet) — computeObservationUntil derives a
    // deadline 10 days after occurredAt, which is already past. The old
    // behavior recorded this as an error; the sweep now transitions it.
    const recovered = await makeRabiesPet({ observationUntil: "missing" });

    const stats = await closeEligibleRabiesObservations();
    expect(stats.errors.some((e) => e.petId === recovered.id)).toBe(false);

    const [row] = await db
      .select({ status: pets.rabiesObservationStatus })
      .from(pets)
      .where(eq(pets.id, recovered.id));
    expect(row.status).toBe("window_expired_unclosed");
  });

  it("recovery — in_progress pet with no rabies_observation_started event is recorded as an error, batch survives", async () => {
    const bad = await makeRabiesPetWithNoStartedEvent();
    const good = await makeRabiesPet({
      observationUntil: new Date(Date.now() - 5 * 60 * 1000),
    });

    const stats = await closeEligibleRabiesObservations();
    const badError = stats.errors.find((e) => e.petId === bad.id);
    expect(badError).toBeDefined();
    expect(badError?.reason).toContain("no rabies_observation_started event found");

    // The good pet still transitioned despite the bad row in the same batch.
    const [goodRow] = await db
      .select({ status: pets.rabiesObservationStatus })
      .from(pets)
      .where(eq(pets.id, good.id));
    expect(goodRow.status).toBe("window_expired_unclosed");
  });
});
