// Integration tests for the pregnancy lifecycle (spec
// 2026-05-19-pregnancy-tracking-design §10).

import { createClient } from "@supabase/supabase-js";
import { and, eq, gt, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, pets, profiles, reminders } from "@/db";
import { matchCaptureIntent } from "@/lib/events/event-capture-matcher";
// Writers import from the application modules, not the "use server" shim
// (impersonation triage, review 07).
import { recordPregnancyEndedWriter } from "@/src/modules/pets/application/pregnancy/record-pregnancy-ended";
import {
  PREGNANCY_DURATION_DAYS,
  recordPregnancyStartedWriter,
} from "@/src/modules/pets/application/pregnancy/record-pregnancy-started";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "preg-owner@dim-test.local";
const PASS = "PregFlow_2026!";
let ownerUserId: string;
const insertedPetIds: string[] = [];

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  // Deleting profiles cascades to pet_events.recorded_by_user_id (ON DELETE
  // SET NULL), which triggers the append-only protection. Wrap so the
  // cascading UPDATE is allowed.
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

async function insertTestPet(
  ownerUid: string,
  suffix: string,
  opts: { sex: "female" | "male"; species: "dog" | "cat" | "rabbit" },
) {
  const token = `PREGTEST-${suffix}-${Date.now()}`;
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `PregPet${suffix}`,
      species: opts.species,
      sex: opts.sex,
      status: "active",
    })
    .returning();
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: ownerUid,
    role: "owner",
  });
  insertedPetIds.push(pet.id);
  return pet;
}

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(reminders).where(eq(reminders.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  await db.delete(notifications).where(eq(notifications.userId, ownerUserId));
  await purgeUserByEmail(OWNER_EMAIL);
});

const ownerAuthorship = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

describe("recordPregnancyStartedWriter — validation", () => {
  it("rejects male pet", async () => {
    const pet = await insertTestPet(ownerUserId, "MALE", { sex: "male", species: "dog" });
    const result = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("hembras");
  });

  // THIS TEST USED TO PASS `species: "rabbit"` AND EXPECT A REFUSAL, and the
  // inversion below is the change (PO decision 2026-09-07). The gestation table
  // held only dog, cat and `other`, so a pregnant rabbit could not be recorded
  // at all — and rabbit, guinea pig and ferret are all in this app's own species
  // catalogue and all gestate. The table now covers every member.
  //
  // WHICH LEAVES THE GUARD WITH NOTHING IN THE ENUM TO REFUSE, and that is why
  // the replacement is a fence rather than another refusal case. The guard is
  // kept because the failure it prevents is real and is about DRIFT: the day
  // somebody adds a species to `PET_SPECIES` without adding its gestation, this
  // writer would read `undefined` days and compute a birth date of `Invalid
  // Date`. The fence below fails at that moment instead, naming the missing
  // species — which is the review this pairing exists to force.
  it("every species in the catalogue has a gestation, so the table cannot drift behind it", async () => {
    const { PET_SPECIES } = await import("@dim/contract/input");
    const missing = PET_SPECIES.filter((s) => !Object.hasOwn(PREGNANCY_DURATION_DAYS, s));
    expect(missing).toEqual([]);
    // NON-VACUITY: a `PET_SPECIES` that was empty, or a table that answered yes
    // to everything, would make the line above trivially true.
    expect(PET_SPECIES.length).toBeGreaterThan(1);
    expect(Object.hasOwn(PREGNANCY_DURATION_DAYS, "no-es-una-especie")).toBe(false);
  });

  it("refuses a species the table does not know, rather than computing an Invalid Date", async () => {
    // NO DATABASE ROW HERE, and the reason is worth recording: the first attempt
    // at this test inserted a pet with `species: "axolotl"` and Postgres refused
    // it — `pets_species_valid`, a CHECK constraint on the column. So the enum is
    // defended TWICE, the database first and this writer second, and an unknown
    // species cannot reach here through any real row.
    //
    // That makes the guard unreachable in production and NOT dead code: it is
    // the arm that catches the day `PET_SPECIES` and the CHECK grow together and
    // the gestation table does not — the exact drift the fence above watches, at
    // the moment it would otherwise produce `undefined` days and an `Invalid
    // Date` birth prediction. The writer returns before it touches the database,
    // so a plain object is enough to exercise it, and using one is what lets the
    // case be tested at all.
    const pet = {
      id: "00000000-0000-4000-8000-000000000000",
      publicToken: "PREGTEST-UNKNOWN",
      species: "axolotl",
      sex: "female",
      pregnancyStatus: null,
    } as unknown as Parameters<typeof recordPregnancyStartedWriter>[0]["pet"];

    const result = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Especie");
  });

  it("rejects double-start on the same pet", async () => {
    const pet = await insertTestPet(ownerUserId, "DOUBLE", {
      sex: "female",
      species: "dog",
    });
    const first = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(first.ok).toBe(true);

    const [refreshed] = await db.select().from(pets).where(eq(pets.id, pet.id));
    const second = await recordPregnancyStartedWriter({
      pet: refreshed,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("ya tiene");
  });
});

describe("recordPregnancyStartedWriter — happy path + reminders", () => {
  it("flips pregnancyStatus + emits reminders biweekly", async () => {
    const pet = await insertTestPet(ownerUserId, "HAPPY", {
      sex: "female",
      species: "dog",
    });
    const occurredAt = new Date();
    const result = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt,
      weeksAtDiagnosis: 2,
      vetConsulted: "Dr. Test",
      notes: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [refreshed] = await db.select().from(pets).where(eq(pets.id, pet.id));
    expect(refreshed.pregnancyStatus).toBe("in_progress");

    // 9 weeks species duration - 2 at diagnosis = 7 weeks remaining.
    // Biweekly reminders → 3 reminders (week 2, 4, 6 after start).
    expect(result.reminderCount).toBe(3);
    const rems = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.petId, pet.id), eq(reminders.sourceEventId, result.eventId)));
    expect(rems.length).toBe(3);
    expect(rems.every((r) => r.completedAt === null)).toBe(true);
  });
});

describe("recordPregnancyEndedWriter — outcomes + reminder cancellation", () => {
  it("live_birth flips status to completed_live_birth + cancels future reminders + earns achievement A4", async () => {
    const pet = await insertTestPet(ownerUserId, "LIVE", {
      sex: "female",
      species: "dog",
    });

    const startedAt = new Date();
    const start = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: startedAt,
      weeksAtDiagnosis: 0,
      vetConsulted: null,
      notes: null,
    });
    expect(start.ok).toBe(true);

    const [refreshed] = await db.select().from(pets).where(eq(pets.id, pet.id));
    const end = await recordPregnancyEndedWriter({
      pet: refreshed,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      outcome: "live_birth",
      liveBirthsCount: 4,
      vetConsulted: null,
      notes: null,
    });
    expect(end.ok).toBe(true);

    const [closed] = await db.select().from(pets).where(eq(pets.id, pet.id));
    expect(closed.pregnancyStatus).toBe("completed_live_birth");

    // Future reminders (dueAt > now) get completedAt set.
    const pendingFuture = await db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.petId, pet.id),
          isNull(reminders.completedAt),
          gt(reminders.dueAt, new Date()),
        ),
      );
    expect(pendingFuture.length).toBe(0);
  });

  it("miscarriage flips status to completed_miscarriage", async () => {
    const pet = await insertTestPet(ownerUserId, "MISC", {
      sex: "female",
      species: "cat",
    });
    const start = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(start.ok).toBe(true);

    const [refreshed] = await db.select().from(pets).where(eq(pets.id, pet.id));
    const end = await recordPregnancyEndedWriter({
      pet: refreshed,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      outcome: "miscarriage",
      liveBirthsCount: null,
      vetConsulted: null,
      notes: null,
    });
    expect(end.ok).toBe(true);

    const [closed] = await db.select().from(pets).where(eq(pets.id, pet.id));
    expect(closed.pregnancyStatus).toBe("completed_miscarriage");
  });

  it("rejects close when no active pregnancy", async () => {
    const pet = await insertTestPet(ownerUserId, "NOSTART", {
      sex: "female",
      species: "dog",
    });
    const end = await recordPregnancyEndedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      outcome: "live_birth",
      liveBirthsCount: 3,
      vetConsulted: null,
      notes: null,
    });
    expect(end.ok).toBe(false);
    if (end.ok) return;
    expect(end.error).toContain("no tiene un embarazo activo");
  });
});

describe("captura rápida — pregnancy phrases", () => {
  it("'está embarazada' routes to /eventos/nuevo/embarazo?phase=started", () => {
    const m = matchCaptureIntent("Toto está embarazada");
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.eventType).toBe("clinical_info_logged");
    expect(m.routeOverride).toContain("phase=started");
  });

  it("'parió 5 cachorros' routes to phase=ended + outcome=live_birth + extracts count", () => {
    const m = matchCaptureIntent("Parió 5 cachorros hoy");
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.routeOverride).toContain("phase=ended");
    expect(m.routeOverride).toContain("outcome=live_birth");
    expect(m.slots.liveBirthsCount).toBe("5");
  });

  it("'perdió el embarazo' routes to phase=ended + outcome=miscarriage", () => {
    const m = matchCaptureIntent("perdió el embarazo la semana pasada");
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.routeOverride).toContain("phase=ended");
    expect(m.routeOverride).toContain("outcome=miscarriage");
  });
});
