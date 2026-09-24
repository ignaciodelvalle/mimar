// Integration test for lib/notifications.ts → runVaccineDueScan.
//
// Runs against the local Postgres directly. Each test provisions its own
// fixture (user via Supabase admin, pet, vaccination event, reminder) and
// tears it down at the end so the file is safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, petEvents, pets, reminders } from "@/db";
import { type VaccineDueScanResult, runVaccineDueScan } from "@/lib/infra/notifications";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL = "vaccine-cron-test@dim-test.local";
const PASS = "VaccineCronTest_2026!";

let userId: string;
let petId: string;
let eventId: string;
let reminderId: string;

async function provisionFixture() {
  // Make sure no prior leftover exists.
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
    // Pet cascade hits the append-only trigger on pet_events; wrap the
    // teardown delete in a tx with the session-local escape hatch set.
    await withMutationOverride(async (tx) => {
      for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
    });
    await admin.auth.admin.deleteUser(found.id);
  }
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
      publicToken: `VACCRON-${userId.slice(0, 6).toUpperCase()}`,
      name: "Lila",
      species: "dog",
      sex: "female",
      status: "active",
    })
    .returning();
  petId = pet.id;
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: userId, role: "owner" });

  // Originating vaccination event (matches the shape createVaccinationAction
  // would write).
  const now = new Date();
  const [event] = await db
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "vaccination_administered",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId,
      authorRole: "owner",
      payload: { vaccine_name: "Antirrábica", administered_by: null, brand: null },
    })
    .returning();
  eventId = event.id;

  // Reminder due in 3 days, linked to the originating event.
  const threeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const [reminder] = await db
    .insert(reminders)
    .values({
      petId: pet.id,
      userId,
      reminderType: "vaccine",
      dueAt: threeDays,
      title: "Refuerzo: Antirrábica",
      description: `Próxima dosis programada para ${pet.name}.`,
      sourceEventId: event.id,
    })
    .returning();
  reminderId = reminder.id;
}

async function teardownFixture() {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  // See provisionFixture cleanup note: cascade hits the append-only trigger.
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
}

// The scan is GLOBAL — it sweeps every vaccine reminder in the shared local
// DB, including QA seed data (e.g. seed pets with live reminders whose
// cadence windows open/close relative to the wall clock). Asserting the raw
// global insertedCount made this file flake whenever a seed reminder crossed
// into a daily-cadence variant at the shifted scan time (2026-07-04 gate
// failure #1). Scope every insertion assertion to THIS fixture's user.
async function insertedForFixtureUser(result: VaccineDueScanResult): Promise<number> {
  if (result.insertedNotificationIds.length === 0) return 0;
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, result.insertedNotificationIds),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  await provisionFixture();
});

afterAll(async () => {
  await teardownFixture();
});

describe("runVaccineDueScan", () => {
  it("inserts exactly one notification on the first tick for a reminder due in 3 days", async () => {
    const first = await runVaccineDueScan();
    expect(await insertedForFixtureUser(first)).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.notificationType, "vaccine_due")),
      );
    expect(rows.length).toBe(1);
    const n = rows[0];
    expect(n.notificationType).toBe("vaccine_due");
    expect(n.severity).toBe("warning");
    // relatedEventId must be NULL on cron-emitted notifications: migration
    // 0088's unique index (user_id, related_event_id, notification_type)
    // exempts NULL rows so the escalating cadence can re-emit for the same
    // source event. Setting it made the 2nd scan crash with 23505
    // (projection-cron audit 2026-07-03 C1).
    expect(n.relatedEventId).toBeNull();
    expect(n.relatedReminderId).toBe(reminderId);
    expect(n.relatedPetId).toBe(petId);
    expect(n.ctaLabel).toBe("Registrar vacuna"); // 14.2: deep-link to vaccination form
    // Canonical reminder-linked target (flow audit 2026-07-03): the full
    // vaccine form with reminderId so the name pre-fills and the reminder
    // closes on submit.
    expect(n.ctaUrl).toContain("/eventos/nuevo/vacuna?reminderId=");
    // Body should be the time-aware computed message ("Lila tiene una vacuna
    // programada en 3 días."), NOT the generic reminder description. The
    // computed message reflects the scan moment; the description is
    // creation-time and would be stale.
    expect(n.body).toContain("Lila");
    expect(n.body).toMatch(/3 días|mañana|hoy/);
  });

  it("does NOT duplicate when the cron runs again", async () => {
    const second = await runVaccineDueScan();
    expect(await insertedForFixtureUser(second)).toBe(0);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.notificationType, "vaccine_due")),
      );
    expect(rows.length).toBe(1);
  });

  it("emits AGAIN when the cadence window reopens (2nd scan, same source event)", async () => {
    // The regression test migration 0088 demanded and nobody wrote: due_soon
    // throttles daily for the first 3 days, so a scan one day later MUST
    // insert a second notification for the SAME reminder + source event.
    // Before the C1 fix this insert violated the (user_id, related_event_id,
    // notification_type) unique index and 23505'd the whole run.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000 + 60 * 1000);
    const reEmit = await runVaccineDueScan(db, { now: tomorrow });
    expect(await insertedForFixtureUser(reEmit)).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.notificationType, "vaccine_due")),
      );
    expect(rows.length).toBe(2);
    // Every cron emission stays exempt from the 0088 natural key.
    for (const n of rows) {
      expect(n.relatedEventId).toBeNull();
    }
  });

  it("archiving a notification does NOT reset the throttle cadence", async () => {
    // Archive everything emitted so far, then scan at (real) NOW — moments
    // after the last emission, inside the throttle window. Archiving
    // dismisses from the inbox; it is not consent to full-frequency
    // re-notification (projection-cron audit 2026-07-03 C2). Under the old
    // `archived_at IS NULL` history filter this scan saw notif_count=0 and
    // emitted immediately.
    await db
      .update(notifications)
      .set({ archivedAt: new Date() })
      .where(
        and(eq(notifications.userId, userId), eq(notifications.notificationType, "vaccine_due")),
      );

    const afterArchive = await runVaccineDueScan();
    expect(await insertedForFixtureUser(afterArchive)).toBe(0);
  });

  it("stops emitting once the reminder is marked completed_at", async () => {
    await db.update(reminders).set({ completedAt: new Date() }).where(eq(reminders.id, reminderId));

    const third = await runVaccineDueScan();
    expect(await insertedForFixtureUser(third)).toBe(0);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.notificationType, "vaccine_due")),
      );
    expect(rows.length).toBe(2);
  });
});
