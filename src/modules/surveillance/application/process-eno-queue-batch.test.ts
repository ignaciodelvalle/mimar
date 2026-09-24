// Unit tests for application/process-eno-queue-batch.ts (spec §G)
// Strict TDD — tests written BEFORE implementation.
//
// Critical parity items (spec §G):
//   - Drain: BATCH_SIZE=50, oldest first by queued_at
//   - retry ≤ 2: retryCount<2 → stays pending; retryCount≥2 → status='failed'
//   - audit_log (eno_notification_emitted) CONDITIONAL on vetUserId — PRESERVE EXACTLY
//   - owner notification ONLY if !stigmaSensitive AND ownerUserId !== null
//   - processOne returns false → mark processed with lastError "skipped"
//   - govt fanout: severity=urgent if critical; warning otherwise

import { describe, expect, it, vi } from "vitest";

import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import {
  type EnoBatchDeps,
  type EnoBatchResult,
  processEnoQueueBatch,
} from "./process-eno-queue-batch";

type FakeRepo = Partial<Record<keyof SurveillanceRepository, ReturnType<typeof vi.fn>>>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RABIES_DISEASE = {
  code: "rabies",
  label: "Rabia",
  severity: "critical" as const,
  notifyHours: 24,
  stigmaSensitive: false,
  legalAnchor: "Ley 22.953",
};

const BRUCELLOSIS_DISEASE = {
  code: "brucelosis_canina",
  label: "Brucelosis canina",
  severity: "high" as const,
  notifyHours: 72,
  stigmaSensitive: true, // owner NOT notified
  legalAnchor: "Res. SENASA 422/2003",
};

const LEPTOSPIROSIS_DISEASE = {
  code: "leptospirosis",
  label: "Leptospirosis",
  severity: "high" as const,
  notifyHours: 48,
  stigmaSensitive: false,
  legalAnchor: "Ley 15.465",
};

function makeQueueRow(
  overrides: Partial<{
    id: string;
    petEventId: string;
    retryCount: number;
    status: string;
  }> = {},
) {
  return {
    id: "q-1",
    petEventId: "evt-1",
    retryCount: 0,
    status: "pending",
    queuedAt: new Date("2024-01-01"),
    processedAt: null,
    lastError: null,
    ...overrides,
  };
}

function makePetEventRow(
  overrides: Partial<{
    id: string;
    petId: string;
    recordedByUserId: string | null;
    authorOrganizationId: string | null;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    id: "evt-1",
    petId: "pet-1",
    authorRole: "vet",
    recordedByUserId: "vet-user-1",
    authorOrganizationId: "org-1",
    payload: {
      sub_kind: "disease_diagnosis",
      disease_code: "rabies",
      diagnosis_date: "2024-01-01",
    },
    ...overrides,
  };
}

function makePetRow(
  overrides: Partial<{
    id: string;
    name: string;
    publicToken: string;
    jurisdictionProvince: string;
    jurisdictionLocality: string;
  }> = {},
) {
  return {
    id: "pet-1",
    name: "Firulais",
    publicToken: "pet-token-1",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...overrides,
  };
}

function makeRepo(overrides: FakeRepo = {}): SurveillanceRepository {
  return {
    pickPendingBatch: vi.fn().mockResolvedValue([makeQueueRow()]),
    findEnoEventRow: vi.fn().mockResolvedValue(makePetEventRow()),
    markEnoProcessed: vi.fn().mockResolvedValue(undefined),
    markEnoFailed: vi.fn().mockResolvedValue(undefined),
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

function makeDeps(repoOverrides: FakeRepo = {}): EnoBatchDeps {
  const repo = makeRepo(repoOverrides);
  return {
    repo,
    getPet: vi.fn().mockResolvedValue(makePetRow()),
    getOwnership: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }),
    getDisease: vi.fn().mockResolvedValue(RABIES_DISEASE),
    getGovtTargets: vi.fn().mockResolvedValue([{ userId: "govt-1" }]),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Batch mechanics
// ---------------------------------------------------------------------------

describe("processEnoQueueBatch — batch mechanics", () => {
  it("returns a result object with scannedAt, processed, failed, skipped", async () => {
    const deps = makeDeps();
    const result = await processEnoQueueBatch(deps);
    expect(result).toMatchObject<Partial<EnoBatchResult>>({
      processed: expect.any(Number),
      failed: expect.any(Number),
      skipped: expect.any(Number),
    });
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  it("calls pickPendingBatch with BATCH_SIZE=50", async () => {
    const deps = makeDeps();
    await processEnoQueueBatch(deps);
    expect(deps.repo.pickPendingBatch).toHaveBeenCalledWith(50);
  });

  it("returns processed=0 and skipped=0 and failed=0 for empty batch", async () => {
    const deps = makeDeps({
      pickPendingBatch: vi.fn().mockResolvedValue([]),
    });
    const result = await processEnoQueueBatch(deps);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("increments processed by 1 for successful row", async () => {
    const deps = makeDeps();
    const result = await processEnoQueueBatch(deps);
    expect(result.processed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// processOne — happy path: govt fanout + owner notif + audit_log
// ---------------------------------------------------------------------------

describe("processEnoQueueBatch — processOne happy path", () => {
  it("inserts notifications for govt targets and owner on non-stigma disease", async () => {
    const deps = makeDeps();
    await processEnoQueueBatch(deps);
    expect(deps.repo.insertNotifications).toHaveBeenCalled();
    const calls = (deps.repo.insertNotifications as ReturnType<typeof vi.fn>).mock.calls;
    // At least 2 calls: one for govt targets, one for owner
    const allNotifications = calls.flatMap((c: unknown[]) => c[0] as unknown[]);
    const govtNotif = (allNotifications as Array<{ notificationType: string }>).find(
      (n) => n.notificationType === "eno_disease_diagnosis",
    );
    const ownerNotif = (allNotifications as Array<{ notificationType: string }>).find(
      (n) => n.notificationType === "eno_pet_disease_diagnosis",
    );
    expect(govtNotif).toBeDefined();
    expect(ownerNotif).toBeDefined();
  });

  it("sends urgent severity for critical disease (rabies)", async () => {
    const deps = makeDeps();
    await processEnoQueueBatch(deps);
    const calls = (deps.repo.insertNotifications as ReturnType<typeof vi.fn>).mock.calls;
    const allNotifications = calls.flatMap((c: unknown[]) => c[0] as unknown[]);
    const govtNotif = (
      allNotifications as Array<{ notificationType: string; severity: string }>
    ).find((n) => n.notificationType === "eno_disease_diagnosis");
    expect(govtNotif?.severity).toBe("urgent");
  });

  it("sends warning severity for high-severity disease (leptospirosis)", async () => {
    const deps = makeDeps({
      findEnoEventRow: vi.fn().mockResolvedValue(
        makePetEventRow({
          payload: { sub_kind: "disease_diagnosis", disease_code: "leptospirosis" },
        }),
      ),
    });
    // Override getDisease to return leptospirosis
    deps.getDisease = vi.fn().mockResolvedValue(LEPTOSPIROSIS_DISEASE);

    await processEnoQueueBatch(deps);
    const calls = (deps.repo.insertNotifications as ReturnType<typeof vi.fn>).mock.calls;
    const allNotifications = calls.flatMap((c: unknown[]) => c[0] as unknown[]);
    const govtNotif = (
      allNotifications as Array<{ notificationType: string; severity: string }>
    ).find((n) => n.notificationType === "eno_disease_diagnosis");
    expect(govtNotif?.severity).toBe("warning");
  });

  it("marks row processed after successful fanout", async () => {
    const deps = makeDeps();
    await processEnoQueueBatch(deps);
    expect(deps.repo.markEnoProcessed).toHaveBeenCalledWith("q-1");
  });
});

// ---------------------------------------------------------------------------
// audit_log — UNCONDITIONAL since 2026-08-17 (spec §G parity quirk, dropped)
// ---------------------------------------------------------------------------

describe("processEnoQueueBatch — audit_log is unconditional", () => {
  it("writes audit_log when vetUserId is present", async () => {
    const deps = makeDeps({
      findEnoEventRow: vi
        .fn()
        .mockResolvedValue(makePetEventRow({ recordedByUserId: "vet-user-1" })),
    });
    await processEnoQueueBatch(deps);
    expect(deps.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "eno_notification_emitted", actorUserId: "vet-user-1" }),
    );
  });

  it("STILL writes audit_log when vetUserId is null — with a null actor", async () => {
    // This used to assert the opposite, and that assertion was the bug written
    // down as a spec. Gating the row on vetUserId deleted the ONLY trace of the
    // mandatory-notification route (Ley 15.465) in exactly the case where the
    // diagnosis had no identified clinician — so a fan-out to nobody could be
    // perfectly invisible while the queue row was marked processed and the
    // notifyHours SLA was satisfied on paper. audit_log.actor_user_id is
    // nullable by design for system writers.
    const deps = makeDeps({
      findEnoEventRow: vi.fn().mockResolvedValue(makePetEventRow({ recordedByUserId: null })),
    });
    await processEnoQueueBatch(deps);
    expect(deps.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "eno_notification_emitted", actorUserId: null }),
    );
  });

  it("audit_log payload includes disease_code, targets_count, owner_was_notified", async () => {
    const deps = makeDeps();
    await processEnoQueueBatch(deps);
    const call = (deps.insertAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(call.payload.disease_code).toBe("rabies");
    expect(typeof call.payload.targets_count).toBe("number");
    expect(typeof call.payload.owner_was_notified).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Owner notification — conditional on stigmaSensitive + ownerUserId
// ---------------------------------------------------------------------------

describe("processEnoQueueBatch — owner notification conditions", () => {
  it("does NOT notify owner when disease is stigmaSensitive", async () => {
    const deps = makeDeps({
      findEnoEventRow: vi.fn().mockResolvedValue(
        makePetEventRow({
          payload: { sub_kind: "disease_diagnosis", disease_code: "brucelosis_canina" },
        }),
      ),
    });
    deps.getDisease = vi.fn().mockResolvedValue(BRUCELLOSIS_DISEASE);

    await processEnoQueueBatch(deps);
    const calls = (deps.repo.insertNotifications as ReturnType<typeof vi.fn>).mock.calls;
    const allNotifications = calls.flatMap((c: unknown[]) => c[0] as unknown[]);
    const ownerNotif = (allNotifications as Array<{ notificationType: string }>).find(
      (n) => n.notificationType === "eno_pet_disease_diagnosis",
    );
    expect(ownerNotif).toBeUndefined();
  });

  it("does NOT notify owner when ownerUserId is null", async () => {
    const deps = makeDeps();
    deps.getOwnership = vi.fn().mockResolvedValue(null);

    await processEnoQueueBatch(deps);
    const calls = (deps.repo.insertNotifications as ReturnType<typeof vi.fn>).mock.calls;
    const allNotifications = calls.flatMap((c: unknown[]) => c[0] as unknown[]);
    const ownerNotif = (allNotifications as Array<{ notificationType: string }>).find(
      (n) => n.notificationType === "eno_pet_disease_diagnosis",
    );
    expect(ownerNotif).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// processOne returns false — skipped path
// ---------------------------------------------------------------------------

describe("processEnoQueueBatch — skipped rows", () => {
  it("increments skipped and marks row processed with lastError when event row missing", async () => {
    const deps = makeDeps({
      findEnoEventRow: vi.fn().mockResolvedValue(null),
    });
    const result = await processEnoQueueBatch(deps);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(deps.repo.markEnoProcessed).toHaveBeenCalledWith("q-1");
  });

  it("skips when payload.sub_kind is not disease_diagnosis", async () => {
    const deps = makeDeps({
      findEnoEventRow: vi
        .fn()
        .mockResolvedValue(makePetEventRow({ payload: { sub_kind: "vaccination_history" } })),
    });
    const result = await processEnoQueueBatch(deps);
    expect(result.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// retry ≤ 2 semantics (spec §G)
// ---------------------------------------------------------------------------

describe("processEnoQueueBatch — retry semantics", () => {
  it("increments failed count when processOne throws", async () => {
    const deps = makeDeps();
    // Override getPet at the deps level (not repo level)
    deps.getPet = vi.fn().mockRejectedValue(new Error("DB error"));
    const result = await processEnoQueueBatch(deps);
    expect(result.failed).toBe(1);
  });

  it("calls markEnoFailed with the queue row id when processOne throws", async () => {
    const deps = makeDeps();
    deps.getPet = vi.fn().mockRejectedValue(new Error("DB timeout"));
    await processEnoQueueBatch(deps);
    expect(deps.repo.markEnoFailed).toHaveBeenCalledWith(
      "q-1",
      expect.stringContaining("DB timeout"),
    );
  });

  it("per-row try/catch isolates failures (second row succeeds if first fails)", async () => {
    const row1 = makeQueueRow({ id: "q-1", petEventId: "evt-fail" });
    const row2 = makeQueueRow({ id: "q-2", petEventId: "evt-ok" });
    const deps = makeDeps({
      pickPendingBatch: vi.fn().mockResolvedValue([row1, row2]),
      findEnoEventRow: vi
        .fn()
        .mockResolvedValueOnce(null) // first row: event missing → skipped
        .mockResolvedValueOnce(makePetEventRow({ id: "evt-ok" })),
    });
    const result = await processEnoQueueBatch(deps);
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(1);
  });
});
