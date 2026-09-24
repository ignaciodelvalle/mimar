"use server";

// attendance.ts — thin shim (strangler migration 12/61).
//
// Business logic moved to:
//   src/modules/events/application/attendance/
//
// This file re-exports all types and the pure writer (used by integration
// tests and form components) and provides thin Action wrappers (used by UI
// components) that add the auth guard + revalidatePath.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { appointments, db, pets } from "@/db";
import { resolveSignerProvenance } from "@/lib/infra/signer-provenance";
import { cancelAppointmentByOrg as _cancelAppointmentByOrg } from "@/src/modules/events/application/attendance/cancel-appointment-by-org";
import { markAppointmentAttendedWriter as _markAppointmentAttendedWriter } from "@/src/modules/events/application/attendance/mark-appointment-attended";
import { markAppointmentNoShow as _markAppointmentNoShow } from "@/src/modules/events/application/attendance/mark-appointment-no-show";
import {
  type RequireCapabilitySuccess,
  requireCapability,
} from "@/src/modules/organizations/infrastructure/authz-resolver";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  AttendancePayload,
  AttendanceResult,
  AuthorDescriptor,
  DewormingPayload,
  MicrochipPayload,
  SterilizationPayload,
  VaccinationPayload,
  VetVisitPayload,
} from "@/src/modules/events/application/attendance/types";

// Bare writer is NOT re-exported here (impersonation triage, review 07).
// markAppointmentAttendedWriter takes a caller-supplied author descriptor
// (actorUserId, authorOrganizationId, authorVerified); exporting it from a
// "use server" file would let any client write attendance events as any
// vet/org. It lives on in
// src/modules/events/application/attendance/mark-appointment-attended;
// integration tests import it from there, and markAppointmentAttendedAction
// below derives the author from requireCapability("appointment.manage").

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

// ============================================================================
// Org-side attendance action (Fase 5)
// ============================================================================

export async function markAppointmentAttendedAction(
  appointmentToken: string,
  payload: Parameters<typeof _markAppointmentAttendedWriter>[1],
): Promise<Awaited<ReturnType<typeof _markAppointmentAttendedWriter>>> {
  // Load the appointment (with pet public token) to determine provider type.
  const [appt] = await db
    .select({
      id: appointments.id,
      organizationId: appointments.organizationId,
      serviceOfferingId: appointments.serviceOfferingId,
      petPublicToken: pets.publicToken,
    })
    .from(appointments)
    .innerJoin(pets, eq(pets.id, appointments.petId))
    // Art. 16 (Ley 25.326): a soft-deleted pet reads as NEVER REGISTERED.
    // Marking attendance appends a medical event onto the pet's spine and
    // republishes its libreta cache path; the org agenda already hides an
    // erased pet, but this action is reachable directly by appointmentToken.
    // Dropping the erased pet here folds it into the SAME "Turno no encontrado."
    // a missing appointment returns — no distinguishable existence oracle.
    .where(and(eq(appointments.publicToken, appointmentToken), isNull(pets.deletedAt)))
    .limit(1);

  if (!appt) return { error: "Turno no encontrado." };

  if (!appt.organizationId) return { error: "Prestador no encontrado." };

  const capResult = await requireCapability("appointment.manage", appt.organizationId);
  if (capResult.error) return { error: capResult.error };
  const cap = capResult as RequireCapabilitySuccess;

  // #43/#45 provenance. See lib/infra/signer-provenance.ts for what this used to
  // get wrong and why it is not derived from the membership role.
  const provenance = await resolveSignerProvenance(cap.user.id, appt.organizationId);

  const author = {
    actorUserId: cap.user.id,
    authorRole: provenance.authorRole,
    authorOrganizationId: provenance.authorOrganizationId,
    authorVerified: provenance.authorVerified,
  };

  const result = await _markAppointmentAttendedWriter(appt.id, payload, author);
  if ("ok" in result) {
    revalidatePath(`/org/${cap.organization.publicToken}/agenda`);
    revalidatePath("/mis-mascotas");
    revalidatePath(`/mis-mascotas/${appt.petPublicToken}/libreta`);
  }
  return result;
}

// ============================================================================
// No-show action (Fase 5)
// ============================================================================

export async function markAppointmentNoShowAction(
  appointmentToken: string,
  reason: string,
): Promise<{ ok: true } | { error: string }> {
  const [appt] = await db
    .select({
      id: appointments.id,
      organizationId: appointments.organizationId,
      status: appointments.status,
      serviceOfferingId: appointments.serviceOfferingId,
    })
    .from(appointments)
    .where(eq(appointments.publicToken, appointmentToken))
    .limit(1);

  if (!appt) return { error: "Turno no encontrado." };
  if (appt.status !== "confirmed") {
    return { error: "El turno ya fue procesado." };
  }

  if (!appt.organizationId) return { error: "Prestador no encontrado." };

  const capResult = await requireCapability("appointment.manage", appt.organizationId);
  if (capResult.error) return { error: capResult.error };
  const cap = capResult as RequireCapabilitySuccess;

  const result = await _markAppointmentNoShow(appt.id, reason);
  if ("ok" in result) {
    revalidatePath(`/org/${cap.organization.publicToken}/agenda`);
    revalidatePath("/mis-turnos");
  }
  return result;
}

// ============================================================================
// Org cancellation action (Fase 5)
// ============================================================================

export async function cancelAppointmentByOrgAction(
  appointmentToken: string,
  reason: string,
): Promise<{ ok: true } | { error: string }> {
  const [appt] = await db
    .select({
      id: appointments.id,
      organizationId: appointments.organizationId,
      slotId: appointments.slotId,
      status: appointments.status,
      ownerUserId: appointments.ownerUserId,
      serviceOfferingId: appointments.serviceOfferingId,
    })
    .from(appointments)
    .where(eq(appointments.publicToken, appointmentToken))
    .limit(1);

  if (!appt) return { error: "Turno no encontrado." };
  if (appt.status !== "confirmed") {
    return { error: "El turno ya fue procesado." };
  }

  if (!appt.organizationId) return { error: "Prestador no encontrado." };

  const capResult = await requireCapability("appointment.manage", appt.organizationId);
  if (capResult.error) return { error: capResult.error };
  const cap = capResult as RequireCapabilitySuccess;

  const result = await _cancelAppointmentByOrg(
    { id: appt.id, slotId: appt.slotId, ownerUserId: appt.ownerUserId },
    cap.user.id,
    cap.organization.displayName,
    reason,
  );

  if ("ok" in result) {
    revalidatePath(`/org/${cap.organization.publicToken}/agenda`);
    revalidatePath("/mis-turnos");
  }

  return result;
}
