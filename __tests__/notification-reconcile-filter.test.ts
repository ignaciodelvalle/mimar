// Integration test: the read-time reconcile filter suppresses a lost-active
// notification once the subject pet is no longer lost, while keeping unrelated
// notifications and the lost-episode recovery notice.
//
// Runs against local Postgres via Drizzle. Provisions its own user + pet and
// tears them down in afterAll.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, pets } from "@/db";
import {
  countUnreadNotifications,
  fetchNotificationCategoryCounts,
  fetchUnreadNotificationCount,
} from "@/lib/analytics/owner-dashboard";
import {
  excludeResolvedLostEpisodeSql,
  excludeStaleWelcomeSql,
} from "@/lib/infra/notification-reconcile";
import { getUnreadCountCached } from "@/lib/infra/request-cache";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const EMAIL = "notif-reconcile@dim-test.local";
const PASS = "NotifReconcile_2026!";

let userId: string;
let petId: string;

async function ensureUserDeleted(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await db.delete(notifications).where(eq(notifications.userId, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await ensureUserDeleted(EMAIL);
  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `RECON-${userId.slice(0, 6).toUpperCase()}`,
      name: "Panchita",
      species: "dog",
      sex: "female",
      status: "lost",
    })
    .returning();
  petId = pet.id;
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: userId, role: "owner" });

  // Clear the welcome notification inserted by the handle_new_user trigger.
  await db.delete(notifications).where(eq(notifications.userId, userId));

  // A lost-active sighting alert (should reconcile away once found).
  await db.insert(notifications).values({
    userId,
    notificationType: "pet_found_report",
    title: "Avistaje de Panchita",
    severity: "urgent",
    category: "perdidas",
    relatedPetId: petId,
  });
  // A recovery notice (must always persist).
  await db.insert(notifications).values({
    userId,
    notificationType: "lost_episode_resolved_owner",
    title: "Marcaste a Panchita como encontrada",
    severity: "success",
    category: "perdidas",
    relatedPetId: petId,
  });
  // An unrelated health notification (never touched by the filter).
  await db.insert(notifications).values({
    userId,
    notificationType: "vaccine_due",
    title: "Vacuna próxima",
    severity: "info",
    category: "health",
    relatedPetId: petId,
  });
  // A welcome notification for a user who OWNS a pet — must be reconciled
  // away by excludeStaleWelcomeSql (tester fix #8), so every count below
  // stays as if this row did not exist.
  await db.insert(notifications).values({
    userId,
    notificationType: "welcome",
    title: "¡Hola! Bienvenido a MiMAR",
    severity: "info",
  });
});

afterAll(async () => {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await admin.auth.admin.deleteUser(userId);
});

describe("notification reconcile filter", () => {
  it("counts the sighting alert while the pet is still lost (stale welcome already hidden)", async () => {
    const counts = await fetchNotificationCategoryCounts(userId);
    expect(counts.perdidas).toBe(2); // sighting + recovery
    expect(counts.health).toBe(1);
    // 3, not 4 — the seeded 'welcome' row is reconciled away because this
    // user has an active owner tenure (tester fix #8).
    expect(counts.all).toBe(3);
    expect(await countUnreadNotifications(userId)).toBe(3);
    expect(await fetchUnreadNotificationCount(userId, "perdidas")).toBe(2);
    // Badge/page parity (sweep-fixes-2 2026-07-23 root cause): the masthead
    // bell badge (getUnreadCountCached) must reconcile the same way as the
    // /notificaciones page's unread count, or an owner sees "badge says N,
    // page shows fewer". Before the fix this returned 4 (raw unread count,
    // no reconciliation) instead of 3.
    expect(await getUnreadCountCached(userId)).toBe(3);
  });

  it("suppresses the sighting alert once the pet is marked found (status → active)", async () => {
    await db.update(pets).set({ status: "active" }).where(eq(pets.id, petId));

    const counts = await fetchNotificationCategoryCounts(userId);
    // Sighting reconciled away; the recovery notice stays.
    expect(counts.perdidas).toBe(1);
    expect(counts.perdidasUrgent).toBe(0);
    expect(counts.health).toBe(1);
    expect(counts.all).toBe(2);
    expect(await countUnreadNotifications(userId)).toBe(2);
    expect(await fetchUnreadNotificationCount(userId, "perdidas")).toBe(1);
    expect(await getUnreadCountCached(userId)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Stale-welcome reconcile — the KEEP branch (tester fix #8)
// ---------------------------------------------------------------------------
//
// A user with NO pets must still see their welcome notification (the trigger
// inserts it on signup): the filter only hides it once a pet is registered.

describe("stale-welcome reconcile — user without pets keeps the welcome", () => {
  const EMAIL_NO_PETS = "notif-reconcile-nopets@dim-test.local";
  let noPetsUserId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL_NO_PETS);
    const { data, error } = await createFreshTestUser(admin, {
      email: EMAIL_NO_PETS,
      password: "NotifReconcileNoPets_2026!",
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    noPetsUserId = data.user.id;
    // Deterministic fixture: drop whatever the trigger inserted, seed exactly
    // one welcome row.
    await db.delete(notifications).where(eq(notifications.userId, noPetsUserId));
    await db.insert(notifications).values({
      userId: noPetsUserId,
      notificationType: "welcome",
      title: "¡Hola! Bienvenido a MiMAR",
      severity: "info",
    });
  });

  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.userId, noPetsUserId));
    await admin.auth.admin.deleteUser(noPetsUserId);
  });

  it("keeps the welcome visible while the user owns no pet", async () => {
    const counts = await fetchNotificationCategoryCounts(noPetsUserId);
    expect(counts.all).toBe(1);
    expect(await countUnreadNotifications(noPetsUserId)).toBe(1);
    expect(await getUnreadCountCached(noPetsUserId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NULL-category row — must render under "all" and count consistently
// (sweep-fixes-2 2026-07-23, owner-notifications badge item 1a)
// ---------------------------------------------------------------------------
//
// A category-less notification (e.g. the handle_new_user trigger's `welcome`
// row before migration 0157, or any future direct-insert call site that
// forgets `category`) must never disappear from the /notificaciones "all"
// tab: fetchNotificationCategoryCounts folds it into `all`, and the page's
// "all" WHERE clause (no `eq(category, ...)` predicate) must still return it.
// This test drives the page's OWN query shape directly — same table, same
// reconcile fragments, same "no category filter on all" contract — so a
// future change to either side that breaks parity fails here first.

describe("NULL-category notification — renders under 'all' and counts agree", () => {
  const EMAIL_NULL_CAT = "notif-null-category@dim-test.local";
  let nullCatUserId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL_NULL_CAT);
    const { data, error } = await createFreshTestUser(admin, {
      email: EMAIL_NULL_CAT,
      password: "NotifNullCategory_2026!",
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    nullCatUserId = data.user.id;
    // Deterministic fixture: drop whatever the trigger inserted, seed exactly
    // one unread, non-archived, NULL-category notification of a type that is
    // NOT reconciled away by either filter (so this isolates the category
    // question from the reconcile-filter behavior already covered above).
    await db.delete(notifications).where(eq(notifications.userId, nullCatUserId));
    await db.insert(notifications).values({
      userId: nullCatUserId,
      notificationType: "first_stranger_scan",
      title: "Alguien escaneó la credencial de Firulais por primera vez",
      severity: "info",
      category: null,
    });
  });

  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.userId, nullCatUserId));
    await admin.auth.admin.deleteUser(nullCatUserId);
  });

  it("counts toward 'all' and the badge, and appears in the page's all-tab row set", async () => {
    const counts = await fetchNotificationCategoryCounts(nullCatUserId);
    expect(counts.all).toBe(1);
    expect(await countUnreadNotifications(nullCatUserId)).toBe(1);
    expect(await fetchUnreadNotificationCount(nullCatUserId)).toBe(1);
    expect(await getUnreadCountCached(nullCatUserId)).toBe(1);

    // The /notificaciones page's "all" tab applies no category predicate at
    // all (app/(app)/notificaciones/page.tsx: `activeCat !== "all" ? eq(...) :
    // undefined`) — reproduced here so a NULL-category row's presence in the
    // actual row list is asserted, not just its count.
    const rows = await db
      .select({ id: notifications.id, category: notifications.category })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, nullCatUserId),
          isNull(notifications.archivedAt),
          excludeResolvedLostEpisodeSql,
          excludeStaleWelcomeSql,
        ),
      )
      .orderBy(desc(notifications.createdAt));

    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBeNull();
  });
});
