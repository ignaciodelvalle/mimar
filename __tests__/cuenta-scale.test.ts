// Scale test for /cuenta data-loading functions (UX audit item 0.3).
//
// Production incident: an owner with ~2 000 pets triggered a hard crash
// (digest 3058248096) because fetchPetsForOwner loaded ALL rows into JS memory
// without a LIMIT. This test verifies the fix: the function never materialises
// more than DASHBOARD_PETS_LIMIT rows, while the SQL COUNT remains accurate
// for any volume.
//
// Seed strategy:
//   - Creates a dedicated test auth user (isolated from perf-seed data).
//   - Inserts SCALE_PET_COUNT pets directly via Drizzle (same append-only
//     tables; no LIMIT bypasses needed for inserts).
//   - Verifies that fetchPetsForOwner returns ≤ DASHBOARD_PETS_LIMIT rows.
//   - Verifies that the returned `total` (SQL COUNT) equals SCALE_PET_COUNT.
//   - Verifies that fetchActiveReminders returns ≤ DASHBOARD_REMINDERS_LIMIT rows.
//   - Verifies that countActiveReminders returns the accurate total.
//   - Verifies that the full suite completes without throwing (regression guard).
//
// Cleanup: afterAll deletes all test pets + the auth user.

import { createClient } from "@supabase/supabase-js";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, pets, reminders } from "@/db";
import {
  DASHBOARD_PETS_LIMIT,
  DASHBOARD_REMINDERS_LIMIT,
  countActiveReminders,
  fetchActiveReminders,
  fetchPetsForOwner,
} from "@/lib/analytics/owner-dashboard";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// Number of pets to seed — must exceed DASHBOARD_PETS_LIMIT to trigger the bug.
// 500 is large enough to prove the bound without being slow.
const SCALE_PET_COUNT = 500;
// Number of reminders to seed — must exceed DASHBOARD_REMINDERS_LIMIT.
const SCALE_REMINDER_COUNT = DASHBOARD_REMINDERS_LIMIT + 50;

const EMAIL = "cuenta-scale@dim-test.local";
const PASS = "CuentaScale_2026!";

let userId: string;
const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Remove any stale fixture from a previous interrupted run.
  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list?.users.find((u) => u.email === EMAIL);
  if (existing) {
    const owned = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(eq(ownerships.ownerUserId, existing.id));
    if (owned.length > 0) {
      const ids = owned.map((o) => o.petId);
      await withMutationOverride(async (tx) => {
        await tx.delete(pets).where(inArray(pets.id, ids));
      });
    }
    await admin.auth.admin.deleteUser(existing.id);
  }

  // Create fresh auth user.
  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  userId = data.user.id;

  // Insert SCALE_PET_COUNT pets in batches to avoid overly large single insert.
  const BATCH = 100;
  const now = new Date();

  for (let start = 0; start < SCALE_PET_COUNT; start += BATCH) {
    const end = Math.min(start + BATCH, SCALE_PET_COUNT);
    const batch = Array.from({ length: end - start }, (_, i) => {
      const idx = start + i;
      return {
        publicToken: `SCALE-TEST-${userId.slice(0, 8)}-${String(idx).padStart(5, "0")}`,
        name: `ScalePet ${idx}`,
        species: "dog" as const,
        sex: "unknown" as const,
        status: "active" as const,
      };
    });

    const inserted = await db.insert(pets).values(batch).returning({ id: pets.id });
    const petIds = inserted.map((r) => r.id);
    insertedPetIds.push(...petIds);

    // Insert ownership rows for this batch.
    await db.insert(ownerships).values(
      petIds.map((petId) => ({
        petId,
        ownerUserId: userId,
        role: "owner" as const,
      })),
    );
  }

  // Insert SCALE_REMINDER_COUNT reminders (all for the first pet) so we can
  // test the reminders cap independently of the pets count.
  const firstPetId = insertedPetIds[0];
  const reminderBatch = Array.from({ length: SCALE_REMINDER_COUNT }, (_, i) => ({
    petId: firstPetId,
    userId,
    reminderType: "vaccine" as const,
    title: `ScaleVaccine${i}`,
    dueAt: new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000), // i+1 days from now
    completedAt: null,
    snoozedUntil: null,
  }));

  await db.insert(reminders).values(reminderBatch);
}, 60_000); // 60 s timeout — inserting 500 pets takes a few seconds

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (insertedPetIds.length > 0) {
    await withMutationOverride(async (tx) => {
      const BATCH = 200;
      for (let start = 0; start < insertedPetIds.length; start += BATCH) {
        const batch = insertedPetIds.slice(start, start + BATCH);
        await tx.delete(pets).where(inArray(pets.id, batch));
      }
    });
  }
  if (userId) {
    await admin.auth.admin.deleteUser(userId);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchPetsForOwner scale guard — high-volume owner", () => {
  it("seeds the expected number of pets (precondition)", () => {
    expect(insertedPetIds.length).toBe(SCALE_PET_COUNT);
  });

  it("returns at most DASHBOARD_PETS_LIMIT rows (bound enforced)", async () => {
    const { pets: rows } = await fetchPetsForOwner(userId);
    expect(rows.length).toBeLessThanOrEqual(DASHBOARD_PETS_LIMIT);
    // Must return some rows (not empty)
    expect(rows.length).toBeGreaterThan(0);
  });

  it("total equals the full SQL COUNT (not just the row slice)", async () => {
    const { total } = await fetchPetsForOwner(userId);
    // The SQL COUNT must match every ownership we inserted.
    expect(total).toBe(SCALE_PET_COUNT);
  });

  it("total is larger than the returned rows slice", async () => {
    const { pets: rows, total } = await fetchPetsForOwner(userId);
    expect(total).toBeGreaterThan(rows.length);
  });

  it("does NOT throw for a high-volume owner (regression guard)", async () => {
    await expect(fetchPetsForOwner(userId)).resolves.toBeDefined();
  });
});

describe("fetchActiveReminders scale guard — many reminders", () => {
  it("seeds the expected number of reminders (precondition)", async () => {
    const total = await countActiveReminders(userId);
    expect(total).toBe(SCALE_REMINDER_COUNT);
  });

  it("returns at most DASHBOARD_REMINDERS_LIMIT rows (bound enforced)", async () => {
    const rows = await fetchActiveReminders(userId);
    expect(rows.length).toBeLessThanOrEqual(DASHBOARD_REMINDERS_LIMIT);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("countActiveReminders returns the accurate total (not the capped slice)", async () => {
    const total = await countActiveReminders(userId);
    expect(total).toBe(SCALE_REMINDER_COUNT);
  });

  it("countActiveReminders total exceeds the fetchActiveReminders cap", async () => {
    const [rows, total] = await Promise.all([
      fetchActiveReminders(userId),
      countActiveReminders(userId),
    ]);
    expect(total).toBeGreaterThan(rows.length);
  });

  it("does NOT throw for a high-volume owner (regression guard)", async () => {
    await expect(fetchActiveReminders(userId)).resolves.toBeDefined();
    await expect(countActiveReminders(userId)).resolves.toBeTypeOf("number");
  });
});
