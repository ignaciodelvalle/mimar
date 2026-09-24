// Use-case: createDeworming
//
// Migrated from app/actions/events.ts::createDewormingAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Deworming reminder created when nextDueAt provided.
//   - Attachment inserted when uploadedPath provided.
//   - No outbox. No audit_log.
//
// wave-3 A1 (adjacent debt from the same fix createVaccination already has,
// see vaccination-use-case.ts): supersede any other open deworming reminder
// that resolves to the same product, case/accent-insensitively, before
// inserting the new one — otherwise every deworming event with a nextDueAt
// piles up a duplicate open reminder instead of replacing the old one.

import { normalize } from "@/lib/domain/vaccine-reminder-state";
import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateDewormingInput = {
  pet: { id: string; name: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  product: string;
  type: string;
  occurredAt: Date;
  nextDueAt: Date | null;
  notes: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    | "insertEventIdempotent"
    | "insertAttachment"
    | "insertReminders"
    | "findOpenReminders"
    | "completeReminder"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createDeworming(
  input: CreateDewormingInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    product,
    type,
    occurredAt,
    nextDueAt,
    notes,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
  } = input;
  const { repo, transaction } = deps;

  const now = new Date();

  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("deworming_administered", {
      product,
      type,
      next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "deworming_administered",
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

    if (nextDueAt) {
      const reminderTitle = `Refuerzo antiparasitario: ${product}`;

      // Supersede any other open deworming reminder that resolves to the
      // same product, case/accent-insensitively (title is free text, so
      // "Refuerzo antiparasitario: praziquantel" vs "...Praziquantel" must
      // NOT coexist) — same pattern as createVaccination.
      const openDewormingReminders = await repo.findOpenReminders(
        pet.id,
        "deworming",
        tx as Parameters<typeof repo.findOpenReminders>[2],
      );
      const normalizedNewTitle = normalize(reminderTitle);
      const duplicates = openDewormingReminders.filter(
        (r) => normalize(r.title) === normalizedNewTitle,
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
            reminderType: "deworming",
            dueAt: nextDueAt,
            title: reminderTitle,
            description: `Próxima dosis programada para ${pet.name}.`,
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
