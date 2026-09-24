// Use-case: createVetVisit
//
// Migrated from app/actions/events.ts::createVetVisitAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Attachment inserted when uploadedPath provided.
//   - Per-event jurisdiction (province/locality) embedded in payload.
//   - No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateVetVisitInput = {
  pet: { id: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  reason: string;
  occurredAt: Date;
  diagnosis: string | null;
  vetName: string | null;
  clinic: string | null;
  notes: string | null;
  eventJurisdictionProvince: string | null;
  eventJurisdictionLocality: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  clientIdempotencyKey: string | null;
};

type Deps = {
  repo: Pick<EventsRepository, "insertEventIdempotent" | "insertAttachment">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createVetVisit(
  input: CreateVetVisitInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    reason,
    occurredAt,
    diagnosis,
    vetName,
    clinic,
    notes,
    eventJurisdictionProvince,
    eventJurisdictionLocality,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
  } = input;
  const { repo, transaction } = deps;

  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("vet_visit_logged", {
      reason,
      diagnosis,
      vet_name: vetName,
      clinic,
      jurisdiction_province: eventJurisdictionProvince,
      jurisdiction_locality: eventJurisdictionLocality,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "vet_visit_logged",
        occurredAt,
        recordedAt: new Date(),
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

    return { eventId: event.id, wasDuplicate: false };
  });

  return { ok: true, value: committed, notifications: [] };
}
