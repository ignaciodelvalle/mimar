// Use-case: createMedicationEnd
//
// Migrated from app/actions/events.ts::createMedicationEndAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - FK GUARD (pre-tx): verify medicationStartedEventId belongs to pet AND
//     eventType=medication_started → else "Medicación de origen inválida."
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Cancel future incomplete reminders tied to sourceEventId.
//   - Attachment inserted when uploadedPath provided.
//   - No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateMedicationEndInput = {
  pet: { id: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  medicationStartedEventId: string;
  occurredAt: Date;
  reason: string | null;
  notes: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    | "findSourceMedicationEvent"
    | "insertEventIdempotent"
    | "insertAttachment"
    | "cancelFutureReminders"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createMedicationEnd(
  input: CreateMedicationEndInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    medicationStartedEventId,
    occurredAt,
    reason,
    notes,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
  } = input;
  const { repo, transaction } = deps;

  // FK guard — pre-tx: verify source event belongs to pet and is medication_started.
  const sourceEvent = await repo.findSourceMedicationEvent(pet.id, medicationStartedEventId);
  if (!sourceEvent || sourceEvent.eventType !== "medication_started") {
    return { ok: false, error: "Medicación de origen inválida." };
  }

  const now = new Date();

  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("medication_stopped", {
      medication_started_event_id: medicationStartedEventId,
      reason,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "medication_stopped",
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

    // Cancel future incomplete reminders tied to this medication source event.
    // Past-due reminders are left as-is (they record missed doses).
    await repo.cancelFutureReminders(
      medicationStartedEventId,
      now,
      tx as Parameters<typeof repo.cancelFutureReminders>[2],
    );

    return { eventId: event.id, wasDuplicate: false };
  });

  return { ok: true, value: committed, notifications: [] };
}
