// Use-case: createDangerousBreedAttestation
//
// Migrated from app/actions/events.ts::createDangerousBreedAttestationAction (inner tx block).
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity:
//   - insertEventIdempotent WHEN A KEY IS GIVEN, plain insertEvent when it is
//     not. The second branch is the web's path and is unchanged: its form posts
//     no key, so it still writes plainly.
//
//     THE FIRST BRANCH IS NEW (2026-09-08) AND IT IS WHY THIS FILE CHANGED.
//     `POST /api/v1/pets/{token}/events` REQUIRES an `Idempotency-Key` and
//     promises it is honoured. `writers.ts` listed this kind among the ones it
//     could not accept for exactly that reason: a writer that took the key and
//     ignored it would make the endpoint's promise false, which is worse than
//     not offering the kind at all. So the gap closed here, not there — the
//     same move `createSymptomObservedWriter` made before it, and its shape is
//     copied deliberately rather than improvised.
//
//     WHAT THE NOOP MUST SKIP, and this is the part a careless port gets wrong:
//     on a replay the attachment must NOT be inserted a second time and the PPP
//     reminder must NOT be re-marked. Both live inside the same transaction and
//     both are AFTER the early return.
//   - Attachment inserted when uploadedPath provided.
//   - markPppReminderRead: any unread ppp_registration_reminder for this pet
//     is auto-marked read (spec: "the notification is auto-marked-read").
//   - No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateDangerousBreedAttestationInput = {
  pet: { id: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  registry: string;
  registryId: string | null;
  attestedAt: Date;
  notes: string | null;
  uploadedPath: string | null;
  uploadedMimeType: string | null;
  uploadedSize: number | null;
  /**
   * When present, the insert is deduped on it and a replay skips every side
   * effect. Absent (the web's form) keeps the original plain-insert path.
   */
  clientIdempotencyKey?: string | null;
};

type Deps = {
  repo: Pick<
    EventsRepository,
    "insertEvent" | "insertEventIdempotent" | "insertAttachment" | "markPppReminderRead"
  >;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createDangerousBreedAttestation(
  input: CreateDangerousBreedAttestationInput,
  deps: Deps,
): Promise<UseCaseResult<{ eventId: string; wasDuplicate: boolean }>> {
  const {
    pet,
    user,
    eventAuthorship,
    registry,
    registryId,
    attestedAt,
    notes,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey = null,
  } = input;
  const { repo, transaction } = deps;

  const now = new Date();
  let wasDuplicate = false;

  const eventId = await transaction(async (tx) => {
    // Single insert — payload is final. THE INSERT IS PLAIN ONLY WHEN NO KEY
    // WAS GIVEN: the web's form posts none and keeps that path; the v1
    // endpoint requires an `Idempotency-Key` and gets `insertEventIdempotent`
    // below, whose no-op answer short-circuits the attachment and the
    // reminder mark. The line said PLAIN unconditionally until 2026-09-08,
    // which is the day the branch under it stopped being true.
    // attached_documents is NOT stored in the payload: the attachments table
    // already provides the join via event_id (same pattern as
    // sterilization / microchip / vaccination, preserving append-only discipline).
    const eventPayload = validateEventPayload("dangerous_breed_attested", {
      registry,
      registry_id: registryId,
      attested_at: attestedAt.toISOString().slice(0, 10),
    });

    const eventBase = {
      petId: pet.id,
      eventType: "dangerous_breed_attested",
      occurredAt: attestedAt,
      recordedAt: now,
      recordedByUserId: user.id,
      ...eventAuthorship,
      payload: eventPayload,
      notes,
    };

    let event: { id: string };

    if (clientIdempotencyKey != null) {
      const { event: inserted, wasNoop } = await repo.insertEventIdempotent(
        { ...eventBase, clientIdempotencyKey } as Parameters<typeof repo.insertEventIdempotent>[0],
        tx as Parameters<typeof repo.insertEventIdempotent>[1],
      );
      if (wasNoop) {
        // EARLY RETURN INSIDE THE TRANSACTION, before the attachment and before
        // the reminder. A replay must not duplicate the file nor re-mark a
        // notification the person already dealt with; the first submit did both.
        wasDuplicate = true;
        return inserted.id;
      }
      event = inserted;
    } else {
      event = await repo.insertEvent(
        eventBase as Parameters<typeof repo.insertEvent>[0],
        tx as Parameters<typeof repo.insertEvent>[1],
      );
    }

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

    // Mark any unread ppp_registration_reminder for this pet as read.
    // The owner just acted on it — spec: "the notification is auto-marked-read".
    await repo.markPppReminderRead(
      user.id,
      pet.id,
      now,
      tx as Parameters<typeof repo.markPppReminderRead>[3],
    );

    return event.id;
  });

  return { ok: true, value: { eventId, wasDuplicate }, notifications: [] };
}
