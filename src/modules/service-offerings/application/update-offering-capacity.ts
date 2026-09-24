// Use-case: updateOfferingCapacityWriter — ARCH-F
//
// Updates the offering's slotCapacity and syncs all future open/full slots
// of that offering in one transaction.
//
// Concurrency strategy (matches bookSlotAction D10 pattern):
//   - Open a Drizzle transaction.
//   - Acquire pg_advisory_xact_lock(hashtext(slot_id::text)) on EACH future slot
//     before updating it. This serializes concurrent booking attempts for those
//     slots with concurrent capacity edits.
//   - Re-read each slot inside the lock to get the live bookings_count.
//   - Clamp: never reduce capacity below the slot's current bookings_count.
//     Rationale: the DB CHECK (bookings_count <= capacity) is the final guardrail;
//     setting capacity = bookingsCount when newCapacity < bookingsCount keeps
//     the invariant intact and is the least surprising behavior for org staff —
//     existing bookings are never stranded, and the slot naturally becomes "full".
//   - Only future slots (starts_at > now) are updated; past slots are immutable.
//   - The offering's slotCapacity is also updated in the same transaction so
//     future cron-materialization runs see the correct value.
//
// Auth guard + org-ownership check live in the action.

import { db, serviceOfferings, timeSlots } from "@/db";
import { and, eq, gt, sql } from "drizzle-orm";

import type { UpdateCapacityResult } from "../domain/types";

/**
 * Updates the offering's slotCapacity and syncs all future open/full slots
 * of that offering in one transaction.
 *
 * Invariant: each slot's capacity is set to MAX(newCapacity, slot.bookingsCount).
 * This prevents the DB CHECK (bookings_count <= capacity) from firing while
 * never stranding existing bookings.
 *
 * Past slots (starts_at <= now) are intentionally left untouched.
 *
 * @param offeringId    The internal UUID of the service offering.
 * @param newCapacity   The desired new capacity (must be > 0).
 */
export async function updateOfferingCapacityWriter(
  offeringId: string,
  newCapacity: number,
): Promise<UpdateCapacityResult> {
  if (!Number.isInteger(newCapacity) || newCapacity < 1) {
    return { error: "La capacidad debe ser un número entero mayor a 0." };
  }

  let slotsUpdated = 0;

  try {
    slotsUpdated = await db.transaction(async (tx) => {
      // Capture `now` inside the transaction so it is consistent with the
      // advisory-lock window and any concurrent bookSlotAction reads.
      const now = new Date();
      let count = 0;

      // 1. Update the offering itself so future cron runs use the new value.
      await tx
        .update(serviceOfferings)
        .set({ slotCapacity: newCapacity, updatedAt: now })
        .where(eq(serviceOfferings.id, offeringId));

      // 2. Fetch all future non-cancelled slots for this offering.
      //    We intentionally include 'full' slots — no code path today writes
      //    status='full' (booking reads bookingsCount < capacity, not status).
      //    If a future change starts writing status='full', capacity raises must
      //    also reconcile status back to 'open' where bookingsCount < newCapacity.
      const futureSlots = await tx
        .select({
          id: timeSlots.id,
          bookingsCount: timeSlots.bookingsCount,
        })
        .from(timeSlots)
        .where(
          and(
            eq(timeSlots.serviceOfferingId, offeringId),
            gt(timeSlots.startsAt, now),
            // exclude cancelled slots — they are tombstoned and no longer bookable
            sql`${timeSlots.status} != 'cancelled'`,
          ),
        );

      // 3. For each future slot: acquire advisory lock, then update capacity.
      for (const slot of futureSlots) {
        // Advisory lock — uses Drizzle parameter binding (same pattern as
        // bookSlotAction / blockSlotAction: the driver sends the slot UUID as
        // a bound parameter, and hashtext receives it as text).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${slot.id}))`);

        // Re-read inside the lock to get the authoritative bookings_count.
        const [locked] = await tx
          .select({ bookingsCount: timeSlots.bookingsCount })
          .from(timeSlots)
          .where(eq(timeSlots.id, slot.id))
          .limit(1);

        const bookedCount = locked?.bookingsCount ?? slot.bookingsCount;
        // Clamp: capacity must be at least the current booked count.
        const effectiveCapacity = Math.max(newCapacity, bookedCount);

        await tx
          .update(timeSlots)
          .set({ capacity: effectiveCapacity, updatedAt: now })
          .where(eq(timeSlots.id, slot.id));

        count++;
      }

      return count;
    });
  } catch (err) {
    return {
      error: `No se pudo actualizar la capacidad: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true, slotsUpdated };
}
