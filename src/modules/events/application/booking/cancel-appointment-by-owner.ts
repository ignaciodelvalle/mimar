// cancelAppointmentByOwner — owner cancellation use-case (Fase 6).
// Moved verbatim from app/actions/booking.ts (strangler 23/61).
//
// Auth guard (requireUserOrRedirect) is handled by the thin shim in
// app/actions/booking.ts before delegating here.

import { and, eq, sql } from "drizzle-orm";

import { appointments, db, notifications, organizations, timeSlots } from "@/db";

import type { CancelAppointmentResult } from "./types";

/**
 * Owner cancels their own appointment.
 * Guards:
 *   - Must be the authenticated owner of the pet on the appointment.
 *   - The slot must still be in the future.
 * Side-effects:
 *   - UPDATE appointments status → cancelled_by_owner.
 *   - DECREMENT time_slots.bookings_count (frees capacity).
 *   - INSERT notification to the provider org (if org-side).
 *
 * The caller (thin shim) is responsible for authentication via
 * requireUserOrRedirect before calling this function.
 */
export async function cancelAppointmentByOwner(
  appointmentToken: string,
  ownerUserId: string,
): Promise<CancelAppointmentResult> {
  // Load appointment + slot + offering (for provider notification).
  const [row] = await db
    .select({
      id: appointments.id,
      slotId: appointments.slotId,
      ownerUserId: appointments.ownerUserId,
      organizationId: appointments.organizationId,
      status: appointments.status,
      serviceOfferingId: appointments.serviceOfferingId,
      startsAt: timeSlots.startsAt,
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .where(eq(appointments.publicToken, appointmentToken))
    .limit(1);

  if (!row) return { error: "Turno no encontrado." };

  // Ownership check.
  if (row.ownerUserId !== ownerUserId) {
    return { error: "Este turno no te pertenece." };
  }

  if (row.status !== "confirmed") {
    return { error: "El turno ya fue procesado." };
  }

  // Can only cancel future slots.
  if (row.startsAt <= new Date()) {
    return { error: "No podés cancelar un turno que ya pasó." };
  }

  const now = new Date();

  // TOCTOU guard (SC1): the status check above is a stale read. Two concurrent
  // cancels would both pass it and each decrement bookings_count → capacity
  // double-freed → overbooking. Make the status flip CONDITIONAL on
  // status='confirmed' and only decrement when THIS call actually flipped the
  // row (rowCount===1). The loser matches zero rows and aborts without touching
  // capacity. Mirrors book-slot's guard against a stale read.
  let raced = false;

  await db.transaction(async (tx) => {
    // 1. Conditionally flip the appointment status (only while still confirmed).
    const updated = await tx
      .update(appointments)
      .set({
        status: "cancelled_by_owner",
        cancelledAt: now,
        cancelledByUserId: ownerUserId,
        updatedAt: now,
      })
      .where(and(eq(appointments.id, row.id), eq(appointments.status, "confirmed")))
      .returning({ id: appointments.id });

    if (updated.length === 0) {
      // A concurrent writer already processed this appointment — do NOT free
      // capacity a second time.
      raced = true;
      return;
    }

    // 2. Decrement bookings_count (free capacity).
    await tx
      .update(timeSlots)
      .set({
        bookingsCount: sql`${timeSlots.bookingsCount} - 1`,
        updatedAt: now,
      })
      .where(eq(timeSlots.id, row.slotId));

    // 3. Notify the provider org members (org_id path only).
    if (row.organizationId) {
      // Resolve the org's public token to build a valid /org/{token}/agenda
      // CTA. Fall back to the org-picker root when it can't be resolved
      // (should not happen for a row with organizationId set, but the CTA
      // must never point at the nonexistent /org/agenda route).
      const [orgRow] = await tx
        .select({ publicToken: organizations.publicToken })
        .from(organizations)
        .where(eq(organizations.id, row.organizationId))
        .limit(1);
      const ctaUrl = orgRow?.publicToken ? `/org/${orgRow.publicToken}/agenda` : "/org";

      // Find all admin/coordinator/member/vet_individual members of the org to notify.
      const orgMembers = await tx.execute(
        sql`SELECT user_id FROM organization_memberships
            WHERE organization_id = ${row.organizationId}
              AND left_at IS NULL
              AND role IN ('admin', 'coordinator', 'member', 'vet_individual')
            LIMIT 10`,
      );

      for (const m of orgMembers as unknown as { user_id: string }[]) {
        await tx.insert(notifications).values({
          userId: m.user_id,
          notificationType: "appointment_cancelled_by_owner",
          title: "Turno cancelado por el propietario",
          body: "Un propietario canceló su turno reservado.",
          severity: "info",
          ctaLabel: "Ver agenda",
          ctaUrl,
        });
      }
    }
  });

  if (raced) return { error: "El turno ya fue procesado." };

  return { ok: true };
}
