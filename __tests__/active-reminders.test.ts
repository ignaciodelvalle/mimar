// Integration tests for Chunk C C3 query helpers:
//   - fetchActiveReminders (lib/owner-dashboard.ts)
//   - fetchActiveRemindersForPet (lib/owner-dashboard.ts)
//
// EXTENDED (owner-surface parity WU) to cover the two capabilities that
// closed `write:createVaccineReminderAction→createVaccineReminder` and
// `write:deleteVaccineReminderAction→deleteVaccineReminder` in
// `scripts/check-owner-surface-parity.ts`: `deleteVaccineReminder`'s own
// `changed` flag (T10-T12) and `POST /api/v1/pets/{token}/reminders` end to
// end (T13+) — real DB, real access resolution, only the bearer/liveness
// layer mocked, the same reason this file already provisions real Supabase
// users rather than a fake session.
//
// Runs against the local Postgres directly. Each describe block provisions
// its own fixtures and tears them down in afterAll.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, ownerships, pets, reminders } from "@/db";
import { fetchActiveReminders, fetchActiveRemindersForPet } from "@/lib/analytics/owner-dashboard";
import { deleteVaccineReminder } from "@/src/modules/pets/application/reminders/delete-vaccine-reminder";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Route-level mocks (T13+ only). Real DB, real `resolvePetHolderAccess`, real
// use-cases — only the bearer parse and the liveness round-trip are stubbed,
// so a real fixture user id can stand in for a real session without a real
// GoTrue token.
// ---------------------------------------------------------------------------

const routeControl = vi.hoisted(() => ({
  userId: null as string | null,
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => ({
      ok: true,
      supabase: {},
      user: { id: routeControl.userId },
      profile: null,
    }),
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: async () => {} };
});

// The WEB door's guard (T12b only). `requireOwnedPetByToken` resolves a cookie
// session and redirects/404s on refusal; here it hands the action a fixture
// (user, pet) pair — or `null`, to reach the wrapper's own "Sesión expirada."
// arm, which the real guard never returns through. The use-case underneath is
// real, against the real DB.
const webControl = vi.hoisted(() => ({
  session: null as { userId: string; petId: string } | null,
}));

vi.mock("@/lib/infra/pets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pets")>();
  return {
    ...actual,
    requireOwnedPetByToken: async () =>
      webControl.session === null
        ? null
        : {
            user: { id: webControl.session.userId },
            pet: { id: webControl.session.petId },
            accessPath: "person",
            organization: null,
          },
  };
});

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

async function createUser(email: string, password: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

async function createPetForUser(userId: string, tokenSuffix: string, species = "dog") {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `AR-${tokenSuffix}`,
      name: `Pet_${tokenSuffix}`,
      species,
      sex: "unknown",
      status: "active",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: userId, role: "owner" });
  return pet;
}

async function insertReminder(opts: {
  petId: string;
  userId: string;
  dueAt: Date;
  title: string;
  completedAt?: Date | null;
  snoozedUntil?: Date | null;
}) {
  const [rem] = await db
    .insert(reminders)
    .values({
      petId: opts.petId,
      userId: opts.userId,
      reminderType: "vaccine",
      dueAt: opts.dueAt,
      title: opts.title,
      completedAt: opts.completedAt ?? null,
      snoozedUntil: opts.snoozedUntil ?? null,
    })
    .returning();
  return rem;
}

async function cleanupUser(userId: string) {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
}

// ---------------------------------------------------------------------------
// T1: excludes reminders with completedAt IS NOT NULL
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — excludes completed reminders", () => {
  const EMAIL = "ar-completed@dim-test.local";
  const PASS = "ArCompleted_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `CPL-${userId.slice(0, 4)}`);
    const now = new Date();
    // active reminder — should be returned
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Polivalente",
    });
    // completed reminder — should be excluded
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 3 * MS_PER_DAY),
      title: "Antirrábica",
      completedAt: new Date(now.getTime() - MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("returns only the non-completed reminder", async () => {
    const results = await fetchActiveReminders(userId);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Polivalente");
  });
});

// ---------------------------------------------------------------------------
// T2: excludes reminders with snoozedUntil > now
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — excludes snoozed reminders", () => {
  const EMAIL = "ar-snoozed@dim-test.local";
  const PASS = "ArSnoozed_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `SN-${userId.slice(0, 4)}`);
    const now = new Date();
    // active reminder
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Polivalente",
    });
    // snoozed reminder (snoozedUntil is tomorrow → should be excluded)
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 4 * MS_PER_DAY),
      title: "Sextuple",
      snoozedUntil: new Date(now.getTime() + MS_PER_DAY),
    });
  });

  afterAll(() => cleanupUser(userId));

  it("returns only the non-snoozed reminder", async () => {
    const results = await fetchActiveReminders(userId);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Polivalente");
  });
});

// ---------------------------------------------------------------------------
// T3: COUNT-ALL — no future cap (decision D4)
//
// Before fix: reminders with dueAt > now+14d were excluded by a windowEnd cap,
// making the dashboard KPI count diverge from the per-pet drilldown list.
// After fix: all non-completed, non-snoozed reminders are returned regardless
// of how far ahead their dueAt falls. Reminders beyond 7 days get variant
// "upcoming" but are still counted and shown.
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — returns reminders beyond 14d (COUNT-ALL, D4)", () => {
  const EMAIL = "ar-window@dim-test.local";
  const PASS = "ArWindow_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `WN-${userId.slice(0, 4)}`);
    const now = new Date();
    // 13 days ahead — previously "within" the 14d cap
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 13 * MS_PER_DAY),
      title: "Polivalente",
    });
    // 15 days ahead — previously excluded by the 14d cap, now included
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 15 * MS_PER_DAY),
      title: "Sextuple",
    });
  });

  afterAll(() => cleanupUser(userId));

  it("returns both reminders (no window cap)", async () => {
    const results = await fetchActiveReminders(userId);
    expect(results.length).toBe(2);
    const titles = results.map((r) => r.title);
    expect(titles).toContain("Polivalente");
    expect(titles).toContain("Sextuple");
  });

  it("both reminders beyond 7d get variant 'upcoming'", async () => {
    const results = await fetchActiveReminders(userId);
    for (const r of results) {
      expect(r.variant).toBe("upcoming");
    }
  });
});

// ---------------------------------------------------------------------------
// T4: orders results overdue_critical → overdue → due_soon → upcoming
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — orders by variant priority then dueAt", () => {
  const EMAIL = "ar-order@dim-test.local";
  const PASS = "ArOrder_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `ORD-${userId.slice(0, 4)}`, "dog");
    const now = new Date();
    // upcoming (12d ahead)
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 12 * MS_PER_DAY),
      title: "Sextuple",
    });
    // overdue_critical (Antirrábica dog, 45d overdue → > 30d overdue + reportable)
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() - 45 * MS_PER_DAY),
      title: "Antirrábica",
    });
    // due_soon (4d ahead)
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 4 * MS_PER_DAY),
      title: "Polivalente",
    });
    // overdue (8d overdue, non-reportable)
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() - 8 * MS_PER_DAY),
      title: "Bordetella",
    });
  });

  afterAll(() => cleanupUser(userId));

  it("returns results ordered: overdue_critical, overdue, due_soon, upcoming", async () => {
    const results = await fetchActiveReminders(userId);
    expect(results.length).toBe(4);
    expect(results[0].variant).toBe("overdue_critical");
    expect(results[1].variant).toBe("overdue");
    expect(results[2].variant).toBe("due_soon");
    expect(results[3].variant).toBe("upcoming");
  });
});

// ---------------------------------------------------------------------------
// T5: scopes by userId — does not leak other owner's reminders
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — scopes by userId", () => {
  const EMAIL_A = "ar-scope-a@dim-test.local";
  const EMAIL_B = "ar-scope-b@dim-test.local";
  const PASS = "ArScope_2026!";
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL_A);
    await ensureUserDeleted(EMAIL_B);
    userAId = await createUser(EMAIL_A, PASS);
    userBId = await createUser(EMAIL_B, PASS);
    const now = new Date();
    const petA = await createPetForUser(userAId, `SCA-${userAId.slice(0, 4)}`);
    const petB = await createPetForUser(userBId, `SCB-${userBId.slice(0, 4)}`);
    await insertReminder({
      petId: petA.id,
      userId: userAId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Polivalente",
    });
    await insertReminder({
      petId: petB.id,
      userId: userBId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Triple felina",
    });
  });

  afterAll(async () => {
    await cleanupUser(userAId);
    await cleanupUser(userBId);
  });

  it("userA only sees their own reminder", async () => {
    const results = await fetchActiveReminders(userAId);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Polivalente");
  });

  it("userB only sees their own reminder", async () => {
    const results = await fetchActiveReminders(userBId);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Triple felina");
  });
});

// ---------------------------------------------------------------------------
// T6: correctly computes variant via getReminderVariant
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — computes variant correctly", () => {
  const EMAIL = "ar-variant@dim-test.local";
  const PASS = "ArVariant_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `VAR-${userId.slice(0, 4)}`);
    const now = new Date();
    // 10d ahead → upcoming
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 10 * MS_PER_DAY),
      title: "Sextuple",
    });
    // 5d ahead → due_soon
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Polivalente",
    });
    // 10d overdue → overdue (non-reportable)
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() - 10 * MS_PER_DAY),
      title: "Bordetella",
    });
  });

  afterAll(() => cleanupUser(userId));

  it("assigns correct variant to each reminder", async () => {
    const results = await fetchActiveReminders(userId);
    const byTitle = Object.fromEntries(results.map((r) => [r.title, r.variant]));
    expect(byTitle.Sextuple).toBe("upcoming");
    expect(byTitle.Polivalente).toBe("due_soon");
    expect(byTitle.Bordetella).toBe("overdue");
  });
});

// ---------------------------------------------------------------------------
// T7: correctly computes isReportable for a reportable vaccine
// ---------------------------------------------------------------------------

describe("fetchActiveReminders — isReportable for Antirrábica on dog", () => {
  const EMAIL = "ar-reportable@dim-test.local";
  const PASS = "ArReport_2026!";
  let userId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `RPT-${userId.slice(0, 4)}`, "dog");
    const now = new Date();
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() - 45 * MS_PER_DAY),
      title: "Antirrábica",
    });
    // non-reportable for comparison
    await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(now.getTime() - 10 * MS_PER_DAY),
      title: "Bordetella",
    });
  });

  afterAll(() => cleanupUser(userId));

  it("Antirrábica dog is reportable; Bordetella dog is not", async () => {
    const results = await fetchActiveReminders(userId);
    const antirr = results.find((r) => r.title === "Antirrábica");
    const bord = results.find((r) => r.title === "Bordetella");
    expect(antirr?.isReportable).toBe(true);
    expect(antirr?.variant).toBe("overdue_critical");
    expect(bord?.isReportable).toBe(false);
    expect(bord?.variant).toBe("overdue");
  });
});

// ---------------------------------------------------------------------------
// T8: fetchActiveRemindersForPet scopes by petId AND userId
// ---------------------------------------------------------------------------

describe("fetchActiveRemindersForPet — scopes by petId", () => {
  const EMAIL = "ar-perpet@dim-test.local";
  const PASS = "ArPerPet_2026!";
  let userId: string;
  let petAId: string;
  let petBId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const now = new Date();
    const petA = await createPetForUser(userId, `PPA-${userId.slice(0, 4)}`);
    const petB = await createPetForUser(userId, `PPB-${userId.slice(0, 4)}`);
    petAId = petA.id;
    petBId = petB.id;
    await insertReminder({
      petId: petA.id,
      userId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Polivalente",
    });
    await insertReminder({
      petId: petB.id,
      userId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Triple felina",
    });
  });

  afterAll(() => cleanupUser(userId));

  it("returns only petA's reminder when queried for petA", async () => {
    const results = await fetchActiveRemindersForPet(userId, petAId);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Polivalente");
    expect(results[0].petId).toBe(petAId);
  });

  it("returns only petB's reminder when queried for petB", async () => {
    const results = await fetchActiveRemindersForPet(userId, petBId);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Triple felina");
    expect(results[0].petId).toBe(petBId);
  });
});

// ---------------------------------------------------------------------------
// T9: fetchActiveRemindersForPet returns [] when user is not the owner
// ---------------------------------------------------------------------------

describe("fetchActiveRemindersForPet — returns [] for non-owner user", () => {
  const EMAIL_OWNER = "ar-nonowner-own@dim-test.local";
  const EMAIL_OTHER = "ar-nonowner-oth@dim-test.local";
  const PASS = "ArNonOwner_2026!";
  let ownerId: string;
  let otherId: string;
  let petId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL_OWNER);
    await ensureUserDeleted(EMAIL_OTHER);
    ownerId = await createUser(EMAIL_OWNER, PASS);
    otherId = await createUser(EMAIL_OTHER, PASS);
    const now = new Date();
    const pet = await createPetForUser(ownerId, `NON-${ownerId.slice(0, 4)}`);
    petId = pet.id;
    // The reminder is tied to ownerId (reminder.user_id = owner). The other user
    // has no ownership and is not the reminder's user_id.
    await insertReminder({
      petId: pet.id,
      userId: ownerId,
      dueAt: new Date(now.getTime() + 5 * MS_PER_DAY),
      title: "Polivalente",
    });
  });

  afterAll(async () => {
    await cleanupUser(ownerId);
    await cleanupUser(otherId);
  });

  it("owner sees the reminder", async () => {
    const results = await fetchActiveRemindersForPet(ownerId, petId);
    expect(results.length).toBe(1);
  });

  it("other user sees nothing (userId filter)", async () => {
    const results = await fetchActiveRemindersForPet(otherId, petId);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T10-T12: deleteVaccineReminder — the use-case behind
// write:deleteVaccineReminderAction→deleteVaccineReminder
// ---------------------------------------------------------------------------

describe("deleteVaccineReminder — cancels a reminder and reports what happened", () => {
  const EMAIL = "ar-delete@dim-test.local";
  const PASS = "ArDelete_2026!";
  let userId: string;
  let petId: string;
  let otherPetId: string;

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    const pet = await createPetForUser(userId, `DEL-${userId.slice(0, 4)}`);
    const otherPet = await createPetForUser(userId, `DEO-${userId.slice(0, 4)}`);
    petId = pet.id;
    otherPetId = otherPet.id;
  });

  afterAll(() => cleanupUser(userId));

  it("deletes a matching reminder and reports changed: true", async () => {
    const rem = await insertReminder({
      petId,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Antirrábica",
    });

    const result = await deleteVaccineReminder(petId, rem.id);
    expect(result).toEqual({ changed: true });

    const rows = await db.select().from(reminders).where(eq(reminders.id, rem.id));
    expect(rows.length).toBe(0);
  });

  it("a REPLAYED cancel (already gone) reports changed: false — never an error", async () => {
    const rem = await insertReminder({
      petId,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Sextuple",
    });

    const first = await deleteVaccineReminder(petId, rem.id);
    expect(first).toEqual({ changed: true });

    // MUTATION APPLIED: throw instead of returning `{ changed: false }` when
    // nothing matched. Red. A replayed cancel — a retried request, or a
    // second tap after the first landed — must answer the SAME way as the
    // first: a success, never "there is no reminder to cancel".
    const second = await deleteVaccineReminder(petId, rem.id);
    expect(second).toEqual({ changed: false });
  });

  it("a reminder id that never matched this pet reports changed: false and deletes nothing", async () => {
    const rem = await insertReminder({
      petId: otherPetId,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Bordetella",
    });

    // MUTATION APPLIED: drop the `petId` clause from the delete's WHERE. Red —
    // and the failure it prevents is one pet's cancel button deleting a
    // reminder that belongs to a DIFFERENT one of the same owner's animals.
    const result = await deleteVaccineReminder(petId, rem.id);
    expect(result).toEqual({ changed: false });

    const rows = await db.select().from(reminders).where(eq(reminders.id, rem.id));
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T12b: deleteVaccineReminderAction — the web door, nav contract N3
// ---------------------------------------------------------------------------
// The action used to call redirect() after the delete, which Next 15.5.x's App
// Router can DROP (scripts/check-action-redirect.ts): the row was gone and the
// person watched nothing happen. It now RETURNS `redirectTo` and the island
// (`DeleteReminderInlineForm`) navigates. What these pin is the return shape
// the island depends on — a use-case test cannot see the wrapper.

describe("deleteVaccineReminderAction — returns redirectTo instead of calling redirect()", () => {
  const EMAIL = "ar-delete-action@dim-test.local";
  const PASS = "ArDeleteAction_2026!";
  let userId: string;
  let pet: { id: string; publicToken: string };

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    pet = await createPetForUser(userId, `DLA-${userId.slice(0, 4)}`);
  });

  afterAll(async () => {
    webControl.session = null;
    await cleanupUser(userId);
  });

  async function act(publicToken: string, reminderId: string) {
    const { deleteVaccineReminderAction } = await import("@/app/actions/reminders");
    return deleteVaccineReminderAction(publicToken, reminderId, { error: null }, new FormData());
  }

  it("deletes the row and RETURNS the pet page as redirectTo — no redirect() thrown", async () => {
    webControl.session = { userId, petId: pet.id };
    const rem = await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Antirrábica",
    });

    // A redirect() here would REJECT with NEXT_REDIRECT; the island's
    // useActionState would never see a state to navigate on.
    const state = await act(pet.publicToken, rem.id);
    expect(state).toEqual({ error: null, redirectTo: `/mis-mascotas/${pet.publicToken}` });

    const rows = await db.select().from(reminders).where(eq(reminders.id, rem.id));
    expect(rows.length).toBe(0);
  });

  it("a REPLAYED cancel through the action is the same success, not an error", async () => {
    webControl.session = { userId, petId: pet.id };
    const rem = await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Sextuple",
    });

    await act(pet.publicToken, rem.id);
    const second = await act(pet.publicToken, rem.id);
    expect(second).toEqual({ error: null, redirectTo: `/mis-mascotas/${pet.publicToken}` });
  });

  it("with no session it answers the form-state error and deletes nothing", async () => {
    webControl.session = { userId, petId: pet.id };
    const rem = await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Bordetella",
    });

    webControl.session = null;
    const state = await act(pet.publicToken, rem.id);
    expect(state).toEqual({ error: "Sesión expirada." });

    const rows = await db.select().from(reminders).where(eq(reminders.id, rem.id));
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T13+: POST /api/v1/pets/{publicToken}/reminders — the bearer door
// ---------------------------------------------------------------------------

describe("POST /pets/{token}/reminders — create_vaccine_reminder", () => {
  const EMAIL = "ar-route-create@dim-test.local";
  const PASS = "ArRouteCreate_2026!";
  let userId: string;
  let pet: { id: string; publicToken: string };

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    userId = await createUser(EMAIL, PASS);
    pet = await createPetForUser(userId, `RTC-${userId.slice(0, 4)}`);
    routeControl.userId = userId;
  });

  afterAll(() => cleanupUser(userId));

  async function post(publicToken: string, body: unknown) {
    const { POST } = await import("@/app/api/v1/pets/[publicToken]/reminders/route");
    return POST(
      new Request(`https://x.test/api/v1/pets/${publicToken}/reminders`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ publicToken }) },
    );
  }

  it("creates a reminder and answers 200 with its reminderId", async () => {
    const res = await post(pet.publicToken, {
      command: "create_vaccine_reminder",
      vaccineName: "Antirrábica",
      dueAt: "2026-11-01",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string; reminderId: string };
    expect(body.command).toBe("create_vaccine_reminder");
    expect(typeof body.reminderId).toBe("string");

    const rows = await db.select().from(reminders).where(eq(reminders.id, body.reminderId));
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("Antirrábica");
  });

  it("a replayed create (same vaccine + due date) answers with the SAME reminderId", async () => {
    const input = {
      command: "create_vaccine_reminder" as const,
      vaccineName: "Polivalente",
      dueAt: "2026-12-01",
    };
    const first = (await (await post(pet.publicToken, input)).json()) as { reminderId: string };
    const second = (await (await post(pet.publicToken, input)).json()) as { reminderId: string };
    expect(second.reminderId).toBe(first.reminderId);

    const rows = await db.select().from(reminders).where(eq(reminders.title, "Polivalente"));
    expect(rows.length).toBe(1);
  });

  it("answers 400 invalid_request for a missing vaccineName", async () => {
    const res = await post(pet.publicToken, {
      command: "create_vaccine_reminder",
      dueAt: "2026-11-01",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("answers 400 invalid_request for a calendar day that does not exist", async () => {
    // 2026-02-31 rolls over to 3 March instead of throwing — isRealArDay is
    // the backstop this contract adds over a plain regex.
    const res = await post(pet.publicToken, {
      command: "create_vaccine_reminder",
      vaccineName: "Antirrábica",
      dueAt: "2026-02-31",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

describe("POST /pets/{token}/reminders — cancel_vaccine_reminder", () => {
  const EMAIL = "ar-route-cancel@dim-test.local";
  const PASS = "ArRouteCancel_2026!";
  let userId: string;
  let otherUserId: string;
  let pet: { id: string; publicToken: string };

  beforeAll(async () => {
    await ensureUserDeleted(EMAIL);
    await ensureUserDeleted("ar-route-cancel-other@dim-test.local");
    userId = await createUser(EMAIL, PASS);
    otherUserId = await createUser("ar-route-cancel-other@dim-test.local", PASS);
    pet = await createPetForUser(userId, `RTX-${userId.slice(0, 4)}`);
  });

  afterAll(async () => {
    await cleanupUser(userId);
    await cleanupUser(otherUserId);
  });

  async function post(publicToken: string, body: unknown) {
    const { POST } = await import("@/app/api/v1/pets/[publicToken]/reminders/route");
    return POST(
      new Request(`https://x.test/api/v1/pets/${publicToken}/reminders`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ publicToken }) },
    );
  }

  it("cancels a reminder and answers changed: true", async () => {
    routeControl.userId = userId;
    const rem = await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Sextuple",
    });

    const res = await post(pet.publicToken, {
      command: "cancel_vaccine_reminder",
      reminderId: rem.id,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      command: "cancel_vaccine_reminder",
      reminderId: rem.id,
      changed: true,
    });
  });

  it("a REPLAYED cancel answers 200 changed: false — not a 404", async () => {
    routeControl.userId = userId;
    const rem = await insertReminder({
      petId: pet.id,
      userId,
      dueAt: new Date(Date.now() + 5 * MS_PER_DAY),
      title: "Bordetella",
    });

    const body = { command: "cancel_vaccine_reminder" as const, reminderId: rem.id };
    const first = await post(pet.publicToken, body);
    expect(first.status).toBe(200);

    // THE ASSERTION THIS TEST EXISTS FOR: a retried cancel of a reminder that
    // was already cancelled must answer the SAME way as the first attempt —
    // 200, changed: false — and never "there is no reminder to cancel".
    const second = await post(pet.publicToken, body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      command: "cancel_vaccine_reminder",
      reminderId: rem.id,
      changed: false,
    });
  });

  it("answers 404 not_found for a token this caller may not see", async () => {
    // A stranger's pet — resolvePetHolderAccess answers `{ kind: "none" }` for
    // this caller, and this door must not be an oracle for which tokens exist.
    const strangerPet = await createPetForUser(otherUserId, `RTS-${otherUserId.slice(0, 4)}`);
    routeControl.userId = userId;
    const res = await post(strangerPet.publicToken, {
      command: "cancel_vaccine_reminder",
      reminderId: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
