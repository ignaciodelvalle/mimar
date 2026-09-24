// Use-case test: createNote
//
// RED → GREEN TDD. Tests cover:
//   - Happy path: idempotent insert with optional category.
//   - Replay / noop: wasNoop=true → attachment skipped.
//   - Attachment: uploaded path triggers insertAttachment.
//   - AUTH PARITY: action uses requirePetAccess (NOT requireAlivePetAccess) —
//     allows deceased/lost pets — AND, since the PO decision of 2026-08-26,
//     checks the org `event.write` capability by hand, because requirePetAccess
//     checks none. The use-case is auth-agnostic; both parity tests belong in
//     the actions layer. Here we verify the use-case itself does NOT validate
//     status (passes through).
//   - notes field is always null on the petEvents row (per original parity:
//     notes: null — the "notes" param is mapped to the payload text, not the notes column).

import { describe, expect, it, vi } from "vitest";
import type { EventsRepository } from "../../infrastructure/events-repository";
import { createNote } from "./note-use-case";

// ---------------------------------------------------------------------------
// Minimal mock factory
// ---------------------------------------------------------------------------

function makeRepo(
  overrides: Partial<EventsRepository> = {},
): Pick<EventsRepository, "insertEventIdempotent" | "insertAttachment"> {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: "ev-1" },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTx() {
  return <T>(cb: (tx: unknown) => Promise<T>) => cb({} as unknown);
}

const BASE_INPUT = {
  pet: { id: "pet-1" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  text: "El gato comió bien hoy",
  occurredAt: new Date("2024-02-10"),
  category: "dieta" as string | null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "note-key-1",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNote", () => {
  it("inserts note_added event with category and returns eventId", async () => {
    const repo = makeRepo();
    const result = await createNote(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.eventId).toBe("ev-1");

    expect(repo.insertEventIdempotent).toHaveBeenCalledOnce();
    const [insertArg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertArg.eventType).toBe("note_added");
    expect(insertArg.petId).toBe("pet-1");
    expect(insertArg.clientIdempotencyKey).toBe("note-key-1");
    // notes column is null (the text goes in the payload)
    expect(insertArg.notes).toBeNull();
    // payload has the text and category
    expect(insertArg.payload.category).toBe("dieta");
    expect(insertArg.payload.text).toBe("El gato comió bien hoy");
  });

  it("inserts with null category when category is null", async () => {
    const repo = makeRepo();
    await createNote({ ...BASE_INPUT, category: null }, { repo, transaction: makeTx() });

    const [insertArg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertArg.payload.category).toBeNull();
  });

  it("skips all side-effects on noop replay (wasNoop=true)", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: "ev-1" },
        wasNoop: true,
      }),
    });

    const result = await createNote(BASE_INPUT, { repo, transaction: makeTx() });

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("inserts attachment when uploadedPath is provided", async () => {
    const repo = makeRepo();
    const result = await createNote(
      {
        ...BASE_INPUT,
        uploadedPath: "path/photo.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 512,
      },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).toHaveBeenCalledOnce();
    const [att] = (repo.insertAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(att.storagePath).toBe("path/photo.jpg");
    expect(att.petId).toBe("pet-1");
    expect(att.eventId).toBe("ev-1");
  });

  it("does not insert attachment when uploadedPath is null", async () => {
    const repo = makeRepo();
    await createNote(BASE_INPUT, { repo, transaction: makeTx() });
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("returns ok:true with notifications:[] on success", async () => {
    const repo = makeRepo();
    const result = await createNote(BASE_INPUT, { repo, transaction: makeTx() });
    expect(result).toMatchObject({ ok: true, notifications: [] });
  });
});
