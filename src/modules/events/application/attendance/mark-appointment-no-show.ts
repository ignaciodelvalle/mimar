// markAppointmentNoShow — no-show use-case (Fase 5).
// Moved verbatim from app/actions/attendance.ts (strangler 12/61).
//
// Auth guard (requireCapability) is handled by the thin shim in
// app/actions/attendance.ts before delegating here.

import { and, eq } from "drizzle-orm";

import { appointments, db, pets } from "@/db";
import { createNotification } from "@/lib/infra/notification-service";

import type { AttendanceResult } from "./types";

/**
 * Marks an appointment as no-show and tells the owner. The caller (thin shim) is responsible for
 * authenticating the actor and verifying organization capability before calling.
 */
export async function markAppointmentNoShow(
  appointmentId: string,
  reason: string,
): Promise<AttendanceResult> {
  const now = new Date();
  // TOCTOU guard (SC2): flip CONDITIONALLY on status='confirmed'. Without it a
  // no-show racing a cancel/attend would blindly overwrite the final status.
  const updated = await db
    .update(appointments)
    .set({
      status: "no_show",
      noShowMarkedAt: now,
      notesFromOrg: reason || null,
      updatedAt: now,
    })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "confirmed")))
    .returning({
      id: appointments.id,
      ownerUserId: appointments.ownerUserId,
      petId: appointments.petId,
    });

  if (updated.length === 0) {
    return { error: "El turno ya fue procesado (asistido, cancelado o ausente)." };
  }

  // Tell the owner (T1-L5), as cancel-by-org in this module does. Only the call
  // that actually flipped the row gets here, so the notification is bound to
  // the real transition. Post-write via the pool (ARCH-P): createNotification
  // never throws, and the per-appointment-and-outcome dedupe key collapses a
  // retry.
  const flipped = updated[0];
  if (flipped.ownerUserId) {
    const [pet] = await db
      .select({ name: pets.name })
      .from(pets)
      .where(eq(pets.id, flipped.petId))
      .limit(1);
    const subject = pet ? `El turno de ${pet.name}` : "Tu turno";
    await createNotification({
      userId: flipped.ownerUserId,
      notificationType: "appointment_no_show",
      title: "Turno marcado como ausente",
      body: reason
        ? `${subject} quedó registrado como ausente. Motivo: ${reason}`
        : `${subject} quedó registrado como ausente.`,
      severity: "warning",
      ctaLabel: "Ver mis turnos",
      ctaUrl: "/mis-turnos",
      relatedPetId: flipped.petId,
      dedupeKey: `appointment:${flipped.id}:no_show`,
    });
  }

  return { ok: true };
}
