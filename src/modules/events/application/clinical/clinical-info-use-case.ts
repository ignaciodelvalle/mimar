// Use-case: createClinicalInfo
//
// Migrated from app/actions/events.ts::createClinicalInfoAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Attachment inserted when uploadedPath provided.
//   - sub_kind validated by caller (actions.ts checks CLINICAL_SUB_KINDS).
//   - Per-event jurisdiction (province/locality) embedded in payload.
//   - No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateClinicalInfoInput = {
  pet: { id: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  subKind: string;
  title: string;
  details: string | null;
  performedBy: string | null;
  occurredAt: Date;
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

export async function createClinicalInfo(
  input: CreateClinicalInfoInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    subKind,
    title,
    details,
    performedBy,
    occurredAt,
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
    const eventPayload = validateEventPayload("clinical_info_logged", {
      sub_kind: subKind,
      title,
      details,
      performed_by: performedBy,
      jurisdiction_province: eventJurisdictionProvince,
      jurisdiction_locality: eventJurisdictionLocality,
    });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "clinical_info_logged",
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
