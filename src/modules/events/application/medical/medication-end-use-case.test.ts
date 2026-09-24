// Unit tests for application/medical/medication-end-use-case.ts
// Spec scenarios: MEDICAL / createMedicationEnd
// Strict TDD — tests written BEFORE implementation.
//
// Auth contract: requireAlivePetAccess.
// Idempotency: insertEventIdempotent — replay skips ALL side-effects.
// FK GUARD: pre-tx verify medicationStartedEventId belongs to pet AND eventType=medication_started.
// Reminder cancel: future incomplete reminders tied to sourceEventId are cancelled.
// No outbox. No audit_log.

import { describe, expect, it, vi } from "vitest";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { type CreateMedicationEndInput, createMedicationEnd } from "./medication-end-use-case";

type FakeRepo = {
  [K in keyof EventsRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_EVENT_ID = "e0000000-0000-4000-8000-000000000006";
const SOURCE_MED_EVENT_ID = "e0000000-0000-4000-8000-000000000005";

function makeRepo(overrides: FakeRepo = {}): EventsRepository {
  return {
    findSourceMedicationEvent: vi.fn().mockResolvedValue({
      id: SOURCE_MED_EVENT_ID,
      eventType: "medication_started",
    }),
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: FAKE_EVENT_ID },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    cancelFutureReminders: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EventsRepository;
}

function makeDeps(repoOverrides: FakeRepo = {}) {
  const repo = makeRepo(repoOverrides);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb("fake-tx");
  });
  return { repo, transaction };
}

const BASE_INPUT: CreateMedicationEndInput = {
  pet: { id: "pet-1" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  medicationStartedEventId: SOURCE_MED_EVENT_ID,
  occurredAt: new Date("2024-06-10T10:00:00Z"),
  reason: "Tratamiento completado",
  notes: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "key-medend-001",
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createMedicationEnd", () => {
  it("returns ok=true and eventId on success", async () => {
    const { repo, transaction } = makeDeps();
    const result = await createMedicationEnd(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe(FAKE_EVENT_ID);
    }
  });

  it("calls insertEventIdempotent with medication_stopped eventType", async () => {
    const { repo, transaction } = makeDeps();
    await createMedicationEnd(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "medication_stopped" }),
      "fake-tx",
    );
  });

  it("calls cancelFutureReminders with the source event id", async () => {
    const { repo, transaction } = makeDeps();
    await createMedicationEnd(BASE_INPUT, { repo, transaction });
    expect(repo.cancelFutureReminders).toHaveBeenCalledWith(
      SOURCE_MED_EVENT_ID,
      expect.any(Date),
      "fake-tx",
    );
  });
});

// ---------------------------------------------------------------------------
// FK guard — pre-tx validation
// ---------------------------------------------------------------------------

describe("createMedicationEnd FK guard", () => {
  it("returns error when source event not found", async () => {
    const { repo, transaction } = makeDeps({
      findSourceMedicationEvent: vi.fn().mockResolvedValue(null),
    });
    const result = await createMedicationEnd(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Medicación de origen inválida.");
    }
  });

  it("returns error when source event is wrong type", async () => {
    const { repo, transaction } = makeDeps({
      findSourceMedicationEvent: vi.fn().mockResolvedValue({
        id: SOURCE_MED_EVENT_ID,
        eventType: "weight_recorded", // wrong type
      }),
    });
    const result = await createMedicationEnd(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Medicación de origen inválida.");
    }
  });

  it("does NOT insert event when FK guard fails", async () => {
    const { repo, transaction } = makeDeps({
      findSourceMedicationEvent: vi.fn().mockResolvedValue(null),
    });
    await createMedicationEnd(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("createMedicationEnd idempotency", () => {
  it("skips attachment and reminder cancel on noop replay", async () => {
    const { repo, transaction } = makeDeps({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: FAKE_EVENT_ID },
        wasNoop: true,
      }),
    });
    const result = await createMedicationEnd(
      {
        ...BASE_INPUT,
        uploadedPath: "uploads/med.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 100,
      },
      { repo, transaction },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
    expect(repo.cancelFutureReminders).not.toHaveBeenCalled();
  });
});
