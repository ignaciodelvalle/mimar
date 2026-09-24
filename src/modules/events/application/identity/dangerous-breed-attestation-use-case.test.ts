// Use-case test: createDangerousBreedAttestation
//
// RED → GREEN TDD. Tests cover:
//   - Happy path: the KEYLESS plain insert + markPppReminderRead.
//   - Attachment inserted when uploadedPath provided.
//   - With a key: insertEventIdempotent instead, and never both.
//   - On a replay: the original id, and neither the attachment nor the reminder.
//   - markPppReminderRead called on every first write (spec: mark the unread
//     reminder as read).
//   - Auth parity: requireAlivePetAccess at edge.
//
// THE HEADER SAID "NOT IDEMPOTENT" AS A FLAT FACT until 2026-09-08, when the
// writer grew the key the v1 endpoint requires. Both paths are exercised here
// because "which insert does it call" is now an ANSWER TO AN INPUT, and a test
// file that describes only one of them describes a writer that no longer exists.

import { describe, expect, it, vi } from "vitest";
import type { EventsRepository } from "../../infrastructure/events-repository";
import { createDangerousBreedAttestation } from "./dangerous-breed-attestation-use-case";

// ---------------------------------------------------------------------------
// Minimal mock factory
// ---------------------------------------------------------------------------

function makeRepo(
  overrides: Partial<EventsRepository> = {},
): Pick<
  EventsRepository,
  "insertEvent" | "insertEventIdempotent" | "insertAttachment" | "markPppReminderRead"
> {
  return {
    insertEvent: vi.fn().mockResolvedValue({ id: "ev-1" }),
    // The idempotent twin answers `{ event, wasNoop }` rather than a bare row.
    // Default `wasNoop: false` so every pre-existing case keeps exercising the
    // full path; the replay case overrides it.
    insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: "ev-1" }, wasNoop: false }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    markPppReminderRead: vi.fn().mockResolvedValue(undefined),
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
  registry: "caba_4078" as const,
  registryId: "REG-001",
  attestedAt: new Date("2024-03-20"),
  notes: "Certificado vigente",
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDangerousBreedAttestation", () => {
  it("inserts event with plain insertEvent (not idempotent) and marks ppp reminder read", async () => {
    const repo = makeRepo();
    const result = await createDangerousBreedAttestation(BASE_INPUT, {
      repo,
      transaction: makeTx(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.eventId).toBe("ev-1");

    // Must use plain insertEvent, NOT insertEventIdempotent
    expect(repo.insertEvent).toHaveBeenCalledOnce();
    const [values] = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(values.eventType).toBe("dangerous_breed_attested");
    expect(values.petId).toBe("pet-1");
    // No clientIdempotencyKey — plain insert
    expect(values.clientIdempotencyKey).toBeUndefined();

    // ppp reminder read always called
    expect(repo.markPppReminderRead).toHaveBeenCalledOnce();
    const [userId, petId] = (repo.markPppReminderRead as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userId).toBe("user-1");
    expect(petId).toBe("pet-1");
  });

  it("inserts attachment when uploadedPath is provided", async () => {
    const repo = makeRepo();
    const result = await createDangerousBreedAttestation(
      {
        ...BASE_INPUT,
        uploadedPath: "path/cert.pdf",
        uploadedMimeType: "application/pdf",
        uploadedSize: 2048,
      },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).toHaveBeenCalledOnce();
    const [att] = (repo.insertAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(att.storagePath).toBe("path/cert.pdf");
    expect(att.petId).toBe("pet-1");
    expect(att.eventId).toBe("ev-1");
  });

  it("does not insert attachment when uploadedPath is null", async () => {
    const repo = makeRepo();
    await createDangerousBreedAttestation(BASE_INPUT, { repo, transaction: makeTx() });
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("payload includes registry, registry_id, attested_at in correct format", async () => {
    const repo = makeRepo();
    await createDangerousBreedAttestation(BASE_INPUT, { repo, transaction: makeTx() });

    const [values] = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = values.payload as Record<string, unknown>;
    // attestedAt is sliced to yyyy-mm-dd
    expect(payload.attested_at).toBe("2024-03-20");
    expect(payload.registry).toBe("caba_4078");
    expect(payload.registry_id).toBe("REG-001");
  });

  // -------------------------------------------------------------------------
  // THE IDEMPOTENT PATH — added 2026-09-08 with the key itself
  // -------------------------------------------------------------------------
  // `POST /api/v1/pets/{token}/events` requires an `Idempotency-Key` and
  // promises it is honoured. This kind was excluded from that endpoint on the
  // grounds that its writer could not honour one; these three cases are what
  // makes the promise true rather than merely claimed.

  it("with a key: routes through insertEventIdempotent, never the plain insert", async () => {
    const repo = makeRepo();
    const result = await createDangerousBreedAttestation(
      { ...BASE_INPUT, clientIdempotencyKey: "11111111-1111-4111-8111-111111111111" },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasDuplicate).toBe(false);
    expect(repo.insertEventIdempotent).toHaveBeenCalledTimes(1);
    // NON-VACUITY IN BOTH DIRECTIONS: a writer that called both would pass an
    // assertion written only about the first.
    expect(repo.insertEvent).not.toHaveBeenCalled();
    const [values] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(values.clientIdempotencyKey).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("without a key: keeps the plain insert — the web's form posts none", async () => {
    const repo = makeRepo();
    await createDangerousBreedAttestation(BASE_INPUT, { repo, transaction: makeTx() });

    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    expect(repo.insertEventIdempotent).not.toHaveBeenCalled();
  });

  it("on a REPLAY: returns the original id and skips the attachment and the reminder", async () => {
    // THE CASE THIS PAIRING EXISTS FOR. A careless port honours the key for the
    // event row and then re-runs everything after it: the attachment would be
    // inserted twice against one event, and a notification the person already
    // dealt with would be marked read a second time. Both live after the early
    // return, and both are asserted absent rather than assumed.
    const repo = makeRepo({
      insertEventIdempotent: vi
        .fn()
        .mockResolvedValue({ event: { id: "ev-original" }, wasNoop: true }),
    });

    const result = await createDangerousBreedAttestation(
      {
        ...BASE_INPUT,
        uploadedPath: "pets/pet-1/cert.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 1024,
        clientIdempotencyKey: "22222222-2222-4222-8222-222222222222",
      },
      { repo, transaction: makeTx() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventId).toBe("ev-original");
    expect(result.value.wasDuplicate).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
    expect(repo.markPppReminderRead).not.toHaveBeenCalled();
  });

  it("returns ok:true with notifications:[] on success", async () => {
    const repo = makeRepo();
    const result = await createDangerousBreedAttestation(BASE_INPUT, {
      repo,
      transaction: makeTx(),
    });
    expect(result).toMatchObject({ ok: true, notifications: [] });
  });
});
