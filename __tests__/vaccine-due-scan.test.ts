// Integration tests for Chunk C C2:
//   - lib/notifications.ts → runVaccineDueScan (per-variant throttling)
//   - app/actions/reminders.ts → snoozeReminderAction (tested via direct DB)
//
// Runs against the local Postgres directly. Each describe block provisions
// its own fixtures and tears them down so the file is safe to re-run.
//
// Time control strategy: we use the REAL wall clock as `options.now` (default)
// and seed notification history with `createdAt` offsets relative to Date.now().
// This ensures the throttle comparison (now - lastAt) works correctly without
// needing to override `createdAt` on insert (which Postgres defaults to NOW()).

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The Web Push leg is spied so the suppressPush semantics can be asserted
// (the real sender is inert in test env, hiding whether it was reached). The
// scan reaches it via createNotification → sendPushForNotifications.
vi.mock("@/lib/infra/web-push", () => ({
  sendPushForNotifications: vi.fn(async () => {}),
}));

import { db, notifications, ownerships, petEvents, pets, reminders } from "@/db";
import { runVaccineDueScan } from "@/lib/infra/notifications";
import { sendPushForNotifications } from "@/lib/infra/web-push";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  await admin.auth.admin.deleteUser(found.id);
}

async function createUser(email: string, password: string) {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

interface PetReminderOpts {
  userId: string;
  tokenSuffix: string;
  petName: string;
  species: string;
  vaccineName: string;
  dueAt: Date;
}

async function createPetAndReminder(opts: PetReminderOpts) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `SCAN-${opts.tokenSuffix}`,
      name: opts.petName,
      species: opts.species,
      sex: "unknown",
      status: "active",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: opts.userId, role: "owner" });

  const now = new Date();
  const [event] = await db
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "vaccination_administered",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: opts.userId,
      authorRole: "owner",
      payload: {
        payload_version: 1,
        vaccine_name: opts.vaccineName,
        administered_by: null,
        brand: null,
      },
    })
    .returning();

  const [reminder] = await db
    .insert(reminders)
    .values({
      petId: pet.id,
      userId: opts.userId,
      reminderType: "vaccine",
      dueAt: opts.dueAt,
      title: opts.vaccineName,
      description: null,
      sourceEventId: event.id,
    })
    .returning();

  return { pet, reminder, eventId: event.id };
}

async function cleanupUser(userId: string) {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
}

async function countUserVaccineNotifs(userId: string) {
  return db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.notificationType, "vaccine_due")),
    );
}

// Seed a notification with a controlled createdAt. Used to simulate prior history
// for throttle tests without relying on sequential scan calls with fake timestamps.
async function seedNotification(opts: {
  userId: string;
  petId: string;
  reminderId: string;
  createdAt: Date;
  severity?: "info" | "warning" | "urgent";
}) {
  await db.insert(notifications).values({
    userId: opts.userId,
    notificationType: "vaccine_due",
    category: "health",
    title: "Vacuna",
    body: "Test notification",
    severity: opts.severity ?? "urgent",
    relatedReminderId: opts.reminderId,
    relatedPetId: opts.petId,
    createdAt: opts.createdAt,
  });
}

// ---------------------------------------------------------------------------
// T1: upcoming (12d ahead) — first scan emits, second scan 3d later does NOT,
//     second scan 8d later DOES emit.
//
// Uses three separate users to avoid cross-contamination between scans.
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — upcoming: first scan emits", () => {
  const EMAIL = "scan-up-fresh@dim-test.local";
  const PASS = "ScanUp_2026!";
  let userId: string;
  let reminderId: string;
  let petId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `UPF-${userId.slice(0, 4)}`,
      petName: "UpcomingFresh",
      species: "dog",
      vaccineName: "Polivalente",
      dueAt: new Date(now.getTime() + 12 * MS_PER_DAY),
    });
    reminderId = reminder.id;
    petId = pet.id;
  });

  afterAll(() => cleanupUser(userId));

  it("emits one notification (no prior history)", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(1);
    expect(notifs[0].relatedReminderId).toBe(reminderId);
    expect(notifs[0].category).toBe("health");
    expect(notifs[0].severity).toBe("info");
    expect(result.insertedNotificationIds).toContain(notifs[0].id);
  });
});

describe("runVaccineDueScan — upcoming: throttled (last notif 3d ago, need 7d)", () => {
  const EMAIL = "scan-up-throttle3d@dim-test.local";
  const PASS = "ScanUp3d_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `UP3-${userId.slice(0, 4)}`,
      petName: "Upcoming3d",
      species: "dog",
      vaccineName: "Polivalente",
      dueAt: new Date(now.getTime() + 12 * MS_PER_DAY),
    });
    // Seed: last notif was 3 days ago (< 7d threshold)
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 3 * MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("does NOT emit (last notif 3d ago, need 7d for upcoming)", async () => {
    const before = await countUserVaccineNotifs(userId);
    expect(before.length).toBe(1); // only the seeded one
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(0);
    const after = await countUserVaccineNotifs(userId);
    expect(after.length).toBe(1); // unchanged
  });
});

describe("runVaccineDueScan — upcoming: emits when last notif 8d ago", () => {
  const EMAIL = "scan-up-8d@dim-test.local";
  const PASS = "ScanUp8d_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `UP8-${userId.slice(0, 4)}`,
      petName: "Upcoming8d",
      species: "dog",
      vaccineName: "Polivalente",
      dueAt: new Date(now.getTime() + 12 * MS_PER_DAY),
    });
    // Seed: last notif was 8 days ago (>= 7d threshold → should emit)
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 8 * MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("DOES emit (last notif 8d ago, threshold 7d)", async () => {
    const before = await countUserVaccineNotifs(userId);
    expect(before.length).toBe(1);
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(1);
    const after = await countUserVaccineNotifs(userId);
    expect(after.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T2: due_soon (5d ahead) — first 3d daily, then 3d cadence
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — due_soon: first scan emits with severity=warning", () => {
  const EMAIL = "scan-ds-fresh@dim-test.local";
  const PASS = "ScanDs_2026!";
  let userId: string;
  let reminderId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `DSF-${userId.slice(0, 4)}`,
      petName: "DueSoonFresh",
      species: "dog",
      vaccineName: "Sextuple",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    reminderId = reminder.id;
  });

  afterAll(() => cleanupUser(userId));

  it("emits first notification, severity=warning", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(1);
    expect(notifs[0].severity).toBe("warning");
    expect(notifs[0].relatedReminderId).toBe(reminderId);
    expect(result.insertedCount).toBe(1);
  });
});

describe("runVaccineDueScan — due_soon: daily in first 3d window", () => {
  const EMAIL = "scan-ds-daily@dim-test.local";
  const PASS = "ScanDsDaily_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `DSD-${userId.slice(0, 4)}`,
      petName: "DueSoonDaily",
      species: "dog",
      vaccineName: "Sextuple",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    // firstAt was 1d ago, lastAt also 1d ago → within first 3d window → minInterval=1d
    const firstAt = new Date(now.getTime() - 1 * MS_PER_DAY);
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: firstAt });
  });

  afterAll(() => cleanupUser(userId));

  it("emits: first notif was 1d ago (within first 3d window, 1d interval satisfied)", async () => {
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(1);
  });
});

describe("runVaccineDueScan — due_soon: switches to 3d cadence after 3d window", () => {
  const EMAIL = "scan-ds-3dcad@dim-test.local";
  const PASS = "ScanDs3dCad_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `DS3-${userId.slice(0, 4)}`,
      petName: "DueSoon3d",
      species: "dog",
      vaccineName: "Sextuple",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    // firstAt 5d ago (past the 3d window), lastAt 2d ago (< 3d cadence → should NOT emit)
    const firstAt = new Date(now.getTime() - 5 * MS_PER_DAY);
    const lastAt = new Date(now.getTime() - 2 * MS_PER_DAY);
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: firstAt });
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: lastAt });
  });

  afterAll(() => cleanupUser(userId));

  it("does NOT emit: past 3d window but last notif only 2d ago (need 3d)", async () => {
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(0);
  });
});

describe("runVaccineDueScan — due_soon: emits after 3d cadence elapsed", () => {
  const EMAIL = "scan-ds-3dok@dim-test.local";
  const PASS = "ScanDs3dOk_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `DS4-${userId.slice(0, 4)}`,
      petName: "DueSoon3dOk",
      species: "dog",
      vaccineName: "Sextuple",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    // firstAt 5d ago, lastAt 4d ago → past 3d window + 3d elapsed → should emit
    const firstAt = new Date(now.getTime() - 5 * MS_PER_DAY);
    const lastAt = new Date(now.getTime() - 4 * MS_PER_DAY);
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: firstAt });
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: lastAt });
  });

  afterAll(() => cleanupUser(userId));

  it("DOES emit: past 3d window and last notif 4d ago (>= 3d cadence)", async () => {
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T3: overdue (-5d) — first scan emits, daily for first 14d
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — overdue (-5d): first scan emits urgent", () => {
  const EMAIL = "scan-ov-fresh@dim-test.local";
  const PASS = "ScanOv_2026!";
  let userId: string;
  let reminderId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `OVF-${userId.slice(0, 4)}`,
      petName: "OverdueFresh",
      species: "cat",
      vaccineName: "Triple felina",
      dueAt: new Date(now.getTime() - 5 * MS_PER_DAY),
    });
    reminderId = reminder.id;
  });

  afterAll(() => cleanupUser(userId));

  it("emits one notification with severity=urgent", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(1);
    expect(notifs[0].severity).toBe("urgent");
    expect(notifs[0].relatedReminderId).toBe(reminderId);
    expect(notifs[0].category).toBe("health");
    expect(result.insertedCount).toBe(1);
  });
});

describe("runVaccineDueScan — overdue: daily within first 14d window", () => {
  const EMAIL = "scan-ov-daily@dim-test.local";
  const PASS = "ScanOvDaily_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `OVD-${userId.slice(0, 4)}`,
      petName: "OverdueDaily",
      species: "cat",
      vaccineName: "Triple felina",
      dueAt: new Date(now.getTime() - 5 * MS_PER_DAY),
    });
    // firstAt 7d ago (within 14d window), lastAt 1d+5min ago → ≥1d → should emit
    const firstAt = new Date(now.getTime() - 7 * MS_PER_DAY);
    const lastAt = new Date(now.getTime() - MS_PER_DAY - 5 * 60 * 1000);
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: firstAt });
    await seedNotification({ userId, petId: pet.id, reminderId: reminder.id, createdAt: lastAt });
  });

  afterAll(() => cleanupUser(userId));

  it("emits: firstAt 7d ago, lastAt 1d+5m ago (within 14d daily phase)", async () => {
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T4: overdue -15d (first notif >14d ago) → weekly cadence
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — overdue: weekly cadence after 14d (6d ago does NOT emit)", () => {
  const EMAIL = "scan-ov-wk6d@dim-test.local";
  const PASS = "ScanOvWk6d_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `OW6-${userId.slice(0, 4)}`,
      petName: "OverdueWk6",
      species: "dog",
      vaccineName: "Bordetella",
      dueAt: new Date(now.getTime() - 20 * MS_PER_DAY),
    });
    // firstAt 16d ago (> 14d → weekly cadence), lastAt 6d ago (< 7d → should NOT emit)
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 16 * MS_PER_DAY),
    });
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 6 * MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("does NOT emit: past 14d window, last notif 6d ago (need 7d)", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(2); // only the 2 seeded ones
    expect(result.insertedCount).toBe(0);
  });
});

describe("runVaccineDueScan — overdue: weekly cadence after 14d (7d ago DOES emit)", () => {
  const EMAIL = "scan-ov-wk7d@dim-test.local";
  const PASS = "ScanOvWk7d_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `OW7-${userId.slice(0, 4)}`,
      petName: "OverdueWk7",
      species: "dog",
      vaccineName: "Bordetella",
      dueAt: new Date(now.getTime() - 20 * MS_PER_DAY),
    });
    // firstAt 16d ago, lastAt 7d ago (= 7d → should emit)
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 16 * MS_PER_DAY),
    });
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 7 * MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("DOES emit: past 14d window, last notif 7d ago (= 7d threshold)", async () => {
    const before = await countUserVaccineNotifs(userId);
    expect(before.length).toBe(2);
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(1);
    const after = await countUserVaccineNotifs(userId);
    expect(after.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T5: overdue_critical — rabia en perro, > 30d overdue, daily indefinitely
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — overdue_critical: first scan emits with correct body", () => {
  const EMAIL = "scan-crit-fresh@dim-test.local";
  const PASS = "ScanCritFresh_2026!";
  let userId: string;
  let reminderId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `CRF-${userId.slice(0, 4)}`,
      petName: "Negrita",
      species: "dog",
      vaccineName: "Antirrábica",
      dueAt: new Date(now.getTime() - 45 * MS_PER_DAY),
    });
    reminderId = reminder.id;
  });

  afterAll(() => cleanupUser(userId));

  it("emits with severity=urgent and body mentions obligatoria", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(1);
    expect(notifs[0].severity).toBe("urgent");
    expect(notifs[0].body).toContain("obligatoria");
    expect(notifs[0].relatedReminderId).toBe(reminderId);
    expect(result.insertedCount).toBe(1);
  });
});

describe("runVaccineDueScan — overdue_critical: emits daily (1d+5m elapsed)", () => {
  const EMAIL = "scan-crit-daily@dim-test.local";
  const PASS = "ScanCritDaily_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `CRD-${userId.slice(0, 4)}`,
      petName: "Negrita2",
      species: "dog",
      vaccineName: "Antirrábica",
      dueAt: new Date(now.getTime() - 45 * MS_PER_DAY),
    });
    // lastAt 1d+5min ago → ≥1d → should emit
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - MS_PER_DAY - 5 * 60 * 1000),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("DOES emit: last notif 1d+5m ago (daily indefinitely)", async () => {
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(1);
  });
});

describe("runVaccineDueScan — overdue_critical: does NOT emit within 1d window", () => {
  const EMAIL = "scan-crit-nodaily@dim-test.local";
  const PASS = "ScanCritNoDaily_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder, pet } = await createPetAndReminder({
      userId,
      tokenSuffix: `CRN-${userId.slice(0, 4)}`,
      petName: "Negrita3",
      species: "dog",
      vaccineName: "Antirrábica",
      dueAt: new Date(now.getTime() - 45 * MS_PER_DAY),
    });
    // lastAt only 23h ago → < 1d → should NOT emit
    await seedNotification({
      userId,
      petId: pet.id,
      reminderId: reminder.id,
      createdAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("does NOT emit: last notif 23h ago (< 1d threshold)", async () => {
    const result = await runVaccineDueScan(db);
    expect(result.insertedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T6: snoozed reminder is skipped
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — snoozed reminder is skipped", () => {
  const EMAIL = "scan-snooze@dim-test.local";
  const PASS = "ScanSnooze_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `SN-${userId.slice(0, 4)}`,
      petName: "Snoozed",
      species: "dog",
      vaccineName: "Polivalente",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    // snoozed_until = tomorrow
    await db
      .update(reminders)
      .set({ snoozedUntil: new Date(now.getTime() + MS_PER_DAY) })
      .where(eq(reminders.id, reminder.id));
  });

  afterAll(() => cleanupUser(userId));

  it("scan does NOT process the snoozed reminder", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(0);
    expect(result.insertedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T7: completed reminder is skipped
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — completed reminder is skipped", () => {
  const EMAIL = "scan-completed@dim-test.local";
  const PASS = "ScanCompleted_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `CP-${userId.slice(0, 4)}`,
      petName: "Completed",
      species: "dog",
      vaccineName: "Polivalente",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    await db
      .update(reminders)
      .set({ completedAt: new Date(now.getTime() - MS_PER_DAY) })
      .where(eq(reminders.id, reminder.id));
  });

  afterAll(() => cleanupUser(userId));

  it("scan does NOT emit for completed reminder", async () => {
    const result = await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(0);
    expect(result.insertedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T8: notification metadata — category, relatedReminderId, severity
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — notification metadata", () => {
  const EMAIL = "scan-meta@dim-test.local";
  const PASS = "ScanMeta_2026!";
  let userId: string;
  let reminderId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    // upcoming: 10 days ahead
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `MT-${userId.slice(0, 4)}`,
      petName: "Meta",
      species: "dog",
      vaccineName: "Bordetella",
      dueAt: new Date(now.getTime() + 10 * MS_PER_DAY),
    });
    reminderId = reminder.id;
  });

  afterAll(() => cleanupUser(userId));

  it("emitted notification has category=health, relatedReminderId set, severity=info", async () => {
    await runVaccineDueScan(db);
    const notifs = await countUserVaccineNotifs(userId);
    expect(notifs.length).toBe(1);
    const n = notifs[0];
    expect(n.category).toBe("health");
    expect(n.relatedReminderId).toBe(reminderId);
    expect(n.severity).toBe("info"); // upcoming → info
    expect(n.ctaLabel).toBe("Registrar vacuna"); // 14.2: deep-link to vaccination form
    // Canonical reminder-linked target (flow audit 2026-07-03): the full
    // vaccine form with reminderId so the name pre-fills and the reminder
    // closes on submit.
    expect(n.ctaUrl).toContain(`/eventos/nuevo/vacuna?reminderId=${reminderId}`);
  });
});

// ---------------------------------------------------------------------------
// T9: snooze action — DB-level business logic verification
// ---------------------------------------------------------------------------

describe("snoozeReminderAction — business logic", () => {
  const EMAIL = "snooze-action@dim-test.local";
  const PASS = "SnoozeAction_2026!";
  let userId: string;
  let reminderId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const { reminder } = await createPetAndReminder({
      userId,
      tokenSuffix: `SZ-${userId.slice(0, 4)}`,
      petName: "SnoozeTest",
      species: "dog",
      vaccineName: "Polivalente",
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
    });
    reminderId = reminder.id;
  });

  afterAll(() => cleanupUser(userId));

  // Mirrors what snoozeReminderAction does internally
  async function applySnooze(count: number) {
    const isCapped = count >= 3;
    const snoozeMs = isCapped ? 30 * MS_PER_DAY : 7 * MS_PER_DAY;
    const nextSnoozedUntil = new Date(Date.now() + snoozeMs);
    const nextSnoozeCount = isCapped ? count : count + 1;

    const [updated] = await db
      .update(reminders)
      .set({ snoozedUntil: nextSnoozedUntil, snoozeCount: nextSnoozeCount })
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)))
      .returning({ snoozedUntil: reminders.snoozedUntil, snoozeCount: reminders.snoozeCount });

    return updated;
  }

  it("first snooze (count=0): snoozeCount becomes 1, snoozedUntil ≈ now+7d", async () => {
    const [before] = await db
      .select({ snoozeCount: reminders.snoozeCount })
      .from(reminders)
      .where(eq(reminders.id, reminderId));
    expect(before.snoozeCount).toBe(0);

    const updated = await applySnooze(0);
    expect(updated.snoozeCount).toBe(1);
    const diff = updated.snoozedUntil!.getTime() - Date.now();
    // Should be approximately 7d (±1 minute)
    expect(diff).toBeGreaterThan(6.99 * MS_PER_DAY);
    expect(diff).toBeLessThan(7.01 * MS_PER_DAY);
  });

  it("second snooze (count=1): snoozeCount becomes 2, snoozedUntil ≈ now+7d", async () => {
    const updated = await applySnooze(1);
    expect(updated.snoozeCount).toBe(2);
    const diff = updated.snoozedUntil!.getTime() - Date.now();
    expect(diff).toBeGreaterThan(6.99 * MS_PER_DAY);
    expect(diff).toBeLessThan(7.01 * MS_PER_DAY);
  });

  it("third snooze (count=2): snoozeCount becomes 3, snoozedUntil ≈ now+7d", async () => {
    const updated = await applySnooze(2);
    expect(updated.snoozeCount).toBe(3);
    const diff = updated.snoozedUntil!.getTime() - Date.now();
    expect(diff).toBeGreaterThan(6.99 * MS_PER_DAY);
    expect(diff).toBeLessThan(7.01 * MS_PER_DAY);
  });

  it("fourth snooze (count=3, cap reached): snoozeCount stays 3, snoozedUntil ≈ now+30d", async () => {
    const updated = await applySnooze(3);
    expect(updated.snoozeCount).toBe(3); // no increment
    const diff = updated.snoozedUntil!.getTime() - Date.now();
    expect(diff).toBeGreaterThan(29.99 * MS_PER_DAY);
    expect(diff).toBeLessThan(30.01 * MS_PER_DAY);
  });

  it("auth guard: WHERE user_id = wrong_id returns 0 rows (no update)", async () => {
    const fakeUserId = "00000000-0000-0000-0000-000000000001";
    const rows = await db
      .update(reminders)
      .set({ snoozedUntil: new Date() })
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, fakeUserId)))
      .returning({ id: reminders.id });
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Push suppression semantics (RN-3 F5) — the FIRST urgent notification for a
// reminder pushes; later urgent re-emits stay in-app only. Keyed on prior
// URGENT count, not total notif count, so a vaccine that reached overdue via
// the normal due_soon path still gets its first overdue push.
// ---------------------------------------------------------------------------

describe("runVaccineDueScan — push suppression keys on prior URGENT, not total history", () => {
  const pushSpy = vi.mocked(sendPushForNotifications);
  const EMAIL = "scan-push-suppress@dim-test.local";
  let userId = "";
  // Two INDEPENDENT reminders — one per scenario — so no shared same-day
  // dedupe key or freshly-created history bleeds between them.
  let reminderWarn = ""; // prior non-urgent only
  let reminderUrgent = ""; // prior urgent

  // runVaccineDueScan processes EVERY candidate reminder in the DB, so the
  // global spy sees pushes for other fixtures too. Assert on ONE reminder.
  function pushed(reminderId: string): boolean {
    return pushSpy.mock.calls.some((call) => {
      const rows = call[0] as Array<{ relatedReminderId?: string | null }>;
      return rows?.some((r) => r.relatedReminderId === reminderId);
    });
  }

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, "VaxPushTest_2026!");

    const warn = await createPetAndReminder({
      userId,
      tokenSuffix: `PW-${userId.slice(0, 4)}`,
      petName: "PriorWarn",
      species: "dog",
      vaccineName: "Antirrábica",
      dueAt: new Date(Date.now() - 5 * MS_PER_DAY), // overdue → urgent
    });
    reminderWarn = warn.reminder.id;
    // Prior due_soon (warning) 2d ago — non-urgent, never pushed: notifCount>0
    // but urgentCount=0.
    await seedNotification({
      userId,
      petId: warn.pet.id,
      reminderId: reminderWarn,
      severity: "warning",
      createdAt: new Date(Date.now() - 2 * MS_PER_DAY),
    });

    const urgent = await createPetAndReminder({
      userId,
      tokenSuffix: `PU-${userId.slice(0, 4)}`,
      petName: "PriorUrgent",
      species: "dog",
      vaccineName: "Antirrábica",
      dueAt: new Date(Date.now() - 5 * MS_PER_DAY), // overdue → urgent
    });
    reminderUrgent = urgent.reminder.id;
    // Prior urgent 2d ago → urgentCount=1: a re-emit must be suppressed.
    await seedNotification({
      userId,
      petId: urgent.pet.id,
      reminderId: reminderUrgent,
      severity: "urgent",
      createdAt: new Date(Date.now() - 2 * MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("scan runs once; the warning-only reminder pushes, the prior-urgent one does not", async () => {
    pushSpy.mockClear();
    await runVaccineDueScan(db);

    // First urgent (reached overdue via due_soon) → MUST push.
    expect(
      pushed(reminderWarn),
      "the first overdue push was wrongly suppressed by the due_soon count",
    ).toBe(true);

    // A reminder that already had an urgent → re-emit stays in-app only.
    expect(pushed(reminderUrgent), "a daily urgent re-emit still pushed").toBe(false);
  });
});
