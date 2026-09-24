// Race condition integration test for bookSlotWriter (Fase 4).
//
// Fires two concurrent bookings against a capacity-1 slot via Promise.all.
// Exactly one should succeed (ok: true) and the other should return the
// "Sin cupo disponible." error. The advisory lock + DB CHECK constraint
// must guarantee this — neither booking can silently overbook.
//
// This test exercises D10 from the spec:
//   Advisory lock → re-read capacity → insert → increment
//   DB CHECK (bookings_count <= capacity) is the final safety net.

import { createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appointments,
  db,
  notifications,
  ownerships,
  pets,
  profiles,
  serviceOfferings,
  timeSlots,
} from "@/db";
import { generateOfferingToken, generatePublicToken } from "@/lib/infra/publicToken";
import { bookSlotWriter } from "@/src/modules/events/application/booking/book-slot";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER_A_EMAIL = "race-owner-a@dim-test.local";
const OWNER_B_EMAIL = "race-owner-b@dim-test.local";
const PROVIDER_EMAIL = "race-provider@dim-test.local";
const PASS = "RaceTest_2026!";
// Named constants because beforeAll pre-cleans by name (see the note there).
const PET_A_NAME = "Race Dog A";
const PET_B_NAME = "Race Cat B";

let ownerAUserId: string;
let ownerBUserId: string;
let providerUserId: string;

let petAId: string;
let petBId: string;
let offeringId: string;
let raceSlotId: string;

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
  await purgeUserByEmail(OWNER_A_EMAIL);
  await purgeUserByEmail(OWNER_B_EMAIL);
  await purgeUserByEmail(PROVIDER_EMAIL);

  // Pre-clean the PET rows too, not just the users. These fixtures insert
  // straight into `pets` with no pet_registered event — deliberate, this tests
  // the booking writer and not registration — which means a run that dies
  // before afterAll leaves behind exactly the shape invariant #3 forbids: a
  // cache row with no spine event. `pnpm lint:spine` then fails for everyone on
  // that database until someone hand-deletes the rows (it did, 2026-08-01).
  // The users were already pre-purged here; the pets were the gap.
  //
  // Matched on name AND absence of pet_registered — never on name alone.
  // afterAll deletes by id, which cannot touch anything else; a pre-clean has
  // no id to work from, so it needs a second predicate to be equally narrow.
  // The event condition IS that predicate: a pet registered through the app
  // always has the event, so a real animal that happens to be called "Race Dog
  // A" survives, and only fixture debris matches. This matters because
  // DATABASE_URL decides which database that DELETE lands on — the same
  // leftover-staging-shell trap check-spine-integrity.ts warns about.
  //
  // Verified against a seeded pair on 2026-08-01: an orphan row and a pet of
  // the SAME name carrying pet_registered. The orphan went, the real one
  // stayed. The database turned out to enforce this independently — deleting a
  // pet cascades into pet_events and the append-only trigger refuses ("pet_
  // events is append-only (AGENTS.md). DELETE blocked."), so a pet with ANY
  // event is undeletable, full stop. The predicate above is therefore belt and
  // braces, and it is the readable half: it says what we mean instead of
  // relying on a cascade to raise. Note the corollary for afterAll below — its
  // delete-by-id only succeeds because these fixtures never emit an event. If
  // the booking flow ever writes one against the pet, teardown starts failing.
  const debris = sql`
    SELECT id FROM pets
    WHERE name IN (${PET_A_NAME}, ${PET_B_NAME})
      AND NOT EXISTS (
        SELECT 1 FROM pet_events e WHERE e.pet_id = pets.id AND e.event_type = 'pet_registered'
      )
  `;
  await db.execute(sql`DELETE FROM ownerships WHERE pet_id IN (${debris})`);
  await db.execute(sql`DELETE FROM pets WHERE id IN (${debris})`);

  const a = await createFreshTestUser(supabase, {
    email: OWNER_A_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (a.error || !a.data.user) throw new Error(`createUser A: ${a.error?.message}`);
  ownerAUserId = a.data.user.id;

  const b = await createFreshTestUser(supabase, {
    email: OWNER_B_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (b.error || !b.data.user) throw new Error(`createUser B: ${b.error?.message}`);
  ownerBUserId = b.data.user.id;

  const p = await createFreshTestUser(supabase, {
    email: PROVIDER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (p.error || !p.data.user) throw new Error(`createUser provider: ${p.error?.message}`);
  providerUserId = p.data.user.id;

  // Seed two pets, one per owner.
  const [petA] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      species: "dog",
      name: PET_A_NAME,
    })
    .returning();
  petAId = petA.id;
  await db.insert(ownerships).values({ petId: petAId, ownerUserId: ownerAUserId, role: "owner" });

  const [petB] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      species: "cat",
      name: PET_B_NAME,
    })
    .returning();
  petBId = petB.id;
  await db.insert(ownerships).values({ petId: petBId, ownerUserId: ownerBUserId, role: "owner" });

  // Seed a capacity-1 offering and slot.
  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: generateOfferingToken(),
      providerUserId,
      serviceKind: "general_checkup",
      displayName: "Race Test Offering",
      durationMinutes: 15,
      slotCapacity: 1,
      status: "approved",
    })
    .returning();
  offeringId = offering.id;

  const [slot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // +5 days
      endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000),
      capacity: 1, // CAPACITY 1 — only one booking allowed
      bookingsCount: 0,
      status: "open",
    })
    .returning();
  raceSlotId = slot.id;
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  for (const token of insertedAppointmentTokens) {
    await db.delete(appointments).where(eq(appointments.publicToken, token));
  }

  await db.delete(timeSlots).where(eq(timeSlots.serviceOfferingId, offeringId));
  await db.delete(serviceOfferings).where(eq(serviceOfferings.id, offeringId));
  await db.delete(ownerships).where(eq(ownerships.petId, petAId));
  await db.delete(ownerships).where(eq(ownerships.petId, petBId));
  await db.execute(sql`DELETE FROM pets WHERE id = ${petAId}`);
  await db.execute(sql`DELETE FROM pets WHERE id = ${petBId}`);

  await purgeUserByEmail(OWNER_A_EMAIL);
  await purgeUserByEmail(OWNER_B_EMAIL);
  await purgeUserByEmail(PROVIDER_EMAIL);
});

// ---------------------------------------------------------------------------
// Race condition test
// ---------------------------------------------------------------------------

describe("bookSlotWriter — race condition", () => {
  it("exactly one booking wins when two owners race for a capacity-1 slot", async () => {
    const [resultA, resultB] = await Promise.all([
      bookSlotWriter(raceSlotId, petAId, ownerAUserId),
      bookSlotWriter(raceSlotId, petBId, ownerBUserId),
    ]);

    // Collect successful tokens for cleanup.
    if ("ok" in resultA) insertedAppointmentTokens.push(resultA.appointmentToken);
    if ("ok" in resultB) insertedAppointmentTokens.push(resultB.appointmentToken);

    const successes = [resultA, resultB].filter((r) => "ok" in r);
    const failures = [resultA, resultB].filter((r) => "error" in r);

    // EXACTLY one should win.
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // The failure must be a friendly capacity error (not an unhandled exception).
    expect(failures[0]).toEqual({ error: "Sin cupo disponible." });

    // bookings_count must be exactly 1 — never 2.
    const [slot] = await db
      .select({ bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, raceSlotId))
      .limit(1);

    expect(slot!.bookingsCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SC3 — server-side offering-status gate. A pre-materialized slot of a
// paused/archived offering must NOT be bookable via the writer directly, even
// though the UI hides it.
// ---------------------------------------------------------------------------

describe("bookSlotWriter — offering status gate (SC3)", () => {
  it("rejects booking a slot whose parent offering is not approved (paused)", async () => {
    const [pausedOffering] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: generateOfferingToken(),
        providerUserId,
        serviceKind: "general_checkup",
        displayName: "Paused Offering (SC3)",
        durationMinutes: 15,
        slotCapacity: 1,
        status: "paused",
      })
      .returning();

    const [pausedSlot] = await db
      .insert(timeSlots)
      .values({
        serviceOfferingId: pausedOffering.id,
        startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000),
        capacity: 1,
        bookingsCount: 0,
        status: "open",
      })
      .returning();

    try {
      const result = await bookSlotWriter(pausedSlot.id, petAId, ownerAUserId);
      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toMatch(/no está tomando turnos/i);

      // No booking landed — capacity untouched.
      const [slot] = await db
        .select({ bookingsCount: timeSlots.bookingsCount })
        .from(timeSlots)
        .where(eq(timeSlots.id, pausedSlot.id))
        .limit(1);
      expect(slot!.bookingsCount).toBe(0);
    } finally {
      await db.delete(appointments).where(eq(appointments.slotId, pausedSlot.id));
      await db.delete(timeSlots).where(eq(timeSlots.id, pausedSlot.id));
      await db.delete(serviceOfferings).where(eq(serviceOfferings.id, pausedOffering.id));
    }
  });
});

// ---------------------------------------------------------------------------
// The CAMPAIGN-level race — the one the advisory lock cannot serialize.
//
// `book-slot.ts` says so in its own comment and this file did not measure it:
// "the advisory lock is keyed per SLOT, so two concurrent submits against
// DIFFERENT slots of the same campaign do NOT serialize here; the partial unique
// index from migration 0181 (appointments_one_live_per_pet_offering) is the
// race-proof backstop below."
//
// `booking.test.ts` covers the campaign guard SEQUENTIALLY — book the 08:00, then
// try the 08:15 — which exercises the in-transaction re-read and never the index.
// The concurrent case is a different mechanism entirely: both transactions read
// "no existing booking in this campaign" before either inserts, both pass the
// in-lock check, and only the unique index can refuse the second.
//
// WHY IT MATTERS MORE THAN THE CAPACITY RACE ABOVE. The failure it prevents is
// one animal eating N places of a FREE campaign — the exact staging incident of
// 2026-08-13 (QA A3) — and a double tap on a phone with a slow connection is the
// ordinary way to produce two concurrent submits, not an unusual one.
// ---------------------------------------------------------------------------

describe("bookSlotWriter — campaign-level race (migration 0181's index, not the lock)", () => {
  it("refuses the second of two CONCURRENT bookings for one pet across two slots of one offering", async () => {
    const [campaign] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: generateOfferingToken(),
        providerUserId,
        serviceKind: "vaccination_rabies",
        displayName: "Campaign Race Offering",
        durationMinutes: 15,
        slotCapacity: 1,
        status: "approved",
      })
      .returning();

    const base = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const [slotEarly] = await db
      .insert(timeSlots)
      .values({
        serviceOfferingId: campaign.id,
        startsAt: new Date(base),
        endsAt: new Date(base + 15 * 60 * 1000),
        capacity: 1,
        bookingsCount: 0,
        status: "open",
      })
      .returning();
    const [slotLate] = await db
      .insert(timeSlots)
      .values({
        serviceOfferingId: campaign.id,
        startsAt: new Date(base + 15 * 60 * 1000),
        endsAt: new Date(base + 30 * 60 * 1000),
        capacity: 1,
        bookingsCount: 0,
        status: "open",
      })
      .returning();

    try {
      // SAME PET, TWO SLOTS, AT ONCE. Two DIFFERENT advisory-lock keys, so the two
      // transactions genuinely run in parallel past the in-lock re-read.
      const [early, late] = await Promise.all([
        bookSlotWriter(slotEarly.id, petAId, ownerAUserId),
        bookSlotWriter(slotLate.id, petAId, ownerAUserId),
      ]);

      const successes = [early, late].filter((r) => "ok" in r);
      const failures = [early, late].filter((r) => "error" in r);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      // AND THE REFUSAL IS THE FRIENDLY SENTENCE, not a raw index name. That
      // translation is the whole reason `isDuplicateLiveCampaignBooking` exists —
      // without it the person reads "duplicate key value violates unique
      // constraint appointments_one_live_per_pet_offering".
      expect(failures[0]).toEqual({
        error: "Esta mascota ya tiene un turno reservado en esta campaña.",
      });

      // ONE place taken in the whole campaign, not two. This is the assertion the
      // sequential test cannot make, because it never has two writers in flight.
      const counts = await db
        .select({ id: timeSlots.id, bookingsCount: timeSlots.bookingsCount })
        .from(timeSlots)
        .where(eq(timeSlots.serviceOfferingId, campaign.id));
      expect(counts.reduce((total, s) => total + s.bookingsCount, 0)).toBe(1);

      // And exactly one CONFIRMED appointment exists for this pet in this campaign.
      const live = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          sql`${appointments.petId} = ${petAId}
              AND ${appointments.serviceOfferingId} = ${campaign.id}
              AND ${appointments.status} = 'confirmed'`,
        );
      expect(live).toHaveLength(1);
    } finally {
      // CLEAN UP WHAT THIS CASE SEEDED, in a `finally` so a failed assertion does
      // not leave rows behind. The local Supabase is shared with parallel lanes.
      await db.delete(appointments).where(eq(appointments.serviceOfferingId, campaign.id));
      await db.delete(timeSlots).where(eq(timeSlots.serviceOfferingId, campaign.id));
      await db.delete(serviceOfferings).where(eq(serviceOfferings.id, campaign.id));
    }
  });
});
