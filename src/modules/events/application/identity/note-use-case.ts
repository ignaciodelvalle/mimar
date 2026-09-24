// Use-case: createNote
//
// Migrated from app/actions/events.ts::createNoteAction (inner tx block).
// Auth (requirePetAccess — NOT requireAlivePetAccess) handled by caller (actions.ts).
//
// PARITY QUIRK: auth guard is requirePetAccess (allows deceased/lost pets).
//   This differs from all medical use-cases which use requireAlivePetAccess.
//   The use-case itself is auth-agnostic; the guard distinction is at the action edge.
//
// THE QUIRK IS NOW HALF WHAT IT WAS (PO decision 2026-08-26). `requirePetAccess`
//   checks neither life status NOR the org `event.write` capability, and the
//   note writer used to inherit both gaps. The capability half is closed at the
//   action edge — `createNoteAction` asks `getGrantedCapabilities` itself — so
//   what remains of the quirk is exactly the deceased/lost allowance, which is
//   the half a memorial note depends on. Still nothing here: this file stays
//   auth-agnostic, and both gates live at the edge that resolved the caller.
//
// Parity:
//   - Uses insertEventIdempotent; wasNoop=true → skip ALL side-effects.
//   - Attachment inserted when uploadedPath provided.
//   - notes column is always null (the note text lives in payload.text).
//   - category from NOTE_CATEGORIES or null.
//   - No outbox. No audit_log.

import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { RecordedEvent, UseCaseResult } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateNoteInput = {
  pet: { id: string };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  text: string;
  occurredAt: Date;
  category: string | null;
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

export async function createNote(
  input: CreateNoteInput,
  deps: Deps,
): Promise<UseCaseResult<RecordedEvent>> {
  const {
    pet,
    user,
    eventAuthorship,
    text,
    occurredAt,
    category,
    uploadedPath,
    uploadedMimeType,
    uploadedSize,
    clientIdempotencyKey,
  } = input;
  const { repo, transaction } = deps;

  const committed = await transaction(async (tx) => {
    const eventPayload = validateEventPayload("note_added", { category, text });

    const { event, wasNoop } = await repo.insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "note_added",
        occurredAt,
        recordedAt: new Date(),
        recordedByUserId: user.id,
        ...eventAuthorship,
        payload: eventPayload,
        // Parity: the notes column is null for note_added events —
        // the text content is in the payload, not the notes column.
        notes: null,
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
