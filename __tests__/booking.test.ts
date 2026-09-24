// Integration tests for bookSlotWriter (Fase 4 — owner search + book).
//
// Tests:
//   1. Happy path — booking succeeds, bookings_count incremented.
//   2. Capacity full — returns "Sin cupo disponible.".
//   3. Slot in the past — returns "El turno ya pasó.".
//   4. Pet not owned by user — wrapper returns "Esta mascota no te pertenece.".
//   5. Deceased pet — wrapper refuses even though the tenencia is active.
//   6. Campaign-level identity guard (QA A3) — one confirmed appointment per
//      (pet, offering): same-slot dup, cross-slot dup, cancel→rebook, and the
//      0181 partial unique index as the race backstop.
//
// All DB rows are seeded + cleaned in beforeAll/afterAll.

import { createClient } from "@supabase/supabase-js";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// bookSlotAction derives the user from the auth guard and calls revalidatePath;
// neither has a Next.js runtime here. The guard is LAZY so it can read the
// fixture id assigned in beforeAll.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/infra/auth-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/auth-guards")>();
  return {
    ...actual,
    requireUserOrRedirect: vi.fn(async () => ({ user: { id: ownerUserId } })),
  };
});

import { bookSlotAction } from "@/app/actions/booking";
import {
  appointments,
  db,
  notifications,
  ownerships,
  pets,
  profiles,
  serviceOfferings,
  serviceScheduleRules,
  timeSlots,
} from "@/db";
import { matchesDbError } from "@/lib/infra/db-errors";
import {
  generateAppointmentToken,
  generateOfferingToken,
  generatePublicToken,
} from "@/lib/infra/publicToken";
import { bookSlotWriter } from "@/src/modules/events/application/booking/book-slot";
import { cancelAppointmentByOwner } from "@/src/modules/events/application/booking/cancel-appointment-by-owner";
import { materializeSlotsForOffering } from "@/src/modules/service-offerings/application/slot-materialization/materialize-slots";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "booking-owner@dim-test.local";
const OTHER_EMAIL = "booking-other@dim-test.local";
const PASS = "BookingTest_2026!";

let ownerUserId: string;
let otherUserId: string;
let petId: string;
let deceasedPetId: string;
let softDeletedPetId: string;
let offeringId: string;
let futureSlotId: string;
let fullSlotId: string;
let pastSlotId: string;
// The action-wrapper tests book petId AGAIN — they need their own offering,
// or the campaign-level guard (one confirmed per pet+offering, QA A3) would
// reject what is actually a legitimate booking in a different campaign.
let actionOfferingId: string;
let actionSlotId: string;

// Track inserted appointment public tokens for cleanup.
const insertedAppointmentTokens: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  for (const uid of ids) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(OTHER_EMAIL);

  // Create users.
  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const oth = await createFreshTestUser(supabase, {
    email: OTHER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (oth.error || !oth.data.user) throw new Error(`createUser other: ${oth.error?.message}`);
  otherUserId = oth.data.user.id;

  // Seed a pet owned by ownerUserId.
  const petToken = generatePublicToken();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: petToken,
      species: "dog",
      name: "Turno Test Dog",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "CABA",
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerUserId,
    role: "owner",
  });

  // A SECOND pet the same user still owns, whose lifecycle ended. Active
  // tenencia + deceased status is exactly the combination the action has to
  // refuse — the booking selector already hides it, but a stale tab or a
  // hand-posted petId never goes through the selector.
  const [deceasedPet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      species: "dog",
      name: "Turno Test Fallecido",
      status: "deceased",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "CABA",
    })
    .returning();
  deceasedPetId = deceasedPet.id;

  await db.insert(ownerships).values({
    petId: deceasedPetId,
    ownerUserId,
    role: "owner",
  });

  // A soft-deleted pet (Ley 25.326 art. 16 erasure sets pets.deleted_at) on
  // which the booking user still holds a SURVIVING active tenencia — role
  // 'foster' here, since the erasure ends neither a foster nor a co_owner row.
  // status stays 'active' on purpose so the deceased guard never fires: the ONLY
  // thing that must refuse this booking is the deleted_at term. This is the
  // write-twin of the read-side leak the reservar selector already closed — a
  // live third party (the foster booker) hand-POSTing a turno onto an erased
  // pet, whose ownerUserId would then be their own id.
  const [softDeletedPet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      species: "dog",
      name: "Turno Test Borrado",
      status: "active",
      deletedAt: new Date(),
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "CABA",
    })
    .returning();
  softDeletedPetId = softDeletedPet.id;

  await db.insert(ownerships).values({
    petId: softDeletedPetId,
    ownerUserId,
    role: "foster",
  });

  // Seed a service offering (status=approved is required by search but writer
  // doesn't check status — that's fine for unit-level isolation).
  const offeringToken = generateOfferingToken();
  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: offeringToken,
      providerUserId: otherUserId, // vet provider — satisfies XOR constraint
      serviceKind: "general_checkup",
      displayName: "Test offering",
      durationMinutes: 30,
      slotCapacity: 1,
      status: "approved",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "CABA",
    })
    .returning();
  offeringId = offering.id;

  // future slot (capacity=1, bookings_count=0).
  const [futureSlot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // +2 days
      endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 1,
      bookingsCount: 0,
      status: "open",
    })
    .returning();
  futureSlotId = futureSlot.id;

  // full slot (bookings_count === capacity).
  const [fullSlot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // +3 days
      endsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 1,
      bookingsCount: 1, // already full
      status: "open",
    })
    .returning();
  fullSlotId = fullSlot.id;

  // past slot.
  const [pastSlot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // -2 days
      endsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 1,
      bookingsCount: 0,
      status: "open",
    })
    .returning();
  pastSlotId = pastSlot.id;

  // Dedicated OFFERING + slot for the action-wrapper tests, so they never
  // race the writer-level ones over bookings_count — and so booking petId a
  // second time stays legitimate under the one-confirmed-per-(pet, offering)
  // guard (QA A3): different campaign, different regime.
  const [actionOffering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: generateOfferingToken(),
      providerUserId: otherUserId,
      serviceKind: "general_checkup",
      displayName: "Test offering (action wrapper)",
      durationMinutes: 30,
      slotCapacity: 1,
      status: "approved",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "CABA",
    })
    .returning();
  actionOfferingId = actionOffering.id;

  const [actionSlot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: actionOfferingId,
      startsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), // +4 days
      endsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 1,
      bookingsCount: 0,
      status: "open",
    })
    .returning();
  actionSlotId = actionSlot.id;
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Delete appointments created during tests.
  for (const token of insertedAppointmentTokens) {
    await db.delete(appointments).where(eq(appointments.publicToken, token));
  }

  // Delete slots, offerings, pet, ownerships, users.
  await db.delete(timeSlots).where(eq(timeSlots.serviceOfferingId, offeringId));
  await db.delete(serviceOfferings).where(eq(serviceOfferings.id, offeringId));
  await db.delete(timeSlots).where(eq(timeSlots.serviceOfferingId, actionOfferingId));
  await db.delete(serviceOfferings).where(eq(serviceOfferings.id, actionOfferingId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await db.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  await db.delete(ownerships).where(eq(ownerships.petId, deceasedPetId));
  await db.execute(sql`DELETE FROM pets WHERE id = ${deceasedPetId}`);
  await db.delete(ownerships).where(eq(ownerships.petId, softDeletedPetId));
  await db.execute(sql`DELETE FROM pets WHERE id = ${softDeletedPetId}`);

  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(OTHER_EMAIL);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bookSlotWriter", () => {
  it("happy path — inserts appointment and increments bookings_count", async () => {
    const result = await bookSlotWriter(futureSlotId, petId, ownerUserId);

    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) throw new Error("Expected ok result");

    insertedAppointmentTokens.push(result.appointmentToken);

    // Verify appointment was inserted.
    const [appt] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.publicToken, result.appointmentToken))
      .limit(1);

    expect(appt).toBeDefined();
    expect(appt!.slotId).toBe(futureSlotId);
    expect(appt!.petId).toBe(petId);
    expect(appt!.ownerUserId).toBe(ownerUserId);
    expect(appt!.status).toBe("confirmed");

    // Verify bookings_count was incremented.
    const [slot] = await db
      .select({ bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, futureSlotId))
      .limit(1);

    expect(slot!.bookingsCount).toBe(1);
  });

  it("capacity full — returns 'Sin cupo disponible.'", async () => {
    const result = await bookSlotWriter(fullSlotId, petId, ownerUserId);

    expect(result).toEqual({ error: "Sin cupo disponible." });
  });

  it("slot in the past — returns 'El turno ya pasó.'", async () => {
    const result = await bookSlotWriter(pastSlotId, petId, ownerUserId);

    expect(result).toEqual({ error: "El turno ya pasó." });
  });
});

// The action wrapper is where the AUTHORIZATION lives — the writer takes a
// caller-supplied userId and deliberately checks nothing (it is not exported
// from the "use server" module for that reason). Everything below is about the
// guard, not the booking mechanics.
describe("bookSlotAction — server-side guards", () => {
  it("refuses a pet the user does not own", async () => {
    const [strangerPet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        species: "cat",
        name: "Turno Test Ajeno",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "CABA",
      })
      .returning();

    try {
      const result = await bookSlotAction(actionSlotId, strangerPet.id);
      expect(result).toEqual({ error: "Esta mascota no te pertenece." });
    } finally {
      await db.execute(sql`DELETE FROM pets WHERE id = ${strangerPet.id}`);
    }
  });

  // The SELECTOR stopped offering deceased pets (Cowork QA v3, B2), but that
  // filter only shapes a fresh render. A tab opened before the death was
  // recorded, a Back-button return, or a hand-posted petId all arrive here with
  // an active tenencia over a pet that no longer has a lifecycle to schedule.
  it("refuses a deceased pet even though the tenencia is active", async () => {
    const result = await bookSlotAction(actionSlotId, deceasedPetId);

    expect(result).toEqual({
      error: "No se puede reservar un turno para una mascota fallecida.",
    });

    // Nothing was written: no appointment, and the slot is still empty.
    const [slot] = await db
      .select({ bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, actionSlotId))
      .limit(1);
    expect(slot!.bookingsCount).toBe(0);

    const booked = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.petId, deceasedPetId));
    expect(booked).toHaveLength(0);
  });

  // Art. 16 write-twin: a soft-deleted pet must read as NEVER REGISTERED even
  // on the WRITE path. The read-side reservar selector already hides it, but the
  // action is reachable directly, and it accepts ANY active tenencia role — the
  // foster row seeded above survives the erasure. Without the deleted_at term in
  // the ownership lookup, this booking SUCCEEDS (the bug); with it, the erased
  // pet folds into the SAME "no te pertenece" outcome a never-owned pet gets —
  // not a distinguishable error, so it cannot act as an existence oracle.
  it("refuses a soft-deleted (erased) pet even though an active tenencia survives", async () => {
    const result = await bookSlotAction(actionSlotId, softDeletedPetId);

    expect(result).toEqual({ error: "Esta mascota no te pertenece." });

    // Nothing was written: no appointment, and the slot is still empty.
    const [slot] = await db
      .select({ bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, actionSlotId))
      .limit(1);
    expect(slot!.bookingsCount).toBe(0);

    const booked = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.petId, softDeletedPetId));
    expect(booked).toHaveLength(0);
  });

  // Control: the guard refuses the deceased pet, not every pet. Without this
  // the test above would still pass if the join had silently emptied the query.
  it("still books for a live pet the user owns", async () => {
    const result = await bookSlotAction(actionSlotId, petId);

    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result) || !result.ok) throw new Error("Expected ok result");
    insertedAppointmentTokens.push(result.appointmentToken);
  });
});

// ---------------------------------------------------------------------------
// Campaign-level identity guard (QA A3, 2026-08-13) — one CONFIRMED
// appointment per (pet, offering). The per-slot guard (0177) let the same pet
// take the 08:00 AND the 08:15 of the SAME free campaign: N materialized
// slots, N eaten places. Self-contained fixtures: petId already holds live
// bookings in the offerings above, so this describe gets its own.
// ---------------------------------------------------------------------------

describe("bookSlotWriter — campaign-level identity guard (QA A3)", () => {
  let campaignOfferingId: string;
  let otherCampaignOfferingId: string;
  let slotAId: string; // "08:00" — capacity 2, so the per-slot duplicate reaches the identity guard
  let slotBId: string; // "08:15" — same campaign, different slot
  let otherCampaignSlotId: string;
  const localTokens: string[] = [];

  async function createCampaignOffering(displayName: string): Promise<string> {
    const [offering] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: generateOfferingToken(),
        providerUserId: otherUserId,
        serviceKind: "vaccination_rabies",
        displayName,
        durationMinutes: 15,
        slotCapacity: 2,
        status: "approved",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "CABA",
      })
      .returning({ id: serviceOfferings.id });
    return offering.id;
  }

  async function createCampaignSlot(offering: string, hourOffset: number): Promise<string> {
    const base = Date.now() + 6 * 24 * 60 * 60 * 1000;
    const [slot] = await db
      .insert(timeSlots)
      .values({
        serviceOfferingId: offering,
        startsAt: new Date(base + hourOffset * 60 * 60 * 1000),
        endsAt: new Date(base + hourOffset * 60 * 60 * 1000 + 15 * 60 * 1000),
        capacity: 2,
        bookingsCount: 0,
        status: "open",
      })
      .returning({ id: timeSlots.id });
    return slot.id;
  }

  beforeAll(async () => {
    campaignOfferingId = await createCampaignOffering("Campaña test (guard A3)");
    otherCampaignOfferingId = await createCampaignOffering("Otra campaña test (guard A3)");
    slotAId = await createCampaignSlot(campaignOfferingId, 0);
    slotBId = await createCampaignSlot(campaignOfferingId, 1);
    otherCampaignSlotId = await createCampaignSlot(otherCampaignOfferingId, 0);
  });

  afterAll(async () => {
    // Self-contained: appointments first (FK RESTRICT on time_slots), then
    // slots, then offerings.
    for (const token of localTokens) {
      await db.delete(appointments).where(eq(appointments.publicToken, token));
    }
    for (const oid of [campaignOfferingId, otherCampaignOfferingId]) {
      await db.delete(timeSlots).where(eq(timeSlots.serviceOfferingId, oid));
      await db.delete(serviceOfferings).where(eq(serviceOfferings.id, oid));
    }
  });

  it("books the first slot of the campaign (baseline)", async () => {
    const result = await bookSlotWriter(slotAId, petId, ownerUserId);
    expect(result).toMatchObject({ ok: true });
    if ("ok" in result) localTokens.push(result.appointmentToken);
  });

  it("same slot again — still the per-slot message (capacity permits, identity refuses)", async () => {
    const result = await bookSlotWriter(slotAId, petId, ownerUserId);
    expect(result).toEqual({ error: "Esta mascota ya tiene este turno reservado." });
  });

  it("DIFFERENT slot of the SAME campaign — rejected with the campaign message", async () => {
    const result = await bookSlotWriter(slotBId, petId, ownerUserId);
    expect(result).toEqual({ error: "Esta mascota ya tiene un turno reservado en esta campaña." });
  });

  it("a different campaign is unaffected", async () => {
    const result = await bookSlotWriter(otherCampaignSlotId, petId, ownerUserId);
    expect(result).toMatchObject({ ok: true });
    if ("ok" in result) localTokens.push(result.appointmentToken);
  });

  it("cancel → rebook another slot of the same campaign is allowed (partial index frees on cancel)", async () => {
    // Real owner-cancel use-case, not a raw UPDATE — proves the whole
    // cancel-then-rebook path the index must keep legitimate.
    const cancelResult = await cancelAppointmentByOwner(localTokens[0]!, ownerUserId);
    expect(cancelResult).toMatchObject({ ok: true });

    const rebook = await bookSlotWriter(slotBId, petId, ownerUserId);
    expect(rebook).toMatchObject({ ok: true });
    if ("ok" in rebook) localTokens.push(rebook.appointmentToken);
  });

  it("the DB partial unique index is VALID and enforcing (0181 rebuilt what 0177 left INVALID)", async () => {
    // Direct insert, bypassing the writer — the backstop must hold for ANY
    // writer (0177's motivation: two of the three duplicate pairs in staging
    // came from a seed, not the form). This also regression-proves the
    // CONCURRENTLY + IF NOT EXISTS trap: a failed create left 0177's index
    // sitting INVALID (existing but enforcing nothing) in local for days.
    const token = generateAppointmentToken();
    let thrown: unknown = null;
    try {
      await db.insert(appointments).values({
        publicToken: token,
        slotId: slotAId, // different slot than the live slotB booking…
        petId, // …same pet, same offering, status confirmed → must violate
        ownerUserId,
        serviceOfferingId: campaignOfferingId,
        status: "confirmed",
      });
      localTokens.push(token); // only reached on failure-to-throw — clean it up
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(
      matchesDbError(thrown, {
        code: "23505",
        constraint: /appointments_one_live_per_pet_offering/,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1-L16 — a slot whose schedule rule no longer stands is not bookable.
//
// Deleting a rule archives it (delete-schedule-rule.ts sets status='archived')
// and never touched the 60 days of slots already materialised from it; editing
// effective_until did not either. bookSlotWriter checked the slot, the window
// and the offering — never the rule. Slots here come from the REAL materialiser,
// so their rule_id / timezone are exactly what production writes.
// ---------------------------------------------------------------------------

describe("bookSlotWriter — the slot's schedule rule must still stand (T1-L16)", () => {
  const offeringIds: string[] = [];
  const localTokens: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  const TZ = "America/Argentina/Buenos_Aires";
  const arDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

  async function offeringWithRule(label: string): Promise<{ offeringId: string; ruleId: string }> {
    const [offering] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: generateOfferingToken(),
        providerUserId: otherUserId,
        serviceKind: "vaccination_rabies",
        displayName: `Agenda test L16 (${label})`,
        durationMinutes: 30,
        slotCapacity: 3,
        status: "approved",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "CABA",
      })
      .returning({ id: serviceOfferings.id });
    offeringIds.push(offering.id);
    const ruleId = await insertRule(offering.id);
    await materializeSlotsForOffering(offering.id);
    return { offeringId: offering.id, ruleId };
  }

  async function insertRule(offeringId: string): Promise<string> {
    const [rule] = await db
      .insert(serviceScheduleRules)
      .values({
        serviceOfferingId: offeringId,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        startTimeLocal: "10:00",
        endTimeLocal: "11:00",
        effectiveFrom: arDate(new Date()),
        effectiveUntil: null,
        timezone: TZ,
        status: "active",
      })
      .returning({ id: serviceScheduleRules.id });
    return rule.id;
  }

  /** The first materialised slot of the offering starting after `daysAhead`. */
  async function slotAfter(offeringId: string, daysAhead: number) {
    const [slot] = await db
      .select({
        id: timeSlots.id,
        ruleId: timeSlots.ruleId,
        startsAt: timeSlots.startsAt,
        bookingsCount: timeSlots.bookingsCount,
      })
      .from(timeSlots)
      .where(
        and(
          eq(timeSlots.serviceOfferingId, offeringId),
          gt(timeSlots.startsAt, new Date(Date.now() + daysAhead * DAY)),
        ),
      )
      .orderBy(asc(timeSlots.startsAt))
      .limit(1);
    if (!slot) throw new Error(`no materialised slot ${daysAhead} days ahead`);
    return slot;
  }

  afterAll(async () => {
    for (const token of localTokens) {
      await db.delete(appointments).where(eq(appointments.publicToken, token));
    }
    for (const oid of offeringIds) {
      await db.delete(timeSlots).where(eq(timeSlots.serviceOfferingId, oid));
      await db.delete(serviceScheduleRules).where(eq(serviceScheduleRules.serviceOfferingId, oid));
      await db.delete(serviceOfferings).where(eq(serviceOfferings.id, oid));
    }
  });

  it("deleting the rule makes its remaining slots unbookable and leaves the booked one intact", async () => {
    const { offeringId, ruleId } = await offeringWithRule("delete");
    const booked = await slotAfter(offeringId, 2);
    const stale = await slotAfter(offeringId, 5);
    expect(booked.ruleId).toBe(ruleId);
    expect(stale.ruleId).toBe(ruleId);

    const first = await bookSlotWriter(booked.id, petId, ownerUserId);
    expect(first).toMatchObject({ ok: true });
    if ("ok" in first) localTokens.push(first.appointmentToken);

    // The write deleteScheduleRuleForOrg performs.
    await db
      .update(serviceScheduleRules)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(serviceScheduleRules.id, ruleId));

    // A different pet, so no identity guard stands between this call and the
    // rule check: without it, this booking would succeed.
    const refused = await bookSlotWriter(stale.id, deceasedPetId, ownerUserId);
    expect(refused).toEqual({ error: "Este horario ya no está en la agenda del prestador." });
    const [staleAfter] = await db
      .select({ bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, stale.id));
    expect(staleAfter.bookingsCount).toBe(0);

    // The appointment booked before the delete is untouched.
    if (!("ok" in first)) throw new Error("baseline booking failed");
    const [kept] = await db
      .select({ status: appointments.status })
      .from(appointments)
      .where(eq(appointments.publicToken, first.appointmentToken));
    expect(kept.status).toBe("confirmed");
    const [bookedAfter] = await db
      .select({ bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, booked.id));
    expect(bookedAfter.bookingsCount).toBe(1);
  });

  it("moving effective_until before a slot's date makes that slot unbookable", async () => {
    const { offeringId, ruleId } = await offeringWithRule("until");
    const beyond = await slotAfter(offeringId, 5);

    await db
      .update(serviceScheduleRules)
      .set({ effectiveUntil: arDate(new Date(Date.now() + 2 * DAY)) })
      .where(eq(serviceScheduleRules.id, ruleId));

    const refused = await bookSlotWriter(beyond.id, deceasedPetId, ownerUserId);
    expect(refused).toEqual({ error: "Este horario ya no está en la agenda del prestador." });
  });

  it("a replacement rule for the same times adopts the stale slots, which book again", async () => {
    const { offeringId, ruleId } = await offeringWithRule("replace");
    const stale = await slotAfter(offeringId, 5);
    const [{ count: slotsBefore }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));

    await db
      .update(serviceScheduleRules)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(serviceScheduleRules.id, ruleId));
    const replacementId = await insertRule(offeringId);
    await materializeSlotsForOffering(offeringId);

    const [adopted] = await db
      .select({ ruleId: timeSlots.ruleId })
      .from(timeSlots)
      .where(eq(timeSlots.id, stale.id));
    expect(adopted.ruleId).toBe(replacementId);
    // Adopted, not duplicated.
    const [{ count: slotsAfter }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));
    expect(slotsAfter).toBe(slotsBefore);

    const booked = await bookSlotWriter(stale.id, deceasedPetId, ownerUserId);
    expect(booked).toMatchObject({ ok: true });
    if ("ok" in booked) localTokens.push(booked.appointmentToken);
  });
});
