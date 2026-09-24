// Unit tests for application/medical/medication-start-use-case.ts
// Spec scenarios: MEDICAL / createMedicationStart
// Strict TDD — tests written BEFORE implementation.
//
// Auth contract: requireAlivePetAccess.
// Idempotency: insertEventIdempotent — replay skips ALL side-effects incl. dose reminders.
// No outbox. No audit_log.

import { describe, expect, it, vi } from "vitest";

import type { EventsRepository } from "../../infrastructure/events-repository";
import {
  type CreateMedicationStartInput,
  createMedicationStart,
} from "./medication-start-use-case";

type FakeRepo = {
  [K in keyof EventsRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_EVENT_ID = "e0000000-0000-4000-8000-000000000005";

function makeRepo(overrides: FakeRepo = {}): EventsRepository {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: FAKE_EVENT_ID },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    insertReminders: vi.fn().mockResolvedValue(undefined),
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

const BASE_INPUT: CreateMedicationStartInput = {
  pet: { id: "pet-1", name: "Firulais" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  drugName: "Amoxicilina",
  dose: "500mg",
  prescribedBy: null,
  occurredAt: new Date("2024-06-01T10:00:00Z"),
  notes: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "key-medstart-001",
  // Schedule-resolved fields (pre-resolved by caller from parseFrequencyFields + generateDoseSchedule)
  frequency: "twice_daily",
  customHours: null,
  durationDays: 7,
  firstDoseAt: new Date("2024-06-01T10:00:00Z"),
  schedule: [
    new Date("2024-06-01T10:00:00Z"),
    new Date("2024-06-01T22:00:00Z"),
    new Date("2024-06-02T10:00:00Z"),
  ],
  matchedDrugCode: null,
  frequencyLabel: "2 veces al día",
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createMedicationStart", () => {
  it("returns ok=true and eventId on success", async () => {
    const { repo, transaction } = makeDeps();
    const result = await createMedicationStart(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe(FAKE_EVENT_ID);
    }
  });

  it("calls insertEventIdempotent with medication_started eventType", async () => {
    const { repo, transaction } = makeDeps();
    await createMedicationStart(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "medication_started" }),
      "fake-tx",
    );
  });

  it("includes schedule_count in payload", async () => {
    const { repo, transaction } = makeDeps();
    await createMedicationStart(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ schedule_count: 3 }),
      }),
      "fake-tx",
    );
  });

  it("inserts dose reminders for each scheduled slot", async () => {
    const { repo, transaction } = makeDeps();
    await createMedicationStart(BASE_INPUT, { repo, transaction });
    expect(repo.insertReminders).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ reminderType: "medication" })]),
      "fake-tx",
    );
    const call = (repo.insertReminders as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toHaveLength(3);
  });

  it("does NOT insert reminders when schedule is empty", async () => {
    const { repo, transaction } = makeDeps();
    await createMedicationStart({ ...BASE_INPUT, schedule: [] }, { repo, transaction });
    expect(repo.insertReminders).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency — replay skips reminders
// ---------------------------------------------------------------------------

describe("createMedicationStart idempotency", () => {
  it("skips attachment and dose reminders on noop replay", async () => {
    const { repo, transaction } = makeDeps({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: FAKE_EVENT_ID },
        wasNoop: true,
      }),
    });
    const result = await createMedicationStart(
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
    expect(repo.insertReminders).not.toHaveBeenCalled();
  });
});
