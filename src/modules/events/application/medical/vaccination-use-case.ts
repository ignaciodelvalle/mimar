// Use-case: createVaccination
//
// Migrated from app/actions/events.ts::createVaccinationAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Attachment inserted when uploadedPath provided.
//   - Source reminder completed when sourceReminderId provided.
//   - Vaccine reminder created when nextDueAt provided.
//   - No outbox. No audit_log.

import { normalize } from "@/lib/domain/vaccine-reminder-state";
import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateVaccinationInput = {
  pet: { id: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  vaccineName: string;
  occurredAt: Date;
  brand: string | null;
  batch: string | null;
  administeredBy: string | null;
  nextDueAt: Date | null;
  notes: string | null;
  sourceReminderId: string | null;
  // Resolved by caller from uploadAttachmentIfPresent
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
  /**
   * Optional reminder description override. When provided (e.g. bulk path),
   * replaces the default "Próxima dosis programada." Used so the bulk path
   * can include the pet name without duplicating the vaccination logic.
   */
  reminderDescription?: string | null;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    | "insertEventIdempotent"
    | "insertAttachment"
    | "completeReminder"
    | "insertReminders"
    | "findOpenReminders"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createVaccination(
  input: CreateVaccinationInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    vaccineName,
    occurredAt,
    brand,
    batch,
    administeredBy,
    nextDueAt,
    notes,
    sourceReminderId,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
    reminderDescription,
  } = input;
  const { repo, transaction } = deps;

  const now = new Date();

  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("vaccination_administered", {
      vaccine_name: vaccineName,
      brand,
      batch,
      administered_by: administeredBy,
      next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "vaccination_administered",
        occurredAt,
        recordedAt: now,
        recordedByUserId: user.id,
        ...eventAuthorship,
        payload: eventPayload,
        notes,
        clientIdempotencyKey,
      } as Parameters<typeof repo.insertEventIdempotent>[0],
      tx as Parameters<typeof repo.insertEventIdempotent>[1],
    );

    if (wasNoop) return { eventId: event.id, wasDuplicate: true };

    if (uploadedPath) {
      await repo.insertAttachment(
        {
          petId: pet.id,
          eventId: event.id,
          uploadedByUserId: user.id,
          storagePath: uploadedPath,
          mimeType: uploadedMimeType ?? "image/jpeg",
          fileSize: uploadedSize ?? 0,
        },
        tx as Parameters<typeof repo.insertAttachment>[1],
      );
    }

    if (sourceReminderId) {
      await repo.completeReminder(
        sourceReminderId,
        pet.id,
        now,
        tx as Parameters<typeof repo.completeReminder>[3],
      );
    }

    if (nextDueAt) {
      const reminderTitle = `Refuerzo: ${vaccineName}`;

      // Supersede any other open vaccine reminder that resolves to the same
      // vaccine, case/accent-insensitively (title is free text, so
      // "Refuerzo: antirrábica" vs "Refuerzo: Antirrábica" must NOT coexist).
      // sourceReminderId is excluded here — it's already completed above.
      const openVaccineReminders = await repo.findOpenReminders(
        pet.id,
        "vaccine",
        tx as Parameters<typeof repo.findOpenReminders>[2],
      );
      const normalizedNewTitle = normalize(reminderTitle);
      const duplicates = openVaccineReminders.filter(
        (r) => r.id !== sourceReminderId && normalize(r.title) === normalizedNewTitle,
      );
      for (const duplicate of duplicates) {
        await repo.completeReminder(
          duplicate.id,
          pet.id,
          now,
          tx as Parameters<typeof repo.completeReminder>[3],
        );
      }

      await repo.insertReminders(
        [
          {
            petId: pet.id,
            userId: user.id,
            reminderType: "vaccine",
            dueAt: nextDueAt,
            title: reminderTitle,
            description: reminderDescription ?? "Próxima dosis programada.",
            sourceEventId: event.id,
          },
        ],
        tx as Parameters<typeof repo.insertReminders>[1],
      );
    }

    return { eventId: event.id, wasDuplicate: false };
  });

  return { ok: true, value: committed, notifications: [] };
}
