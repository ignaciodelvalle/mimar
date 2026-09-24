// Unit tests for application/medical/medication-dose-taken-use-case.ts
// Spec scenarios: MEDICAL / markMedicationDoseTaken
// Strict TDD — tests written BEFORE implementation.
//
// AUTH PARITY QUIRK: reminder-keyed auth (NOT requirePetAccess/requireAlivePetAccess).
//   - reminderRow.userId must equal input.userId
//   - reminderRow.reminderType must be "medication"
//   - reminderRow.completedAt must be null
//   - pet must be found via ownerships join AND status !== "deceased"
// NON-IDEMPOTENT: plain insertEvent (NOT insertEventIdempotent).
// authorRole HARD-CODED "owner" — NOT from eventAuthorship spread.
// authorOrganizationId and authorVerified NOT set (no eventAuthorship spread).
// No outbox. No audit_log.

import { describe, expect, it, vi } from "vitest";

import type { EventsRepository } from "../../infrastructure/events-repository";
import {
  type MarkMedicationDoseTakenInput,
  markMedicationDoseTaken,
} from "./medication-dose-taken-use-case";

type FakeRepo = {
  [K in keyof EventsRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_EVENT_ID = "e0000000-0000-4000-8000-000000000007";
const REMINDER_ID = "a1000000-0000-4000-8000-000000000001";
const PET_ID = "a2000000-0000-4000-8000-000000000001";
const USER_ID = "a3000000-0000-4000-8000-000000000001";

const FAKE_REMINDER = {
  id: REMINDER_ID,
  petId: PET_ID,
  userId: USER_ID,
  reminderType: "medication" as const,
  completedAt: null,
  dueAt: new Date("2024-06-01T10:00:00Z"),
  sourceEventId: "a4000000-0000-4000-8000-000000000001",
};

const FAKE_PET = {
  id: PET_ID,
  publicToken: "tok-pet-1",
  status: "active",
};

function makeRepo(overrides: FakeRepo = {}): EventsRepository {
  return {
    findReminderForUser: vi.fn().mockResolvedValue(FAKE_REMINDER),
    findOwnedAlivePetByReminder: vi.fn().mockResolvedValue(FAKE_PET),
    insertEvent: vi.fn().mockResolvedValue({ id: FAKE_EVENT_ID }),
    completeReminder: vi.fn().mockResolvedValue(undefined),
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

const BASE_INPUT: MarkMedicationDoseTakenInput = {
  reminderId: REMINDER_ID,
  userId: USER_ID,
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("markMedicationDoseTaken", () => {
  it("returns ok=true and pet publicToken on success", async () => {
    const { repo, transaction } = makeDeps();
    const result = await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.petPublicToken).toBe("tok-pet-1");
    }
  });

  it("calls insertEvent (plain) — NOT insertEventIdempotent", async () => {
    const { repo, transaction } = makeDeps();
    await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    expect(repo.insertEventIdempotent).toBeUndefined();
  });

  it("inserts medication_dose_taken event with authorRole hard-coded as 'owner'", async () => {
    const { repo, transaction } = makeDeps();
    await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(repo.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "medication_dose_taken",
        authorRole: "owner",
      }),
      "fake-tx",
    );
  });

  it("does NOT spread eventAuthorship (no authorOrganizationId/authorVerified from auth helper)", async () => {
    const { repo, transaction } = makeDeps();
    await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    const call = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // authorOrganizationId and authorVerified should NOT appear in the insert
    expect(call).not.toHaveProperty("authorOrganizationId");
    expect(call).not.toHaveProperty("authorVerified");
  });

  it("completes the reminder after inserting the event", async () => {
    const { repo, transaction } = makeDeps();
    await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(repo.completeReminder).toHaveBeenCalledWith(
      REMINDER_ID,
      PET_ID,
      expect.any(Date),
      "fake-tx",
    );
  });
});

// ---------------------------------------------------------------------------
// Auth negative paths — all throw (per spec: "not owner → throw")
// ---------------------------------------------------------------------------

describe("markMedicationDoseTaken auth failures", () => {
  it("returns error when reminder not found for user", async () => {
    const { repo, transaction } = makeDeps({
      findReminderForUser: vi.fn().mockResolvedValue(null),
    });
    const result = await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Recordatorio no encontrado/);
    }
  });

  it("returns error when reminder type is not medication", async () => {
    const { repo, transaction } = makeDeps({
      findReminderForUser: vi.fn().mockResolvedValue({
        ...FAKE_REMINDER,
        reminderType: "vaccine",
      }),
    });
    const result = await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Tipo de recordatorio inválido/);
    }
  });

  it("returns error when reminder already completed", async () => {
    const { repo, transaction } = makeDeps({
      findReminderForUser: vi.fn().mockResolvedValue({
        ...FAKE_REMINDER,
        completedAt: new Date(),
      }),
    });
    const result = await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ya fue marcada/);
    }
  });

  it("returns error when pet not found via ownership join", async () => {
    const { repo, transaction } = makeDeps({
      findOwnedAlivePetByReminder: vi.fn().mockResolvedValue(null),
    });
    const result = await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Mascota no encontrada/);
    }
  });

  it("returns error when pet is deceased", async () => {
    const { repo, transaction } = makeDeps({
      findOwnedAlivePetByReminder: vi.fn().mockResolvedValue({
        ...FAKE_PET,
        status: "deceased",
      }),
    });
    const result = await markMedicationDoseTaken(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fallecida/);
    }
  });
});
