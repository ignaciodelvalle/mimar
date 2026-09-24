// Unit tests for application/medical/vaccination-use-case.ts
// Spec scenarios: MEDICAL / createVaccination
// Strict TDD — tests written BEFORE implementation.
//
// Auth contract: requireAlivePetAccess (asserted via happy/negative paths).
// Idempotency: insertEventIdempotent — replay (wasNoop=true) skips ALL side-effects.
// No outbox. No audit_log.
//
// Dependencies are mocked via vitest.fn(). No DB needed.

import { describe, expect, it, vi } from "vitest";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { type CreateVaccinationInput, createVaccination } from "./vaccination-use-case";

// ---------------------------------------------------------------------------
// Minimal fake repo
// ---------------------------------------------------------------------------

type FakeRepo = {
  [K in keyof EventsRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_EVENT_ID = "e0000000-0000-4000-8000-000000000001";

function makeRepo(overrides: FakeRepo = {}): EventsRepository {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: FAKE_EVENT_ID },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    completeReminder: vi.fn().mockResolvedValue(undefined),
    insertReminders: vi.fn().mockResolvedValue(undefined),
    findOpenReminders: vi.fn().mockResolvedValue([]),
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

const BASE_INPUT: CreateVaccinationInput = {
  pet: { id: "pet-1" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  vaccineName: "Antirrábica",
  occurredAt: new Date("2024-06-01T10:00:00Z"),
  brand: null,
  batch: null,
  administeredBy: null,
  nextDueAt: null,
  notes: null,
  sourceReminderId: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "key-vac-001",
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createVaccination", () => {
  it("returns ok=true and eventId on successful vaccination", async () => {
    const { repo, transaction } = makeDeps();
    const result = await createVaccination(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe(FAKE_EVENT_ID);
    }
  });

  it("calls insertEventIdempotent with correct eventType", async () => {
    const { repo, transaction } = makeDeps();
    await createVaccination(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "vaccination_administered" }),
      "fake-tx",
    );
  });

  it("inserts attachment when uploadedPath is present", async () => {
    const { repo, transaction } = makeDeps();
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      uploadedPath: "uploads/vac.jpg",
      uploadedMimeType: "image/jpeg",
      uploadedSize: 1000,
    };
    await createVaccination(input, { repo, transaction });
    expect(repo.insertAttachment).toHaveBeenCalledTimes(1);
  });

  it("does NOT insert attachment when uploadedPath is null", async () => {
    const { repo, transaction } = makeDeps();
    await createVaccination(BASE_INPUT, { repo, transaction });
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });

  it("completes sourceReminder when sourceReminderId provided", async () => {
    const { repo, transaction } = makeDeps();
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      sourceReminderId: "reminder-1",
    };
    await createVaccination(input, { repo, transaction });
    expect(repo.completeReminder).toHaveBeenCalledWith(
      "reminder-1",
      "pet-1",
      expect.any(Date),
      "fake-tx",
    );
  });

  it("inserts vaccine reminder when nextDueAt is provided", async () => {
    const { repo, transaction } = makeDeps();
    const nextDueAt = new Date("2025-06-01T10:00:00Z");
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      nextDueAt,
    };
    await createVaccination(input, { repo, transaction });
    expect(repo.insertReminders).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ reminderType: "vaccine", dueAt: nextDueAt }),
      ]),
      "fake-tx",
    );
  });

  it("does NOT insert reminder when nextDueAt is null", async () => {
    const { repo, transaction } = makeDeps();
    await createVaccination(BASE_INPUT, { repo, transaction });
    expect(repo.insertReminders).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Duplicate reminder supersede (case/accent-insensitive title match)
// ---------------------------------------------------------------------------

describe("createVaccination duplicate reminder supersede", () => {
  it("completes an existing open vaccine reminder with a different-case title", async () => {
    const { repo, transaction } = makeDeps({
      findOpenReminders: vi
        .fn()
        .mockResolvedValue([{ id: "reminder-old", title: "Refuerzo: Antirrábica" }]),
    });
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      vaccineName: "antirrábica",
      nextDueAt: new Date("2025-06-01T10:00:00Z"),
    };
    await createVaccination(input, { repo, transaction });
    expect(repo.completeReminder).toHaveBeenCalledWith(
      "reminder-old",
      "pet-1",
      expect.any(Date),
      "fake-tx",
    );
    expect(repo.insertReminders).toHaveBeenCalledTimes(1);
  });

  it("completes an existing open vaccine reminder with a diacritic-only difference", async () => {
    const { repo, transaction } = makeDeps({
      findOpenReminders: vi
        .fn()
        .mockResolvedValue([{ id: "reminder-old", title: "refuerzo: antirrabica" }]),
    });
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      vaccineName: "Antirrábica",
      nextDueAt: new Date("2025-06-01T10:00:00Z"),
    };
    await createVaccination(input, { repo, transaction });
    expect(repo.completeReminder).toHaveBeenCalledWith(
      "reminder-old",
      "pet-1",
      expect.any(Date),
      "fake-tx",
    );
  });

  it("does NOT touch an open reminder for a different vaccine", async () => {
    const { repo, transaction } = makeDeps({
      findOpenReminders: vi
        .fn()
        .mockResolvedValue([{ id: "reminder-other", title: "Refuerzo: Triple felina" }]),
    });
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      vaccineName: "Antirrábica",
      nextDueAt: new Date("2025-06-01T10:00:00Z"),
    };
    await createVaccination(input, { repo, transaction });
    expect(repo.completeReminder).not.toHaveBeenCalled();
    expect(repo.insertReminders).toHaveBeenCalledTimes(1);
  });

  it("does NOT double-complete the reminder already resolved via sourceReminderId", async () => {
    const { repo, transaction } = makeDeps({
      findOpenReminders: vi
        .fn()
        .mockResolvedValue([{ id: "reminder-1", title: "Refuerzo: Antirrábica" }]),
    });
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      vaccineName: "Antirrábica",
      sourceReminderId: "reminder-1",
      nextDueAt: new Date("2025-06-01T10:00:00Z"),
    };
    await createVaccination(input, { repo, transaction });
    // Once for the explicit sourceReminderId completion, not twice for the
    // duplicate-match pass (it's excluded by id).
    expect(repo.completeReminder).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — wasNoop=true skips ALL side-effects
// ---------------------------------------------------------------------------

describe("createVaccination idempotency", () => {
  it("returns ok=true but skips attachment, reminder, completeReminder on noop", async () => {
    const { repo, transaction } = makeDeps({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: FAKE_EVENT_ID },
        wasNoop: true,
      }),
    });
    const input: CreateVaccinationInput = {
      ...BASE_INPUT,
      uploadedPath: "uploads/vac.jpg",
      uploadedMimeType: "image/jpeg",
      uploadedSize: 1000,
      sourceReminderId: "reminder-1",
      nextDueAt: new Date("2025-06-01T10:00:00Z"),
    };
    const result = await createVaccination(input, { repo, transaction });
    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
    expect(repo.completeReminder).not.toHaveBeenCalled();
    expect(repo.insertReminders).not.toHaveBeenCalled();
  });
});
