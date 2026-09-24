// Unit tests for application/medical/sterilization-use-case.ts
// Spec scenarios: MEDICAL / createSterilization
// Strict TDD — tests written BEFORE implementation.
//
// Auth contract: requireAlivePetAccess.
// Idempotency: insertEventIdempotent — replay skips ALL side-effects.
// No outbox. No audit_log.

import { describe, expect, it, vi } from "vitest";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { type CreateSterilizationInput, createSterilization } from "./sterilization-use-case";

type FakeRepo = {
  [K in keyof EventsRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_EVENT_ID = "e0000000-0000-4000-8000-000000000004";

function makeRepo(overrides: FakeRepo = {}): EventsRepository {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: FAKE_EVENT_ID },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
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

const BASE_INPUT: CreateSterilizationInput = {
  pet: { id: "pet-1" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  procedure: "castration",
  performedBy: null,
  clinic: null,
  occurredAt: new Date("2024-06-01T10:00:00Z"),
  notes: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "key-ster-001",
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createSterilization", () => {
  it("returns ok=true and eventId on success (castration)", async () => {
    const { repo, transaction } = makeDeps();
    const result = await createSterilization(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe(FAKE_EVENT_ID);
    }
  });

  it("returns ok=true for spay procedure", async () => {
    const { repo, transaction } = makeDeps();
    const result = await createSterilization(
      { ...BASE_INPUT, procedure: "spay" },
      { repo, transaction },
    );
    expect(result.ok).toBe(true);
  });

  it("calls insertEventIdempotent with sterilization_performed eventType", async () => {
    const { repo, transaction } = makeDeps();
    await createSterilization(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sterilization_performed" }),
      "fake-tx",
    );
  });

  it("inserts attachment when uploadedPath present", async () => {
    const { repo, transaction } = makeDeps();
    await createSterilization(
      {
        ...BASE_INPUT,
        uploadedPath: "uploads/ster.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 800,
      },
      { repo, transaction },
    );
    expect(repo.insertAttachment).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("createSterilization idempotency", () => {
  it("skips attachment on noop replay", async () => {
    const { repo, transaction } = makeDeps({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: FAKE_EVENT_ID },
        wasNoop: true,
      }),
    });
    const result = await createSterilization(
      {
        ...BASE_INPUT,
        uploadedPath: "uploads/ster.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 800,
      },
      { repo, transaction },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });
});
