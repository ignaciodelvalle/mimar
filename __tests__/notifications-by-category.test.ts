// Integration tests for C4 notification category filtering and counts.
//
// Tests the new query helpers:
//   - fetchNotificationCategoryCounts (lib/owner-dashboard.ts)
//
// And a thin inline helper that mimics the page's filtered fetch, so we can
// verify that category filtering + userId scoping work at the DB layer without
// rendering a server component.
//
// Runs against local Postgres via Drizzle. Each describe provisions its own
// fixtures and tears them down in afterAll.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, pets } from "@/db";
import { fetchNotificationCategoryCounts } from "@/lib/analytics/owner-dashboard";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

async function ensureUserDeleted(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  // Explicitly delete notifications for this user before deleting the auth row.
  // Supabase admin.deleteUser does not cascade DB-level FKs synchronously.
  await db.delete(notifications).where(eq(notifications.userId, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

async function createUser(email: string, password: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

async function cleanupUser(userId: string) {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await admin.auth.admin.deleteUser(userId);
}

async function insertNotification(opts: {
  userId: string;
  category?: string | null;
  archivedAt?: Date | null;
}) {
  const [n] = await db
    .insert(notifications)
    .values({
      userId: opts.userId,
      notificationType: "test_notification",
      title: "Test notification",
      severity: "info",
      category: opts.category ?? null,
      archivedAt: opts.archivedAt ?? null,
    })
    .returning();
  return n;
}

/**
 * Clears all notifications for a user — necessary because the
 * `handle_new_user` trigger inserts a 'welcome' notification on every
 * auth.users INSERT. Call this immediately after createUser() and before
 * seeding test-specific rows.
 */
async function clearNotifications(userId: string) {
  await db.delete(notifications).where(eq(notifications.userId, userId));
}

/** Mimics the page's category-filtered fetch (DB layer only, no React). */
async function fetchNotificationsByCategory(
  userId: string,
  activeCat: string,
): Promise<(typeof notifications.$inferSelect)[]> {
  const whereClause =
    activeCat === "all"
      ? and(eq(notifications.userId, userId), isNull(notifications.archivedAt))
      : and(
          eq(notifications.userId, userId),
          isNull(notifications.archivedAt),
          eq(notifications.category, activeCat),
        );

  const rows = await db
    .select({ notification: notifications })
    .from(notifications)
    .where(whereClause)
    .orderBy(desc(notifications.createdAt));

  return rows.map((r) => r.notification);
}

// ---------------------------------------------------------------------------
// T1: Counts per category
// ---------------------------------------------------------------------------

describe("fetchNotificationCategoryCounts — counts per category", () => {
  const EMAIL = "nbc-counts@dim-test.local";
  const PASS = "NbcCounts_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    await clearNotifications(userId); // remove welcome notification from trigger
    // Seed: 3 health + 2 custody + 1 admin
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: "custody" });
    await insertNotification({ userId, category: "custody" });
    await insertNotification({ userId, category: "admin" });
  });

  afterAll(() => cleanupUser(userId));

  it("returns correct per-category counts", async () => {
    const counts = await fetchNotificationCategoryCounts(userId);
    expect(counts.all).toBe(6);
    expect(counts.health).toBe(3);
    expect(counts.custody).toBe(2);
    expect(counts.admin).toBe(1);
    expect(counts.adoption).toBe(0);
    expect(counts.welfare).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T2: Notifications without category are counted in 'all' only
// ---------------------------------------------------------------------------

describe("fetchNotificationCategoryCounts — null category counted in all only", () => {
  const EMAIL = "nbc-null-cat@dim-test.local";
  const PASS = "NbcNullCat_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    await clearNotifications(userId); // remove welcome notification from trigger
    // 1 health + 1 null-category
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: null });
  });

  afterAll(() => cleanupUser(userId));

  it("null-category notification counts in 'all' but not in any specific category", async () => {
    const counts = await fetchNotificationCategoryCounts(userId);
    expect(counts.all).toBe(2);
    expect(counts.health).toBe(1);
    expect(counts.custody).toBe(0);
    expect(counts.adoption).toBe(0);
    expect(counts.welfare).toBe(0);
    expect(counts.admin).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T3: Filter 'health' returns only health rows
// ---------------------------------------------------------------------------

describe("fetchNotificationsByCategory — filter health returns only health rows", () => {
  const EMAIL = "nbc-filter-health@dim-test.local";
  const PASS = "NbcFilterHealth_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    await clearNotifications(userId); // remove welcome notification from trigger
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: "custody" });
    await insertNotification({ userId, category: null });
  });

  afterAll(() => cleanupUser(userId));

  it("returns only health notifications when cat=health", async () => {
    const rows = await fetchNotificationsByCategory(userId, "health");
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe("health");
  });
});

// ---------------------------------------------------------------------------
// T4: Filter 'all' returns everything regardless of category
// ---------------------------------------------------------------------------

describe("fetchNotificationsByCategory — filter all returns all non-archived", () => {
  const EMAIL = "nbc-filter-all@dim-test.local";
  const PASS = "NbcFilterAll_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    await clearNotifications(userId); // remove welcome notification from trigger
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: "custody" });
    await insertNotification({ userId, category: null });
  });

  afterAll(() => cleanupUser(userId));

  it("returns all 3 notifications when cat=all", async () => {
    const rows = await fetchNotificationsByCategory(userId, "all");
    expect(rows.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T5: Filter respects userId scoping (no leak across users)
// ---------------------------------------------------------------------------

describe("fetchNotificationCategoryCounts — scopes by userId (no cross-user leak)", () => {
  const EMAIL_A = "nbc-scope-a@dim-test.local";
  const EMAIL_B = "nbc-scope-b@dim-test.local";
  const PASS = "NbcScope_2026!";
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL_A);
    await ensureUserDeleted(EMAIL_B);
    userAId = await createUser(EMAIL_A, PASS);
    userBId = await createUser(EMAIL_B, PASS);
    await clearNotifications(userAId); // remove welcome notification from trigger
    await clearNotifications(userBId); // remove welcome notification from trigger
    // userA: 2 health; userB: 1 custody
    await insertNotification({ userId: userAId, category: "health" });
    await insertNotification({ userId: userAId, category: "health" });
    await insertNotification({ userId: userBId, category: "custody" });
  });

  afterAll(async () => {
    await cleanupUser(userAId);
    await cleanupUser(userBId);
  });

  it("userA counts do not include userB's notifications", async () => {
    const counts = await fetchNotificationCategoryCounts(userAId);
    expect(counts.all).toBe(2);
    expect(counts.health).toBe(2);
    expect(counts.custody).toBe(0);
  });

  it("userB counts do not include userA's notifications", async () => {
    const counts = await fetchNotificationCategoryCounts(userBId);
    expect(counts.all).toBe(1);
    expect(counts.custody).toBe(1);
    expect(counts.health).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T6: Filter respects archivedAt IS NULL
// ---------------------------------------------------------------------------

describe("fetchNotificationCategoryCounts — excludes archived notifications", () => {
  const EMAIL = "nbc-archived@dim-test.local";
  const PASS = "NbcArchived_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    await clearNotifications(userId); // remove welcome notification from trigger
    await insertNotification({ userId, category: "health" });
    await insertNotification({ userId, category: "health", archivedAt: new Date() });
    await insertNotification({ userId, category: "admin", archivedAt: new Date() });
  });

  afterAll(() => cleanupUser(userId));

  it("archived notifications are excluded from all counts", async () => {
    const counts = await fetchNotificationCategoryCounts(userId);
    expect(counts.all).toBe(1);
    expect(counts.health).toBe(1);
    expect(counts.admin).toBe(0);
  });

  it("filter 'all' does not return archived rows", async () => {
    const rows = await fetchNotificationsByCategory(userId, "all");
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.archivedAt === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T7: perdidas category — counts under 'perdidas' and 'all'; urgent sub-count
// ---------------------------------------------------------------------------

describe("fetchNotificationCategoryCounts — perdidas category", () => {
  const EMAIL = "nbc-perdidas@dim-test.local";
  const PASS = "NbcPerdidas_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    await clearNotifications(userId); // remove welcome notification from trigger
    // 2 perdidas urgent + 1 perdidas non-urgent + 1 health (control)
    await db.insert(notifications).values({
      userId,
      notificationType: "pet_found_report",
      title: "Avistaje 1",
      severity: "urgent",
      category: "perdidas",
    });
    await db.insert(notifications).values({
      userId,
      notificationType: "pet_found_report",
      title: "Avistaje 2",
      severity: "urgent",
      category: "perdidas",
    });
    await db.insert(notifications).values({
      userId,
      notificationType: "pet_found_report",
      title: "Avistaje 3",
      severity: "info",
      category: "perdidas",
    });
    await insertNotification({ userId, category: "health" });
  });

  afterAll(() => cleanupUser(userId));

  it("perdidas notifications count under perdidas and all", async () => {
    const counts = await fetchNotificationCategoryCounts(userId);
    expect(counts.all).toBe(4);
    expect(counts.perdidas).toBe(3);
    expect(counts.health).toBe(1);
    expect(counts.custody).toBe(0);
  });

  it("perdidasUrgent reflects only urgent severity rows", async () => {
    const counts = await fetchNotificationCategoryCounts(userId);
    expect(counts.perdidasUrgent).toBe(2);
  });

  it("filter perdidas returns only perdidas rows", async () => {
    const rows = await fetchNotificationsByCategory(userId, "perdidas");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.category === "perdidas")).toBe(true);
  });
});
