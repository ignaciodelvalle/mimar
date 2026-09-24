// markAppointmentAttendedWriter — pure DB function, testable without HTTP context.
// Moved verbatim from app/actions/attendance.ts (strangler 12/61).
//
// The caller is responsible for:
//   1. Authenticating the actor.
//   2. Verifying the appointment belongs to the actor's org or is the vet provider.
//   3. Resolving the AuthorDescriptor.

import { and, eq } from "drizzle-orm";

import {
  appointments,
  db,
  petEvents,
  petIdentifications,
  pets,
  reminders,
  serviceOfferings,
} from "@/db";
import { chipImplantSiteFromLocation } from "@/lib/domain/microchip-implant-site";
import { checkChipMatchesCanonical } from "@/lib/domain/microchip-validation";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { matchesDbError } from "@/lib/infra/db-errors";
import { createNotification } from "@/lib/infra/notification-service";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { parseDateInput } from "@/lib/utils/format";

import type { AttendancePayload, AttendanceResult, AuthorDescriptor } from "./types";

// Sentinel thrown inside the tx when the conditional status flip matches no row
// (the appointment was cancelled/attended/no-show by a concurrent writer). It
// rolls back the whole tx so NO medical pet_event is written against a
// non-confirmed appointment (SC2).
class AppointmentRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppointmentRaceError";
  }
}

/**
 * Core attendance writer. Validates the payload, updates the appointment,
 * inserts the pet_event, and optionally inserts a vaccination reminder.
 *
 * The caller is responsible for:
 *   1. Authenticating the actor.
 *   2. Verifying the appointment belongs to the actor's org or is the vet provider.
 *   3. Resolving the AuthorDescriptor.
 */
export async function markAppointmentAttendedWriter(
  appointmentId: string,
  payload: AttendancePayload,
  author: AuthorDescriptor,
): Promise<AttendanceResult> {
  try {
    // Load appointment + offering + pet.
    const [row] = await db
      .select({
        appointment: appointments,
        offering: serviceOfferings,
        pet: pets,
      })
      .from(appointments)
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
      .innerJoin(pets, eq(pets.id, appointments.petId))
      .where(eq(appointments.id, appointmentId))
      .limit(1);

    if (!row) return { error: "Turno no encontrado." };
    if (row.appointment.status !== "confirmed") {
      return { error: "El turno ya fue procesado (asistido, cancelado o ausente)." };
    }

    const { appointment, offering, pet } = row;

    // Derive event type from the service kind catalog.
    const kindDef = findServiceKind(offering.serviceKind);
    const eventType = kindDef?.emitted_event_type ?? "vet_visit_logged";

    // Normalize the date-only next_due_at ("YYYY-MM-DD" from <input
    // type="date">) to the canonical noon-UTC ISO instant every other
    // vaccination/deworming writer stores (vaccination-use-case,
    // deworming-use-case both persist parseDateInput(...).toISOString()).
    // Storing the RAW string made read-side consumers parse it at midnight
    // UTC = 21:00 of the PREVIOUS day in AR.
    let nextDueAt: Date | null = null;
    if ((payload.kind === "vaccination" || payload.kind === "deworming") && payload.next_due_at) {
      nextDueAt = parseDateInput(payload.next_due_at);
      if (!nextDueAt) return { error: "Fecha de próxima dosis inválida." };
    }

    // Build and validate the raw event payload.
    let rawPayload: Record<string, unknown>;
    if (payload.kind === "vaccination") {
      rawPayload = {
        vaccine_name: payload.vaccine_name,
        brand: payload.brand,
        batch: payload.batch,
        administered_by: payload.administered_by,
        next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
      };
    } else if (payload.kind === "deworming") {
      rawPayload = {
        product: payload.product,
        type: payload.type,
        next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
      };
    } else if (payload.kind === "sterilization") {
      rawPayload = {
        procedure: payload.procedure,
        performed_by: payload.performed_by,
        clinic: payload.clinic,
      };
    } else if (payload.kind === "microchip") {
      rawPayload = {
        chip_number: payload.chip_number,
        country_code: payload.country_code,
        implanted_by: payload.implanted_by,
        location_on_body: payload.location_on_body,
      };
    } else {
      // vet_visit (generic fallback)
      rawPayload = {
        reason: payload.reason,
        diagnosis: payload.diagnosis,
        vet_name: payload.vet_name,
        clinic: payload.clinic,
      };
    }

    // Validate against the strict Zod schema.
    const validatedPayload = validateEventPayload(eventType, rawPayload);

    const now = new Date();

    // Microchip pre-check: surface a friendly inline error when the chip is
    // already registered on a DIFFERENT active pet (the chip_unique partial
    // index is UNIQUE(code) over active chip rows table-wide, so it would
    // otherwise raise a raw 500). Runs first because "this chip belongs to
    // another animal" is the more specific diagnosis; the same-pet check below
    // handles what is left.
    if (payload.kind === "microchip") {
      const dupes = await db
        .select({ petId: petIdentifications.petId })
        .from(petIdentifications)
        .where(
          and(
            eq(petIdentifications.code, payload.chip_number),
            eq(petIdentifications.kind, "microchip_iso"),
            eq(petIdentifications.status, "active"),
          ),
        )
        .limit(1);
      if (dupes[0] && dupes[0].petId !== pet.id) {
        return { error: "Ese chip ya está registrado en otra mascota activa." };
      }
    }

    // The pet's active canonical chip, if any — drives the dual-write guard
    // below (same pattern as the createMicrochip use-case). Held as the CODE,
    // not a boolean: the pre-check above only rules out a chip active on
    // ANOTHER pet, so a number that disagrees with THIS pet's own chip still
    // has to be caught before the event is appended.
    const canonicalChipNumber =
      payload.kind === "microchip"
        ? ((await fetchActiveIdentifications(pet.id)).microchip?.code ?? null)
        : null;

    // Same guard, same reason as createMicrochip: the attended-appointment path
    // is a full microchip_implanted writer, so it could append a chip the
    // credential does not carry and then skip the canonical row in step 4.
    if (payload.kind === "microchip") {
      const conflict = checkChipMatchesCanonical(canonicalChipNumber, payload.chip_number);
      if (conflict) return conflict;
    }

    await db.transaction(async (tx) => {
      // 1. CONDITIONALLY flip the appointment status (SC2). The status check
      //    above is a stale read — a concurrent cancel/no-show may have already
      //    processed this appointment. Guard on status='confirmed' and abort the
      //    whole tx if it matched no row, so we NEVER write an immutable medical
      //    pet_event against a cancelled/attended appointment.
      const updated = await tx
        .update(appointments)
        .set({
          status: "attended",
          attendedAt: now,
          attendedByUserId: author.actorUserId,
          updatedAt: now,
        })
        .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "confirmed")))
        .returning({ id: appointments.id });

      if (updated.length === 0) {
        throw new AppointmentRaceError(
          "El turno ya fue procesado (asistido, cancelado o ausente).",
        );
      }

      // 2. INSERT pet_event.
      const [newEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType,
          occurredAt: now,
          recordedByUserId: author.actorUserId,
          authorRole: author.authorRole,
          authorOrganizationId: author.authorOrganizationId,
          authorVerified: author.authorVerified,
          payload: validatedPayload as Record<string, unknown>,
        })
        .returning({ id: petEvents.id });

      // 3. Link outcome event to appointment.
      await tx
        .update(appointments)
        .set({ outcomeEventId: newEvent.id })
        .where(eq(appointments.id, appointmentId));

      // 4. Microchip canonical dual-write (ARCH-O): every microchip_implanted
      // writer must insert the canonical pet_identifications row, mirroring
      // createMicrochip. Only when the pet had no prior active chip — the
      // pre-check above already rejected a chip active on another pet.
      if (payload.kind === "microchip" && canonicalChipNumber === null) {
        const implantSite = chipImplantSiteFromLocation(payload.location_on_body);
        await tx.insert(petIdentifications).values({
          petId: pet.id,
          kind: "microchip_iso",
          code: payload.chip_number,
          recordedAt: now.toISOString().slice(0, 10),
          recordedByUserId: author.actorUserId,
          recordedByLabel: payload.implanted_by,
          isoCountryCode: payload.chip_number.slice(0, 3),
          isoManufacturerCode: payload.chip_number.slice(3, 7),
          isoNationalId: payload.chip_number.slice(7, 15),
          isoCompliant: true,
          ...(implantSite ? { implantationSite: implantSite } : {}),
        });
      }

      // 5. If vaccination with next_due_at, insert a reminder for the owner.
      // dueAt uses the normalized noon-UTC anchor — new Date("YYYY-MM-DD")
      // was midnight UTC, i.e. 21:00 of the previous AR day.
      if (payload.kind === "vaccination" && nextDueAt && appointment.ownerUserId) {
        await tx.insert(reminders).values({
          petId: pet.id,
          userId: appointment.ownerUserId,
          reminderType: "vaccine",
          dueAt: nextDueAt,
          title: `Próxima dosis: ${payload.vaccine_name}`,
          description: payload.brand ? `Marca: ${payload.brand}` : null,
          sourceEventId: newEvent.id,
          appointmentId: appointment.id,
        });
      }
    });

    // 6. Tell the owner (T1-L5). Cancel-by-org in this same module always did;
    // attend and no-show wrote nothing, so an owner learned their turno was
    // closed only by opening /mis-turnos. OUTSIDE the transaction on purpose
    // (ARCH-P): createNotification never throws and dead-letters on failure,
    // so a notification fault can never roll back the medical event. The
    // dedupe key is per appointment AND outcome — an appointment reaches
    // `attended` at most once (the conditional flip above), so a retry of the
    // same call collapses instead of notifying twice.
    if (appointment.ownerUserId) {
      await createNotification({
        userId: appointment.ownerUserId,
        notificationType: "appointment_attended",
        title: "Turno atendido",
        body: `Registramos la atención de ${pet.name}. Ya figura en su libreta.`,
        severity: "info",
        ctaLabel: "Ver mis turnos",
        ctaUrl: "/mis-turnos",
        relatedPetId: pet.id,
        dedupeKey: `appointment:${appointment.id}:attended`,
      });
    }

    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof AppointmentRaceError) {
      return { error: err.message };
    }
    if (err instanceof Error && err.name === "EventPayloadValidationError") {
      return { error: err.message };
    }
    // Duplicate-chip race: the pre-check passed but a concurrent write claimed
    // the chip first. Surface the same friendly message instead of a raw 500.
    if (matchesDbError(err, { constraint: /pet_identifications_chip_unique/ })) {
      return { error: "Ese chip ya está registrado en otra mascota activa." };
    }
    throw err;
  }
}
