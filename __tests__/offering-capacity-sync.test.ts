// Integration tests for updateOfferingCapacityWriter — ARCH-F (P1).
//
// Tests:
//   1. Raising capacity — future slots get the new (higher) capacity.
//   2. Lowering capacity — clamped at bookings_count for slots with active
//      bookings; unbooked slots get the lower capacity directly.
//   3. Past slots — untouched regardless of new capacity.
//   4. Cancelled slots — untouched (tombstoned, no longer bookable).
//
// Invariant: each slot's effective capacity = MAX(newCapacity, bookingsCount).
// This keeps the DB CHECK (bookings_count <= capacity) intact and never
// strands existing bookings.
//
// Cron note: materializeAllActiveSlots reads offering.slotCapacity at
// insertion time. After updateOfferingCapacityWriter the offering row is
// updated in the same transaction, so the next cron run will materialize
// new slots with the correct capacity — no separate fix needed.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appointments,
  db,
  organizations,
  ownerships,
  pets,
  serviceOfferings,
  serviceScheduleRules,
  timeSlots,
} from "@/db";
import {
  generateAppointmentToken,
  generateOfferingToken,
  generatePublicToken,
} from "@/lib/infra/publicToken";
import { updateOfferingCapacityWriter } from "@/src/modules/service-offerings/application/update-offering-capacity";
import { createClient } from "@supabase/supabase-js";

import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Supabase admin client (bypasses RLS for fixture setup / cleanup)
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Fixture IDs
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "capacity-sync-owner@dim-test.local";
const PASS = "CapacitySync_2026!";

let ownerUserId: string;
let orgId: string;
let offeringId: string;
let offeringPublicToken: string;

// Slots used across tests (each test queries these independently)
let futureSlotAId: string; // future, unbooked (bookingsCount = 0)
let futureSlotBId: string; // future, 2 bookings (bookingsCount = 2)
let pastSlotId: string; // past, unbooked — must stay untouched
let cancelledSlotId: string; // future, cancelled — must stay untouched

// Appointments created to simulate bookingsCount = 2 on futureSlotB
const insertedAppointmentTokens: string[] = [];

// Pets this test inserts directly. Tracked so afterAll can delete exactly
// these ids — never a name match or a token-prefix LIKE.
const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any leftover auth users from previous failed runs.
  const { data: allUsers } = await supabase.auth.admin.listUsers();
  const existing = allUsers?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) await supabase.auth.admin.deleteUser(existing.id);

  // Create owner auth user.
  const created = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`createUser: ${created.error?.message}`);
  }
  ownerUserId = created.data.user.id;

  // Create org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: "Capacity Sync Test Org",
      displayName: "Capacity Sync Test Org",
      orgType: "shelter",
      email: "capacity-sync@dim-test.local",
      verified: true,
    })
    .returning({ id: organizations.id });
  orgId = org.id;

  // Create approved offering with initial slotCapacity = 3.
  offeringPublicToken = generateOfferingToken();
  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: offeringPublicToken,
      organizationId: orgId,
      serviceKind: "veterinary_consult",
      displayName: "Capacity Sync Test Consult",
      durationMinutes: 30,
      slotCapacity: 3,
      status: "approved",
    })
    .returning({ id: serviceOfferings.id });
  offeringId = offering.id;

  // Slot A — future, bookingsCount = 0 (unbooked).
  const [slotA] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // +2 days
      endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 3,
      bookingsCount: 0,
      status: "open",
    })
    .returning({ id: timeSlots.id });
  futureSlotAId = slotA.id;

  // Slot B — future, bookingsCount = 2 (has bookings).
  // We set bookingsCount directly rather than going through bookSlotWriter to
  // keep the fixture simple; the advisory-lock path is covered by booking.test.ts.
  const [slotB] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // +3 days
      endsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 3,
      bookingsCount: 2,
      status: "open",
    })
    .returning({ id: timeSlots.id });
  futureSlotBId = slotB.id;

  // Two minimal pets + ownerships so we can insert appointments for slotB.
  // TWO pets, one appointment each — not one pet twice: the partial unique
  // indexes from migrations 0177/0181 allow a single LIVE appointment per
  // (pet, slot) AND per (pet, offering). The old single-pet loop seeded a
  // state the schema now (correctly) refuses — and only ever passed because
  // the 0177 index sat INVALID in local after its failed CONCURRENTLY create.
  for (let i = 0; i < 2; i++) {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: generatePublicToken(),
        species: "dog",
        name: `Capacity Sync Dog ${i + 1}`,
      })
      .returning({ id: pets.id });
    insertedPetIds.push(pet.id);

    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId,
      role: "owner",
    });

    // One confirmed appointment per pet on slotB (bookingsCount = 2 total).
    const token = generateAppointmentToken();
    insertedAppointmentTokens.push(token);
    await db.insert(appointments).values({
      publicToken: token,
      slotId: futureSlotBId,
      petId: pet.id,
      ownerUserId,
      serviceOfferingId: offeringId,
      organizationId: orgId,
      status: "confirmed",
    });
  }

  // Past slot — bookingsCount = 0, starts_at in the past.
  const [past] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // -2 days
      endsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 3,
      bookingsCount: 0,
      status: "open",
    })
    .returning({ id: timeSlots.id });
  pastSlotId = past.id;

  // Cancelled future slot — must never be touched.
  const [cancelled] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // +5 days
      endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
      capacity: 3,
      bookingsCount: 0,
      status: "cancelled",
    })
    .returning({ id: timeSlots.id });
  cancelledSlotId = cancelled.id;
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Pets go first, in their own per-id transaction, so a failure anywhere
  // below can never leave an ownerless fixture pet behind. Each id is scoped
  // individually — a partial failure loses one pet, not the whole cleanup.
  //
  // pet_events deletes are blocked by enforce_pet_events_append_only; bypass
  // via the accountable SET LOCAL GUC pair (see _helpers/db-overrides.ts).
  for (const pid of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM appointments WHERE pet_id = ${pid}`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${pid}`);
      await tx.delete(ownerships).where(eq(ownerships.petId, pid));
      await tx.execute(sql`DELETE FROM pets WHERE id = ${pid}`);
    }).catch(() => {});
  }

  // Delete appointments first (FK on time_slots.id RESTRICT).
  for (const token of insertedAppointmentTokens) {
    await db
      .delete(appointments)
      .where(eq(appointments.publicToken, token))
      .catch(() => {});
  }

  // Delete slots, rules, offering, org.
  await db
    .delete(timeSlots)
    .where(eq(timeSlots.serviceOfferingId, offeringId))
    .catch(() => {});
  await db
    .delete(serviceScheduleRules)
    .where(eq(serviceScheduleRules.serviceOfferingId, offeringId))
    .catch(() => {});
  await db
    .delete(serviceOfferings)
    .where(eq(serviceOfferings.id, offeringId))
    .catch(() => {});
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => {});

  // The owner user's ownerships cascade via profile delete. Pets do NOT —
  // there is no FK from pets to profiles, so they are deleted explicitly
  // above. (This comment used to claim pets cascaded; they never did, and
  // every run of this suite leaked one orphan pet as a result.)
  const { data: allUsers } = await supabase.auth.admin.listUsers();
  const found = allUsers?.users.find((u) => u.email === OWNER_EMAIL);
  if (found) await supabase.auth.admin.deleteUser(found.id).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helper — read a slot's capacity from the DB
// ---------------------------------------------------------------------------

async function readSlotCapacity(slotId: string): Promise<number> {
  const [row] = await db
    .select({ capacity: timeSlots.capacity })
    .from(timeSlots)
    .where(eq(timeSlots.id, slotId))
    .limit(1);
  if (!row) throw new Error(`Slot ${slotId} not found`);
  return row.capacity;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateOfferingCapacityWriter", () => {
  it("raising capacity — future slots get the new higher capacity", async () => {
    // Precondition: both future slots start at capacity 3.
    expect(await readSlotCapacity(futureSlotAId)).toBe(3);
    expect(await readSlotCapacity(futureSlotBId)).toBe(3);

    const result = await updateOfferingCapacityWriter(offeringId, 5);

    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) throw new Error("Expected ok");

    // Both future non-cancelled slots updated.
    expect(result.slotsUpdated).toBe(2);

    // Slot A (0 bookings): capacity = 5.
    expect(await readSlotCapacity(futureSlotAId)).toBe(5);

    // Slot B (2 bookings): capacity = 5 (new > booked).
    expect(await readSlotCapacity(futureSlotBId)).toBe(5);

    // Past slot untouched — still 3.
    expect(await readSlotCapacity(pastSlotId)).toBe(3);

    // Cancelled slot untouched — still 3.
    expect(await readSlotCapacity(cancelledSlotId)).toBe(3);

    // The offering row itself is updated.
    const [off] = await db
      .select({ slotCapacity: serviceOfferings.slotCapacity })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.id, offeringId))
      .limit(1);
    expect(off?.slotCapacity).toBe(5);
  });

  it("lowering capacity — clamped at bookings_count for booked slots; unbooked slots get new lower capacity", async () => {
    // After previous test, capacities are all 5. Reset to 5 if needed.
    // Now lower to 1 — less than slotB's bookingsCount of 2.
    const result = await updateOfferingCapacityWriter(offeringId, 1);

    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) throw new Error("Expected ok");

    expect(result.slotsUpdated).toBe(2);

    // Slot A (0 bookings): capacity = MAX(1, 0) = 1.
    expect(await readSlotCapacity(futureSlotAId)).toBe(1);

    // Slot B (2 bookings): capacity = MAX(1, 2) = 2 (clamped — not stranded).
    expect(await readSlotCapacity(futureSlotBId)).toBe(2);

    // Verify DB CHECK invariant holds: bookings_count <= capacity on slot B.
    const [rowB] = await db
      .select({ capacity: timeSlots.capacity, bookingsCount: timeSlots.bookingsCount })
      .from(timeSlots)
      .where(eq(timeSlots.id, futureSlotBId))
      .limit(1);
    expect(rowB!.bookingsCount).toBeLessThanOrEqual(rowB!.capacity);

    // Past slot still at whatever capacity the previous test left it.
    // Key invariant: past slot NOT updated (still does not equal 1).
    // We know it started at 3 and was never touched, so it is still 3.
    expect(await readSlotCapacity(pastSlotId)).toBe(3);

    // Cancelled slot still untouched.
    expect(await readSlotCapacity(cancelledSlotId)).toBe(3);

    // Offering row updated to 1.
    const [off] = await db
      .select({ slotCapacity: serviceOfferings.slotCapacity })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.id, offeringId))
      .limit(1);
    expect(off?.slotCapacity).toBe(1);
  });

  it("invalid capacity — returns error without modifying DB", async () => {
    const capacityBefore = await readSlotCapacity(futureSlotAId);

    const result = await updateOfferingCapacityWriter(offeringId, 0);
    expect(result).toMatchObject({ error: expect.any(String) });

    // No change.
    expect(await readSlotCapacity(futureSlotAId)).toBe(capacityBefore);
  });
});
