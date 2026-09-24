// Unit tests for application/medical/weight-use-case.ts
// Spec scenarios: MEDICAL / createWeight
// Strict TDD — tests written BEFORE implementation.
//
// Auth contract: requireAlivePetAccess.
// Idempotency: insertEventIdempotent — replay skips ALL side-effects incl. weight projection.
// PROJECTION: pets.estimatedWeightKg updated ONLY on non-noop.
// No outbox. No audit_log.

import { describe, expect, it, vi } from "vitest";

import type { EventsRepository } from "../../infrastructure/events-repository";
import { type CreateWeightInput, createWeight } from "./weight-use-case";

type FakeRepo = {
  [K in keyof EventsRepository]?: ReturnType<typeof vi.fn>;
};

const FAKE_EVENT_ID = "e0000000-0000-4000-8000-000000000002";

function makeRepo(overrides: FakeRepo = {}): EventsRepository {
  return {
    insertEventIdempotent: vi.fn().mockResolvedValue({
      event: { id: FAKE_EVENT_ID },
      wasNoop: false,
    }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    updateWeightProjection: vi.fn().mockResolvedValue(undefined),
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

const BASE_INPUT: CreateWeightInput = {
  pet: { id: "pet-1" },
  user: { id: "user-1" },
  eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
  kgStr: "4.50",
  occurredAt: new Date("2024-06-01T10:00:00Z"),
  notes: null,
  uploadedPath: null,
  uploadedMimeType: null,
  uploadedSize: null,
  clientIdempotencyKey: "key-wt-001",
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("createWeight", () => {
  it("returns ok=true and eventId on success", async () => {
    const { repo, transaction } = makeDeps();
    const result = await createWeight(BASE_INPUT, { repo, transaction });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventId).toBe(FAKE_EVENT_ID);
    }
  });

  it("calls insertEventIdempotent with weight_recorded eventType and kgStr payload", async () => {
    const { repo, transaction } = makeDeps();
    await createWeight(BASE_INPUT, { repo, transaction });
    expect(repo.insertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "weight_recorded",
        payload: expect.objectContaining({ kg: "4.50" }),
      }),
      "fake-tx",
    );
  });

  it("calls updateWeightProjection for the pet, inside the transaction", async () => {
    // No kg argument: the projection re-derives the value from the spine rather
    // than trusting the caller's number, so a back-dated weighing cannot make
    // the cache contradict the event log (audit finding #4, 2026-08-12).
    const { repo, transaction } = makeDeps();
    await createWeight(BASE_INPUT, { repo, transaction });
    expect(repo.updateWeightProjection).toHaveBeenCalledWith("pet-1", expect.any(Date), "fake-tx");
  });

  it("inserts attachment when uploadedPath present", async () => {
    const { repo, transaction } = makeDeps();
    await createWeight(
      {
        ...BASE_INPUT,
        uploadedPath: "uploads/wt.jpg",
        uploadedMimeType: "image/jpeg",
        uploadedSize: 512,
      },
      { repo, transaction },
    );
    expect(repo.insertAttachment).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — projection skipped on wasNoop=true
// ---------------------------------------------------------------------------

describe("createWeight idempotency", () => {
  it("skips projection and attachment on noop replay", async () => {
    const { repo, transaction } = makeDeps({
      insertEventIdempotent: vi.fn().mockResolvedValue({
        event: { id: FAKE_EVENT_ID },
        wasNoop: true,
      }),
    });
    const input: CreateWeightInput = {
      ...BASE_INPUT,
      uploadedPath: "uploads/wt.jpg",
      uploadedMimeType: "image/jpeg",
      uploadedSize: 512,
    };
    const result = await createWeight(input, { repo, transaction });
    expect(result.ok).toBe(true);
    expect(repo.updateWeightProjection).not.toHaveBeenCalled();
    expect(repo.insertAttachment).not.toHaveBeenCalled();
  });
});
