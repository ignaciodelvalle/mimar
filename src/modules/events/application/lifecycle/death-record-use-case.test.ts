// Test: createDeathRecord (WU-6 lifecycle — HIGHEST RISK multi-cascade)
//
// TDD RED phase — tests written BEFORE implementation.
// Parity contract: byte-for-byte behavior vs app/actions/events.ts::createDeathRecordAction.
//
// Invariants under test:
//   - IDEMPOTENT insert (insertEventIdempotent). On noop: cascades SKIPPED entirely.
//   - pets projection: status=deceased + deceasedAt.
//   - CASCADE A: auto-end active fosters → foster_ended events + pendingNotifications + close foster_placement case.
//   - CASCADE B: close custody_episode if present.
//   - CASCADE C: wasInObservation → insert rabies_observation_ended + close bite_incident + pets.rabiesObservationStatus=completed_dead.
//   - Post-tx: flushNotifications + signalAuthorityReport (if reportable) + urgent authority fan-out (if rabiesObservationClosed).
//   - Result: { ok: true, rabiesObservationClosed, diseaseCode, insertedEventId }
//   - IDEMPOTENCY NOOP: result.ok=true but no cascades triggered.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockValidateEventPayload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/events/event-schemas", () => ({
  validateEventPayload: mockValidateEventPayload,
}));

const mockCloseCase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/case-helpers", () => ({
  closeCase: mockCloseCase,
  openCase: vi.fn(),
  findOpenCaseForPetAndKind: vi.fn(),
}));

// CASCADE D (rehome-by-titular, tasks 7.4): the death of a SPONSORED pet ends
// the sponsorship in the same transaction. The helper lives in lib/infra (same
// placement as closeCase above); the use-case turns what it hands back into
// the notifications the org's admins and the applicants receive.
const mockEndSponsorshipForDeceasedPet = vi.hoisted(() => vi.fn());
const mockLockPetForDeathRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/rehome-death-cascade", () => ({
  endSponsorshipForDeceasedPet: mockEndSponsorshipForDeceasedPet,
  lockPetForDeathRecord: mockLockPetForDeathRecord,
}));

const mockSignalAuthorityReport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain/authority", () => ({
  signalAuthorityReport: mockSignalAuthorityReport,
}));

const mockFindAuthoritiesForJurisdiction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/approval-routing", () => ({
  findAuthoritiesForJurisdiction: mockFindAuthoritiesForJurisdiction,
}));

// The urgent authority fan-out goes through the durable notification service
// (dedupe key + dead-letter); mock it so the rows (title/body/key) are
// assertable without a DB.
const mockNotificationValues = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ insertedCount: 1, duplicateCount: 0, deadLetteredCount: 0 }),
);
vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: mockNotificationValues,
}));

// The national-admin fallback, used only when the jurisdiction lookup throws.
const mockActiveHumanInstitutionalAdminIds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/notification-recipients", () => ({
  activeHumanInstitutionalAdminIds: mockActiveHumanInstitutionalAdminIds,
}));

vi.mock("@/db", () => ({ db: {}, notifications: {} }));

import type { EventsRepository } from "../../infrastructure/events-repository";
import { createDeathRecord } from "./death-record-use-case";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RepoLike = Pick<
  EventsRepository,
  | "insertEventIdempotent"
  | "insertEvent"
  | "insertAttachment"
  | "updateDeceased"
  | "findActiveFosters"
  | "endFoster"
  | "findLatestRabiesObservationStarted"
  | "updateRabiesObservationStatus"
  | "updateStatusProjection"
>;

function makeRepo(overrides: Partial<RepoLike> = {}): RepoLike {
  return {
    insertEventIdempotent: vi
      .fn()
      .mockResolvedValue({ event: { id: randomUUID() }, wasNoop: false }),
    insertEvent: vi.fn().mockResolvedValue({ id: randomUUID() }),
    insertAttachment: vi.fn().mockResolvedValue(undefined),
    updateDeceased: vi.fn().mockResolvedValue(undefined),
    findActiveFosters: vi.fn().mockResolvedValue([]),
    endFoster: vi.fn().mockResolvedValue(undefined),
    findLatestRabiesObservationStarted: vi.fn().mockResolvedValue(null),
    updateRabiesObservationStatus: vi.fn().mockResolvedValue(undefined),
    updateStatusProjection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTransaction() {
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
}

const petId = randomUUID();
const userId = randomUUID();
const eventId = randomUUID();
const caseId = randomUUID();

const basePet = {
  id: petId,
  name: "Buddy",
  status: "active",
  rabiesObservationStatus: null as string | null,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
};

const baseInput = {
  pet: basePet,
  recordedByUserId: userId,
  eventAuthorship: {
    authorRole: "owner" as const,
    authorOrganizationId: null as string | null,
    authorVerified: false,
  },
  cause: "natural",
  causeDetail: null as string | null,
  confirmedByVet: false,
  vetName: null as string | null,
  dispositionMethod: null as string | null,
  facility: null as string | null,
  occurredAt: new Date("2026-06-01T10:00:00Z"),
  notes: null as string | null,
  deathAtClinic: false,
  clinicName: null as string | null,
  vetContactedOwner: null as string | null,
  vetDecidedAlone: false,
  ownerToPrivateCrematorium: false,
  diseaseCode: null as string | null,
  confirmedByLab: false,
  uploadedPath: null as string | null,
  uploadedMimeType: null as string | null,
  uploadedSize: null as number | null,
  clientIdempotencyKey: null as string | null,
  custodyEpisodeCaseId: null as string | null,
  now: new Date("2026-06-01T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDeathRecord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateEventPayload.mockImplementation((_type: string, payload: unknown) => payload);
    mockCloseCase.mockResolvedValue(undefined);
    mockEndSponsorshipForDeceasedPet.mockResolvedValue(null);
    mockLockPetForDeathRecord.mockResolvedValue(undefined);
    mockSignalAuthorityReport.mockResolvedValue(undefined);
    mockFindAuthoritiesForJurisdiction.mockResolvedValue([]);
  });

  it("inserts death_recorded event and updates pets.status=deceased", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(baseInput, {
      repo,
      transaction: tx,
      flushNotifications: flush,
    });

    expect(result.ok).toBe(true);
    expect(repo.insertEventIdempotent).toHaveBeenCalledTimes(1);
    const [arg] = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(arg.eventType).toBe("death_recorded");
    expect(repo.updateDeceased).toHaveBeenCalledWith(
      petId,
      baseInput.occurredAt,
      baseInput.now,
      expect.anything(),
    );
  });

  it("skips all cascades when idempotency noop", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: eventId }, wasNoop: true }),
    });
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(baseInput, {
      repo,
      transaction: tx,
      flushNotifications: flush,
    });

    expect(result.ok).toBe(true);
    expect(repo.updateDeceased).not.toHaveBeenCalled();
    expect(repo.findActiveFosters).not.toHaveBeenCalled();
    expect(repo.findLatestRabiesObservationStarted).not.toHaveBeenCalled();
    // flush still called (with empty array)
    expect(flush).toHaveBeenCalled();
  });

  it("CASCADE A: ends active fosters, inserts foster_ended event, and closes foster_placement case", async () => {
    const fosterId = randomUUID();
    const fosterUserId = randomUUID();
    const fosterCaseId = randomUUID();
    const deathEventId = randomUUID();

    const repo = makeRepo({
      insertEventIdempotent: vi
        .fn()
        .mockResolvedValue({ event: { id: deathEventId }, wasNoop: false }),
      findActiveFosters: vi.fn().mockResolvedValue([{ id: fosterId, ownerUserId: fosterUserId }]),
    });
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(
      {
        ...baseInput,
        fosterCaseId,
      },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(result.ok).toBe(true);

    // endFoster called
    expect(repo.endFoster).toHaveBeenCalledWith(fosterId, baseInput.now, expect.anything());

    // foster_ended event inserted
    const insertCalls = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls as [
      Record<string, unknown>,
      unknown,
    ][];
    const fosterEndedCall = insertCalls.find(([arg]) => arg.eventType === "foster_ended");
    expect(fosterEndedCall).toBeDefined();
    const fosterEndedPayload = fosterEndedCall![0].payload as Record<string, unknown>;
    expect(fosterEndedPayload.reason).toBe("pet_died");
    expect(fosterEndedPayload.death_event_id).toBe(deathEventId);

    // closeCase for foster_placement
    expect(mockCloseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: fosterCaseId }),
      expect.anything(),
    );

    // flush called with foster notification
    const flushArg = flush.mock.calls[0][0] as { notificationType: string; userId: string }[];
    const fosterNotif = flushArg.find((n) => n.notificationType === "foster_ended_by_death");
    expect(fosterNotif?.userId).toBe(fosterUserId);
  });

  it("CASCADE B: closes custody_episode when custodyEpisodeCaseId provided", async () => {
    const custodyCaseId = randomUUID();
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    await createDeathRecord(
      { ...baseInput, custodyEpisodeCaseId: custodyCaseId },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(mockCloseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: custodyCaseId }),
      expect.anything(),
    );
  });

  it("CASCADE B: skips custody close when no custodyEpisodeCaseId", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    await createDeathRecord(
      { ...baseInput, custodyEpisodeCaseId: null },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(mockCloseCase).not.toHaveBeenCalled();
  });

  it("CASCADE C: inserts rabies_observation_ended + closes bite_incident + updates rabiesObservationStatus when wasInObservation", async () => {
    const startedEventId = randomUUID();
    const biteCaseId = randomUUID();
    const deathEventId = randomUUID();

    const repo = makeRepo({
      insertEventIdempotent: vi
        .fn()
        .mockResolvedValue({ event: { id: deathEventId }, wasNoop: false }),
      findLatestRabiesObservationStarted: vi.fn().mockResolvedValue({
        id: startedEventId,
        payload: { bite_event_id: randomUUID() },
      }),
    });
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(
      {
        ...baseInput,
        pet: { ...basePet, rabiesObservationStatus: "in_progress" },
        biteCaseId,
      },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rabiesObservationClosed).toBe(true);
    }

    // rabies_observation_ended inserted
    const insertCalls = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls as [
      Record<string, unknown>,
      unknown,
    ][];
    const rabiesEndedCall = insertCalls.find(
      ([arg]) => arg.eventType === "rabies_observation_ended",
    );
    expect(rabiesEndedCall).toBeDefined();
    const rabiesPayload = rabiesEndedCall![0].payload as Record<string, unknown>;
    expect(rabiesPayload.outcome).toBe("dead");
    expect(rabiesPayload.closed_by_role).toBe("system");
    expect(rabiesPayload.death_event_id).toBe(deathEventId);

    // bite_incident case closed
    expect(mockCloseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: biteCaseId }),
      expect.anything(),
    );

    // rabiesObservationStatus updated
    expect(repo.updateRabiesObservationStatus).toHaveBeenCalledWith(
      petId,
      "completed_dead",
      baseInput.now,
      expect.anything(),
    );

    // urgent authority fan-out attempted post-tx
    mockFindAuthoritiesForJurisdiction.mockResolvedValue(["auth-user-1"]);
  });

  it("CASCADE C: skips rabies cascade when not wasInObservation", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(
      { ...baseInput, pet: { ...basePet, rabiesObservationStatus: null } },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rabiesObservationClosed).toBe(false);
    }
    expect(repo.findLatestRabiesObservationStarted).not.toHaveBeenCalled();
  });

  it("calls signalAuthorityReport post-tx when disease is reportable", async () => {
    const deathEventId = randomUUID();
    const repo = makeRepo({
      insertEventIdempotent: vi
        .fn()
        .mockResolvedValue({ event: { id: deathEventId }, wasNoop: false }),
    });
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    await createDeathRecord(
      {
        ...baseInput,
        diseaseCode: "rabies_confirmed",
        confirmedByLab: true,
        isReportable: true,
      },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(mockSignalAuthorityReport).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: deathEventId, diseaseCode: "rabies_confirmed" }),
    );
  });

  // G7 (2026-08-02): the authority signal is no longer a silent void no-op.
  // The use-case passes the recording actor (for the pending-transmission
  // audit row) and surfaces the honest { delivered: false, v1_noop } marker
  // in its own result so no downstream can pretend the report was sent.
  it("passes the recording actor and surfaces the honest authoritySignal marker", async () => {
    mockSignalAuthorityReport.mockResolvedValue({
      delivered: false,
      v1_noop: true,
      target: "snvs_v2",
      auditRecorded: true,
    });
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(
      { ...baseInput, diseaseCode: "rabies_confirmed", confirmedByLab: true, isReportable: true },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(mockSignalAuthorityReport).toHaveBeenCalledWith(
      expect.objectContaining({ reportedByUserId: userId }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authoritySignal).toEqual(
        expect.objectContaining({ delivered: false, v1_noop: true }),
      );
    }
  });

  it("returns authoritySignal: null when the death is not reportable", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(
      { ...baseInput, diseaseCode: null, isReportable: false },
      { repo, transaction: tx, flushNotifications: flush },
    );

    expect(mockSignalAuthorityReport).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authoritySignal).toBeNull();
    }
  });

  describe("urgent authority fan-out — the notification names the disposal", () => {
    // Shared setup: pet in observation, started event found, one authority in
    // jurisdiction — the fan-out inserts a notification row we can inspect.
    function observedDeathDeps() {
      const repo = makeRepo({
        findLatestRabiesObservationStarted: vi.fn().mockResolvedValue({
          id: randomUUID(),
          payload: { bite_event_id: randomUUID() },
        }),
      });
      mockFindAuthoritiesForJurisdiction.mockResolvedValue(["auth-user-1"]);
      return { repo, tx: makeTransaction(), flush: vi.fn().mockResolvedValue(undefined) };
    }

    function insertedBody(): string {
      expect(mockNotificationValues).toHaveBeenCalledTimes(1);
      const rows = mockNotificationValues.mock.calls[0][0] as { body: string }[];
      expect(rows).toHaveLength(1);
      return rows[0].body;
    }

    it("names a non-recommended disposal (es-AR label) and its facility", async () => {
      const { repo, tx, flush } = observedDeathDeps();

      const result = await createDeathRecord(
        {
          ...baseInput,
          pet: { ...basePet, rabiesObservationStatus: "in_progress" },
          dispositionMethod: "owner_burial",
          facility: "patio del domicilio",
        },
        { repo, transaction: tx, flushNotifications: flush },
      );

      expect(result.ok).toBe(true);
      const body = insertedBody();
      expect(body).toContain("Disposición declarada: Entierro en domicilio (patio del domicilio).");
      // The pre-existing sentences stay intact around the new one.
      expect(body).toContain("Causa declarada: natural.");
      expect(body).toContain("Requiere revisión inmediata por riesgo de rabia.");
    });

    it("names a compliant disposal too — the contract is 'always name it'", async () => {
      const { repo, tx, flush } = observedDeathDeps();

      await createDeathRecord(
        {
          ...baseInput,
          pet: { ...basePet, rabiesObservationStatus: "in_progress" },
          dispositionMethod: "cremation_collective",
          facility: "Crematorio San Roque",
        },
        { repo, transaction: tx, flushNotifications: flush },
      );

      expect(insertedBody()).toContain(
        "Disposición declarada: Cremación colectiva (Crematorio San Roque).",
      );
    });

    it("says 'sin registrar' when no disposal was declared", async () => {
      const { repo, tx, flush } = observedDeathDeps();

      await createDeathRecord(
        {
          ...baseInput,
          pet: { ...basePet, rabiesObservationStatus: "in_progress" },
          dispositionMethod: null,
          facility: null,
        },
        { repo, transaction: tx, flushNotifications: flush },
      );

      expect(insertedBody()).toContain("Disposición declarada: sin registrar.");
    });
  });

  describe("urgent authority fan-out — durable, keyed, and never lost to a failed lookup", () => {
    function observedDeathDeps() {
      const repo = makeRepo({
        findLatestRabiesObservationStarted: vi.fn().mockResolvedValue({
          id: randomUUID(),
          payload: { bite_event_id: randomUUID() },
        }),
      });
      return { repo, tx: makeTransaction(), flush: vi.fn().mockResolvedValue(undefined) };
    }

    it("each authority row carries the key event:{deathEventId}:{userId}:{type}", async () => {
      const { repo, tx, flush } = observedDeathDeps();
      mockFindAuthoritiesForJurisdiction.mockResolvedValue(["auth-user-1", "auth-user-2"]);

      const result = await createDeathRecord(
        { ...baseInput, pet: { ...basePet, rabiesObservationStatus: "in_progress" } },
        { repo, transaction: tx, flushNotifications: flush },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const deathEventId = result.insertedEventId;
      expect(deathEventId).toBeTruthy();
      expect(mockNotificationValues).toHaveBeenCalledTimes(1);
      const rows = mockNotificationValues.mock.calls[0][0] as Record<string, unknown>[];
      expect(rows.map((r) => r.dedupeKey)).toEqual([
        `event:${deathEventId}:auth-user-1:rabies_observation_completed_dead_authority`,
        `event:${deathEventId}:auth-user-2:rabies_observation_completed_dead_authority`,
      ]);
      expect(rows[0]).toMatchObject({
        severity: "urgent",
        relatedEventId: deathEventId,
        ctaUrl: "/gob/vigilancia",
      });
      expect(mockActiveHumanInstitutionalAdminIds).not.toHaveBeenCalled();
    });

    it("a lookup that THROWS falls back to the national admins instead of alerting nobody", async () => {
      const { repo, tx, flush } = observedDeathDeps();
      mockFindAuthoritiesForJurisdiction.mockRejectedValue(new Error("pool reset"));
      mockActiveHumanInstitutionalAdminIds.mockResolvedValue(["admin-a"]);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await createDeathRecord(
        { ...baseInput, pet: { ...basePet, rabiesObservationStatus: "in_progress" } },
        { repo, transaction: tx, flushNotifications: flush },
      );

      expect(result.ok).toBe(true);
      expect(mockNotificationValues).toHaveBeenCalledTimes(1);
      const rows = mockNotificationValues.mock.calls[0][0] as Record<string, unknown>[];
      expect(rows.map((r) => r.userId)).toEqual(["admin-a"]);
      expect(rows[0].title).toBe(
        `URGENTE — fallecimiento durante observación antirrábica (${basePet.name})`,
      );
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  it("returns ok=false when transaction throws", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockRejectedValue(new Error("db error")),
    });
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(baseInput, {
      repo,
      transaction: tx,
      flushNotifications: flush,
    });

    expect(result.ok).toBe(false);
    // Not a serialization failure: the real message survives, a refusal must
    // not hide a bug.
    if (!result.ok) expect(result.error).toBe("db error");
  });

  // PO D8 (2026-09-18) — the veterinary closer. The action-edge suite
  // (atender/actions.rabies-close.test.ts) covers the happy path; these pin the
  // fail-closed legs the action cannot reach.
  describe("veterinary closer (D8)", () => {
    const closer = {
      role: "vet" as const,
      userId: "vet-1",
      organizationId: "org-1",
      petPublicToken: "DIM-TEST-0001",
    };

    it("refuses outside an observation: no death, no flush, no alert", async () => {
      const repo = makeRepo();
      const flush = vi.fn().mockResolvedValue(undefined);
      const closeObservationIfOpen = vi.fn().mockResolvedValue(true);

      const result = await createDeathRecord(
        {
          ...baseInput,
          pet: { ...basePet, rabiesObservationStatus: null },
          observationCloser: closer,
        },
        {
          repo,
          transaction: makeTransaction(),
          flushNotifications: flush,
          closeObservationIfOpen,
          insertObservationCloseAuditLog: vi.fn(),
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("no tiene una observación antirrábica en curso");
      }
      expect(closeObservationIfOpen).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(mockFindAuthoritiesForJurisdiction).not.toHaveBeenCalled();
    });

    it("fails closed without the guarded close, instead of falling back to the unguarded update", async () => {
      const repo = makeRepo({
        findLatestRabiesObservationStarted: vi
          .fn()
          .mockResolvedValue({ id: randomUUID(), payload: { bite_event_id: null } }),
      });

      const result = await createDeathRecord(
        {
          ...baseInput,
          pet: { ...basePet, rabiesObservationStatus: "in_progress" },
          observationCloser: closer,
        },
        {
          repo,
          transaction: makeTransaction(),
          flushNotifications: vi.fn(),
          insertObservationCloseAuditLog: vi.fn(),
        },
      );

      expect(result.ok).toBe(false);
      expect(repo.updateRabiesObservationStatus).not.toHaveBeenCalled();
      expect(mockFindAuthoritiesForJurisdiction).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Lock order + serialization refusal (WU6/7 review, M-1)
// ---------------------------------------------------------------------------

describe("createDeathRecord — the pet advisory lock is the transaction's FIRST statement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateEventPayload.mockImplementation((_type: string, payload: unknown) => payload);
    mockCloseCase.mockResolvedValue(undefined);
    mockEndSponsorshipForDeceasedPet.mockResolvedValue(null);
    mockLockPetForDeathRecord.mockResolvedValue(undefined);
    mockSignalAuthorityReport.mockResolvedValue(undefined);
    mockFindAuthoritiesForJurisdiction.mockResolvedValue([]);
  });

  it("takes the lock on the pet, inside the transaction, before the death event is written", async () => {
    const repo = makeRepo();
    const tx = makeTransaction();
    await createDeathRecord(baseInput, {
      repo,
      transaction: tx,
      flushNotifications: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockLockPetForDeathRecord).toHaveBeenCalledTimes(1);
    expect(mockLockPetForDeathRecord).toHaveBeenCalledWith(petId, {});
    const lockOrder = mockLockPetForDeathRecord.mock.invocationCallOrder[0];
    const insertOrder = (repo.insertEventIdempotent as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const projectionOrder = (repo.updateDeceased as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const fostersOrder = (repo.findActiveFosters as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(insertOrder);
    expect(lockOrder).toBeLessThan(projectionOrder);
    expect(lockOrder).toBeLessThan(fostersOrder);
  });

  // Under the pet lock the row-lock cycle cannot form, but Postgres may still
  // pick a loser against a writer that does not take the lock. Nothing was
  // written; the recorder simply tries again — so the action gets a sentence,
  // not a stack trace (the same mapping the titular's withdraw does).
  for (const code of ["40P01", "40001"]) {
    it(`maps SQLSTATE ${code} to an es-AR refusal that names the pet, with nothing flushed`, async () => {
      const failing = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("deadlock detected"), { code }));
      const flush = vi.fn().mockResolvedValue(undefined);

      const result = await createDeathRecord(baseInput, {
        repo: makeRepo(),
        transaction: failing,
        flushNotifications: flush,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Buddy");
        expect(result.error).toMatch(/al mismo tiempo/);
        expect(result.error).toMatch(/No cambió nada/);
        expect(result.error).toMatch(/Volvé a intentar/);
        expect(result.error).not.toContain("deadlock");
      }
      expect(flush).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// CASCADE D — a sponsored pet's death ends the sponsorship (rehome-by-titular)
// ---------------------------------------------------------------------------

describe("createDeathRecord — CASCADE D: rehome sponsorship", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateEventPayload.mockImplementation((_type: string, payload: unknown) => payload);
    mockCloseCase.mockResolvedValue(undefined);
    mockLockPetForDeathRecord.mockResolvedValue(undefined);
    mockSignalAuthorityReport.mockResolvedValue(undefined);
    mockFindAuthoritiesForJurisdiction.mockResolvedValue([]);
  });

  it("runs the cascade inside the transaction with the death's own authorship, and tells the org and the applicants", async () => {
    mockEndSponsorshipForDeceasedPet.mockResolvedValue({
      sponsoringOrganizationId: "org-1",
      sponsoringOrganizationPublicToken: "DIM-ORG1-0001",
      ownershipId: "own-custody-1",
      listingCaseId: "case-listing",
      listingCasePublicCode: "CAS-LIST-0001",
      requestCaseId: null,
      requestCasePublicCode: null,
      orgRecipientUserIds: ["coord-1", "coord-2"],
      strandedApplicantUserIds: ["applicant-1"],
    });
    const repo = makeRepo();
    const tx = makeTransaction();
    const flush = vi.fn().mockResolvedValue(undefined);

    const result = await createDeathRecord(baseInput, {
      repo,
      transaction: tx,
      flushNotifications: flush,
    });
    expect(result.ok).toBe(true);

    expect(mockEndSponsorshipForDeceasedPet).toHaveBeenCalledTimes(1);
    const [args, passedTx] = mockEndSponsorshipForDeceasedPet.mock.calls[0];
    expect(passedTx).toEqual({});
    expect(args).toMatchObject({
      petId,
      petName: "Buddy",
      recordedByUserId: userId,
      authorRole: "owner",
      authorVerified: false,
    });
    // WU6/7 review (M-2): the recorder's org is NOT handed down — the cascade
    // stamps the SPONSORING org on the closing fact and the auto-rejections.
    expect(args).not.toHaveProperty("authorOrganizationId");

    const flushed = flush.mock.calls[0][0] as Array<{
      userId: string;
      notificationType: string;
      title: string;
      body: string;
      relatedCaseId?: string | null;
      ctaLabel?: string | null;
      ctaUrl?: string | null;
    }>;
    const org = flushed.filter((n) => n.notificationType === "rehome_sponsorship_ended_by_death");
    expect(org.map((n) => n.userId).sort()).toEqual(["coord-1", "coord-2"]);
    expect(org[0].title).toContain("Buddy");
    expect(org[0].body).toMatch(/acompañamiento/);
    expect(org[0].relatedCaseId).toBe("case-listing");
    // UI-2: the org's notice lands on the closed sponsorship case — readable
    // by its members after the custody row closed (adoption_listing branch of
    // canReadCase keys on opened_by_organization, not on a live row).
    expect(org[0].ctaUrl).toBe("/casos/CAS-LIST-0001");
    expect(org[0].ctaLabel).toBe("Ver caso");
    const applicant = flushed.find((n) => n.userId === "applicant-1");
    expect(applicant?.notificationType).toBe("adoption_application_closed");
    expect(applicant?.body).toMatch(/falleció/);
    expect(applicant?.body).toMatch(/No hace falta que hagas nada/);
    expect(applicant?.ctaUrl).toBe("/adoptar");
  });

  it("a death between ask and answer: the org's notice lands on the closed rehome_request case", async () => {
    mockEndSponsorshipForDeceasedPet.mockResolvedValue({
      sponsoringOrganizationId: "org-1",
      sponsoringOrganizationPublicToken: "DIM-ORG1-0001",
      ownershipId: null,
      listingCaseId: null,
      listingCasePublicCode: null,
      requestCaseId: "case-request",
      requestCasePublicCode: "CAS-REQ-0001",
      orgRecipientUserIds: ["coord-1"],
      strandedApplicantUserIds: [],
    });
    const flush = vi.fn().mockResolvedValue(undefined);
    await createDeathRecord(baseInput, {
      repo: makeRepo(),
      transaction: makeTransaction(),
      flushNotifications: flush,
    });
    const [notice] = flush.mock.calls[0][0] as Array<{
      body: string;
      ctaUrl?: string | null;
      relatedCaseId?: string | null;
    }>;
    expect(notice.body).toMatch(/solicitud/);
    expect(notice.relatedCaseId).toBe("case-request");
    expect(notice.ctaUrl).toBe("/casos/CAS-REQ-0001");
  });

  it("with no case left to open (a lost close), the org is sent to its own case queue", async () => {
    mockEndSponsorshipForDeceasedPet.mockResolvedValue({
      sponsoringOrganizationId: "org-1",
      sponsoringOrganizationPublicToken: "DIM-ORG1-0001",
      ownershipId: "own-custody-1",
      listingCaseId: null,
      listingCasePublicCode: null,
      requestCaseId: null,
      requestCasePublicCode: null,
      orgRecipientUserIds: ["coord-1"],
      strandedApplicantUserIds: [],
    });
    const flush = vi.fn().mockResolvedValue(undefined);
    await createDeathRecord(baseInput, {
      repo: makeRepo(),
      transaction: makeTransaction(),
      flushNotifications: flush,
    });
    const [notice] = flush.mock.calls[0][0] as Array<{ ctaUrl?: string | null }>;
    expect(notice.ctaUrl).toBe("/org/DIM-ORG1-0001/casos");
  });

  it("a pet with no sponsorship: the helper says null and nobody extra is told", async () => {
    mockEndSponsorshipForDeceasedPet.mockResolvedValue(null);
    const repo = makeRepo();
    const flush = vi.fn().mockResolvedValue(undefined);
    await createDeathRecord(baseInput, {
      repo,
      transaction: makeTransaction(),
      flushNotifications: flush,
    });
    expect(mockEndSponsorshipForDeceasedPet).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toEqual([]);
  });

  it("an idempotency noop skips CASCADE D like every other cascade", async () => {
    const repo = makeRepo({
      insertEventIdempotent: vi.fn().mockResolvedValue({ event: { id: eventId }, wasNoop: true }),
    });
    await createDeathRecord(baseInput, {
      repo,
      transaction: makeTransaction(),
      flushNotifications: vi.fn().mockResolvedValue(undefined),
    });
    expect(mockEndSponsorshipForDeceasedPet).not.toHaveBeenCalled();
  });
});
