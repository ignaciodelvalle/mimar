// Shared in-memory repository double for the caretaker use-case tests.
//
// A plain object literal typed against the PORT — not a mock of the concrete
// repository. That is the whole reason the port exists: these tests run in the
// fast parallel `unit` vitest project, with no Drizzle in the import graph.

import { vi } from "vitest";

import type { CaretakersRepositoryPort, ExpirableGrant, GrantRow, PetSummary } from "../ports";

// A synthetic token, deliberately not a seeded one. Borrowing DIM-PAMP-0001
// (the real flagship pet) invites the reader to think this fixture depends
// on a seed. It does not — this repository is a fake.
export const PET: PetSummary = {
  id: "pet-1",
  publicToken: "DIM-TEST-0001",
  name: "Pampa",
  primaryPhotoStoragePath: null,
};

export const TITULAR_ID = "titular-1";
export const CARETAKER_ID = "caretaker-1";

export function makeGrant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: "grant-1",
    publicToken: "CG-abc123",
    petId: PET.id,
    grantedByUserId: TITULAR_ID,
    caretakerUserId: null,
    caretakerEmail: "ana@example.com",
    status: "pending",
    startsAt: new Date("2026-08-20T00:00:00Z"),
    endsAt: new Date("2026-09-15T00:00:00Z"),
    note: null,
    ownershipId: null,
    reminderSentAt: null,
    publicContactConsentAt: null,
    ...overrides,
  };
}

export function makeAcceptedGrant(overrides: Partial<GrantRow> = {}): ExpirableGrant {
  return makeGrant({
    status: "accepted",
    caretakerUserId: CARETAKER_ID,
    ownershipId: "own-1",
    ...overrides,
  }) as ExpirableGrant;
}

export type FakeRepo = CaretakersRepositoryPort & {
  [K in keyof CaretakersRepositoryPort]: ReturnType<typeof vi.fn>;
};

export function makeFakeRepo(overrides: Partial<Record<string, unknown>> = {}): FakeRepo {
  const base = {
    findGrantByToken: vi.fn().mockResolvedValue(null),
    // The locked re-read defaults to "the row is still there and still
    // accepted", because that is the boring case every write path assumes.
    // Tests that care about losing the race override it with a moved status —
    // and there are several, so the default is not hiding the guard.
    findGrantByIdForUpdate: vi
      .fn()
      .mockImplementation(async (grantId: string) => makeAcceptedGrant({ id: grantId })),
    findOpenGrantsForPet: vi.fn().mockResolvedValue([]),
    listGrantsForUser: vi.fn().mockResolvedValue([]),
    findLastEndedGrantForPet: vi.fn().mockResolvedValue(null),
    findPetSummaryById: vi.fn().mockResolvedValue(PET),
    // Defaults to "the person who invited is still the titular", because that
    // is the boring case. The tests that care about a change of hands override
    // it with `false`.
    hasLiveTitularOwnership: vi.fn().mockResolvedValue(true),
    findUserIdByEmail: vi.fn().mockResolvedValue(null),
    findDisplayName: vi.fn().mockResolvedValue("Ana Pérez"),
    findEmailByUserId: vi.fn().mockResolvedValue("ana@example.com"),
    findExpirableInvitations: vi.fn().mockResolvedValue([]),
    findExpirableGrants: vi.fn().mockResolvedValue([]),
    findGrantsNeedingReminder: vi.fn().mockResolvedValue([]),
    markReminderSent: vi.fn().mockResolvedValue(1),
    insertGrant: vi.fn().mockResolvedValue({ id: "grant-1", publicToken: "CG-abc123" }),
    updateGrantStatus: vi.fn().mockResolvedValue(1),
    insertAcceptGrant: vi.fn().mockResolvedValue({ ownershipId: "own-1" }),
    insertEndGrant: vi.fn().mockResolvedValue({ ended: true }),
    ...overrides,
  };
  return base as unknown as FakeRepo;
}

/** A `db.transaction`-shaped double that just runs the callback. */
export function fakeTransaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
  return cb({ __tx: true });
}
