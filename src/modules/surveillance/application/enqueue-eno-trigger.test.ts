// Unit tests for application/enqueue-eno-trigger.ts (spec §F)
// Strict TDD — tests written BEFORE implementation.
//
// Scenario §F: processEnoEventTrigger (enqueue)
//   - only enqueues when sub_kind='disease_diagnosis' AND diseaseCode isEnoCode
//   - onConflictDoNothing idempotency (returns null on re-enqueue)
//   - returns silently on non-diagnosis / non-ENO
//   - NEVER throws (log+swallow)

import { describe, expect, it, vi } from "vitest";

import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import { enqueueEnoTrigger } from "./enqueue-eno-trigger";

type FakeRepo = Partial<Record<keyof SurveillanceRepository, ReturnType<typeof vi.fn>>>;

function makeRepo(overrides: FakeRepo = {}): SurveillanceRepository {
  return {
    insertEnoQueueRow: vi.fn().mockResolvedValue({ id: "q-1", petEventId: "evt-1" }),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

const DISEASE_DIAGNOSIS_EVENT = {
  id: "evt-1",
  petId: "pet-1",
  authorRole: "vet",
  recordedByUserId: "vet-user-1",
  authorOrganizationId: "org-1",
  payload: {
    sub_kind: "disease_diagnosis",
    disease_code: "rabies_confirmed", // bridge code → "rabies"
  },
};

const NON_DIAGNOSIS_EVENT = {
  id: "evt-2",
  petId: "pet-1",
  authorRole: "vet",
  recordedByUserId: "vet-user-1",
  authorOrganizationId: null,
  payload: {
    sub_kind: "vaccination_history",
    disease_code: "rabies_confirmed",
  },
};

const NON_ENO_EVENT = {
  id: "evt-3",
  petId: "pet-1",
  authorRole: "vet",
  recordedByUserId: "vet-user-1",
  authorOrganizationId: null,
  payload: {
    sub_kind: "disease_diagnosis",
    disease_code: "parvovirus", // not in ENO catalog
  },
};

// ---------------------------------------------------------------------------
// Happy path — enqueues valid ENO disease diagnosis events
// ---------------------------------------------------------------------------

describe("enqueueEnoTrigger — happy path", () => {
  it("calls insertEnoQueueRow for a valid disease_diagnosis ENO event", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo });
    expect(repo.insertEnoQueueRow).toHaveBeenCalledWith("evt-1");
  });

  it("works with direct ENO code (rabies, no bridge needed)", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(
      {
        ...DISEASE_DIAGNOSIS_EVENT,
        id: "evt-direct",
        payload: { sub_kind: "disease_diagnosis", disease_code: "rabies" },
      },
      { repo },
    );
    expect(repo.insertEnoQueueRow).toHaveBeenCalledWith("evt-direct");
  });

  it("works with leptospirosis disease code", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(
      {
        ...DISEASE_DIAGNOSIS_EVENT,
        id: "evt-lepto",
        payload: { sub_kind: "disease_diagnosis", disease_code: "leptospirosis" },
      },
      { repo },
    );
    expect(repo.insertEnoQueueRow).toHaveBeenCalledWith("evt-lepto");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — onConflictDoNothing (returns null on re-enqueue)
// ---------------------------------------------------------------------------

describe("enqueueEnoTrigger — idempotency", () => {
  it("returns undefined even when insertEnoQueueRow returns null (conflict no-op)", async () => {
    const repo = makeRepo({
      insertEnoQueueRow: vi.fn().mockResolvedValue(null),
    });
    // Should not throw
    const result = await enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo });
    expect(result).toBeUndefined();
  });

  it("calls insertEnoQueueRow once per invocation (idempotent at the repo level)", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo });
    await enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo });
    // Second call hits the DB, but DB handles conflict — we always call repo
    expect(repo.insertEnoQueueRow).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Early exits — non-diagnosis / non-ENO events
// ---------------------------------------------------------------------------

describe("enqueueEnoTrigger — early exits", () => {
  it("does NOT call insertEnoQueueRow when sub_kind !== 'disease_diagnosis'", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(NON_DIAGNOSIS_EVENT, { repo });
    expect(repo.insertEnoQueueRow).not.toHaveBeenCalled();
  });

  it("does NOT call insertEnoQueueRow when disease_code is not in ENO catalog", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(NON_ENO_EVENT, { repo });
    expect(repo.insertEnoQueueRow).not.toHaveBeenCalled();
  });

  it("does NOT call insertEnoQueueRow when disease_code is missing from payload", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(
      {
        ...DISEASE_DIAGNOSIS_EVENT,
        payload: { sub_kind: "disease_diagnosis" },
      },
      { repo },
    );
    expect(repo.insertEnoQueueRow).not.toHaveBeenCalled();
  });

  it("does NOT call insertEnoQueueRow when payload.disease_code is not a string", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(
      {
        ...DISEASE_DIAGNOSIS_EVENT,
        payload: { sub_kind: "disease_diagnosis", disease_code: 42 },
      },
      { repo },
    );
    expect(repo.insertEnoQueueRow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error swallowing — post-commit mode (no executor) NEVER throws (spec §F)
// ---------------------------------------------------------------------------

describe("enqueueEnoTrigger — error swallowing (post-commit mode)", () => {
  it("swallows errors from insertEnoQueueRow and resolves undefined", async () => {
    const repo = makeRepo({
      insertEnoQueueRow: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    // Must not throw
    await expect(enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// In-transaction mode (executor set) — durability (V1-4 / P1-3)
// ---------------------------------------------------------------------------

describe("enqueueEnoTrigger — in-transaction mode", () => {
  it("passes the executor (tx) through to insertEnoQueueRow", async () => {
    const repo = makeRepo();
    const tx = Symbol("tx");
    await enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo, executor: tx });
    expect(repo.insertEnoQueueRow).toHaveBeenCalledWith("evt-1", tx);
  });

  it("PROPAGATES errors when running in a transaction (so the tx rolls back)", async () => {
    // Durability: a real enqueue failure inside the diagnosis tx must NOT be
    // swallowed — it has to bubble up so the whole diagnosis rolls back.
    const repo = makeRepo({
      insertEnoQueueRow: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    await expect(
      enqueueEnoTrigger(DISEASE_DIAGNOSIS_EVENT, { repo, executor: Symbol("tx") }),
    ).rejects.toThrow("DB down");
  });

  it("still no-ops (no insert) for non-ENO events even with an executor", async () => {
    const repo = makeRepo();
    await enqueueEnoTrigger(NON_ENO_EVENT, { repo, executor: Symbol("tx") });
    expect(repo.insertEnoQueueRow).not.toHaveBeenCalled();
  });
});
