// book-slot.ts — core booking writer (strangler 23/61).
// Moved verbatim from app/actions/booking.ts.
//
// Advisory lock strategy (D10):
//   1. Open a Drizzle transaction.
//   2. Acquire pg_advisory_xact_lock(hashtext(slot_id::text)) to serialize
//      concurrent booking attempts for the same slot.
//   3. Re-read the slot inside the lock: confirm bookings_count < capacity
//      AND starts_at > now(). If not, return a friendly error immediately.
//   4. INSERT the appointment.
//   5. UPDATE time_slots SET bookings_count = bookings_count + 1.
//   6. The DB CHECK constraint `slot_bookings_within_capacity` is the second
//      line of defense — if two transactions somehow raced past the lock, the
//      UPDATE triggers a constraint violation and the transaction rolls back.

import { and, eq, sql } from "drizzle-orm";

import { appointments, db, timeSlots } from "@/db";
import { matchesDbError } from "@/lib/infra/db-errors";
import { generateAppointmentToken } from "@/lib/infra/publicToken";
import { slotRuleIsLive } from "@/lib/infra/slot-rule-liveness";
import { generateUniqueToken } from "@/lib/infra/unique-token";

import type { BookSlotResult } from "./types";

// ============================================================================
// Internal sentinel error (stays within this module)
// ============================================================================

class BookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingError";
  }
}

/**
 * Core booking writer. Acquires a Postgres advisory lock keyed to the slot,
 * validates capacity + future window, inserts the appointment, and increments
 * bookings_count. The DB CHECK constraint is the final guardrail.
 *
 * The caller is responsible for verifying that `petId` belongs to `ownerUserId`
 * before calling this function. The writer is intentionally pet-agnostic to
 * keep the inner writer independently testable.
 *
 * @param slotId      UUID of the time_slot to book.
 * @param petId       UUID of the pet being booked (pre-verified as owned).
 * @param ownerUserId UUID of the booking owner.
 */
export async function bookSlotWriter(
  slotId: string,
  petId: string,
  ownerUserId: string,
): Promise<BookSlotResult> {
  const publicToken = await generateUniqueToken(
    appointments,
    appointments.publicToken,
    generateAppointmentToken,
  );

  try {
    await db.transaction(async (tx) => {
      // Step 1 — Advisory lock on slot_id. hashtext() maps the UUID string to
      // a bigint key. xact-scoped locks auto-release at transaction end.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${slotId}))`);

      // Step 2 — Re-read slot inside the lock.
      const [slot] = await tx
        .select({
          id: timeSlots.id,
          capacity: timeSlots.capacity,
          bookingsCount: timeSlots.bookingsCount,
          startsAt: timeSlots.startsAt,
          status: timeSlots.status,
          serviceOfferingId: timeSlots.serviceOfferingId,
          ruleLive: sql<boolean>`${slotRuleIsLive()}`,
        })
        .from(timeSlots)
        .where(eq(timeSlots.id, slotId))
        .limit(1);

      if (!slot) {
        throw new BookingError("El turno no existe.");
      }
      if (slot.status === "cancelled") {
        throw new BookingError("El turno fue cancelado.");
      }
      if (slot.bookingsCount >= slot.capacity) {
        throw new BookingError("Sin cupo disponible.");
      }
      if (slot.startsAt <= new Date()) {
        throw new BookingError("El turno ya pasó.");
      }
      // T1-L16: the rule that materialised this slot must still stand for its
      // date. Deleting (archiving) or pausing a rule, or moving its
      // effective_until earlier, never touched the slots already materialised
      // 60 days ahead — they stayed bookable. Re-checked HERE, under the lock,
      // rather than by cancelling slots on delete: nothing is written to a slot
      // that already holds appointments, so those stay exactly as they were.
      if (!slot.ruleLive) {
        throw new BookingError("Este horario ya no está en la agenda del prestador.");
      }

      // Identity guard — this pet must not already hold this slot. Capacity was
      // guarded from day one; identity was not, so an anxious double click
      // booked the same pet twice and ate a second place in a free campaign
      // (staging clickthrough, 2026-08-13). Inside the advisory lock, so two
      // concurrent submits cannot both read "no existing booking". The partial
      // unique index from migration 0177 is the safety net below.
      const [existing] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.petId, petId),
            eq(appointments.slotId, slotId),
            eq(appointments.status, "confirmed"),
          ),
        )
        .limit(1);
      if (existing) {
        throw new BookingError("Esta mascota ya tiene este turno reservado.");
      }

      // Campaign-level identity guard (QA A3, 2026-08-13): one CONFIRMED
      // appointment per (pet, offering). The per-slot guard above let the same
      // pet take the 08:00 AND the 08:15 of the SAME free campaign — N slots,
      // N eaten places. NOTE the advisory lock is keyed per SLOT, so two
      // concurrent submits against DIFFERENT slots of the same campaign do NOT
      // serialize here; the partial unique index from migration 0181
      // (appointments_one_live_per_pet_offering) is the race-proof backstop
      // below. Cancelled/attended/no_show rows don't count — cancel-and-rebook
      // stays legitimate.
      const [existingInCampaign] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.petId, petId),
            eq(appointments.serviceOfferingId, slot.serviceOfferingId),
            eq(appointments.status, "confirmed"),
          ),
        )
        .limit(1);
      if (existingInCampaign) {
        throw new BookingError("Esta mascota ya tiene un turno reservado en esta campaña.");
      }

      // Step 3 — Fetch offering to denormalize organizationId AND re-check its
      // status under the lock (SC3). The UI hides slots of paused/archived
      // offerings, but a pre-materialized slot of a non-approved offering is
      // still bookable via the server action directly. Reject anything but an
      // approved offering — matching the UI gate — so a paused offering can't be
      // booked out of band.
      const offeringRows = await tx.execute(
        sql`SELECT organization_id, status FROM service_offerings WHERE id = ${slot.serviceOfferingId} LIMIT 1`,
      );
      const offeringRow = offeringRows[0] as
        | { organization_id: string | null; status: string }
        | undefined;
      if (!offeringRow) {
        throw new BookingError("El servicio no está disponible.");
      }
      if (offeringRow.status !== "approved") {
        throw new BookingError("Este servicio no está tomando turnos en este momento.");
      }
      const organizationId = offeringRow.organization_id ?? null;

      // Step 4 — INSERT appointment.
      await tx.insert(appointments).values({
        publicToken,
        slotId,
        petId,
        ownerUserId,
        serviceOfferingId: slot.serviceOfferingId,
        organizationId,
        status: "confirmed",
      });

      // Step 5 — Increment bookings_count (DB CHECK is the safety net).
      await tx
        .update(timeSlots)
        .set({
          bookingsCount: sql`${timeSlots.bookingsCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(timeSlots.id, slotId));
    });
  } catch (err) {
    if (err instanceof BookingError) {
      return { error: err.message };
    }
    // If the advisory-lock + manual capacity check raced past somehow and
    // the DB CHECK constraint caught it (review 2026-05-19 §2.8), translate
    // the raw Postgres message into the same user-facing copy the in-tx
    // path uses, instead of bubbling up "new row for relation 'time_slots'
    // violates check constraint 'slot_bookings_within_capacity'".
    if (isSlotCapacityViolation(err)) {
      return { error: "Sin cupo disponible." };
    }
    // Same treatment for the identity invariant: if two submits raced past the
    // in-lock check, the partial unique index catches it and the user gets the
    // same sentence as the in-tx path, not a raw index name.
    if (isDuplicateLiveBooking(err)) {
      return { error: "Esta mascota ya tiene este turno reservado." };
    }
    // Campaign-level identity: the per-slot advisory lock cannot serialize two
    // submits against DIFFERENT slots of the same offering, so unlike the two
    // above this one is not a belt-and-braces net — it is the primary guard
    // for that race (migration 0181).
    if (isDuplicateLiveCampaignBooking(err)) {
      return { error: "Esta mascota ya tiene un turno reservado en esta campaña." };
    }
    throw err;
  }

  return { ok: true, appointmentToken: publicToken };
}

// Postgres 23514 = check_violation. The CHECK is named
// `slot_bookings_within_capacity` (db/migrations/0008_scheduling_core.sql).
// matchesDbError walks drizzle 0.45's `.cause` chain (the real pg error is no
// longer top-level) and tests the constraint name against both the
// constraint_name field and the pg error message.
function isSlotCapacityViolation(err: unknown): boolean {
  return matchesDbError(err, {
    code: "23514",
    constraint: /slot_bookings_within_capacity/,
  });
}

// Postgres 23505 = unique_violation, from the partial unique index
// `appointments_one_live_per_pet_slot` (db/migrations/0177, rebuilt in 0181).
function isDuplicateLiveBooking(err: unknown): boolean {
  return matchesDbError(err, {
    code: "23505",
    constraint: /appointments_one_live_per_pet_slot/,
  });
}

// Postgres 23505 = unique_violation, from the partial unique index
// `appointments_one_live_per_pet_offering` (db/migrations/0181).
function isDuplicateLiveCampaignBooking(err: unknown): boolean {
  return matchesDbError(err, {
    code: "23505",
    constraint: /appointments_one_live_per_pet_offering/,
  });
}
