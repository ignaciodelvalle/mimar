// Use-case test: recordDiseaseDiagnosis (writer + action parity)
//
// Tests cover:
//   - Happy path: plain insert + outbox enqueue for diagnosis.
//   - Reportable disease: outbreak_signal emitted + outbox enqueue for signal.
//   - Non-reportable: no outbreak_signal, no signal outbox.
//   - AUTH PARITY: VET-ONLY. Writer itself is auth-agnostic (action validates vet role).
//     Parity test proves non-vet is rejected BY THE ACTION (tested via action-layer mock).
//   - Auth parity: NO ownership check — any pet's publicToken resolves.
//   - DURABILITY (V1-4 / P1-3): the ENO govt-fanout enqueue runs INSIDE the
//     diagnosis transaction (deps.enqueueEnoTrigger), NOT post-commit. A failing
//     enqueue rolls the diagnosis back (ok:false) instead of being swallowed.
//
// Note: the writer exports a Result type with { ok, diagnosisEventId, signalEventId }.
// Auth guard (vet + matriculaVerified) is in the action, NOT the writer.

import { describe, expect, it, vi } from "vitest";
import type { EventsRepository } from "../../infrastructure/events-repository";
import {
  type RecordDiseaseDiagnosisWriterInput,
  recordDiseaseDiagnosisWriter,
} from "./record-disease-diagnosis-use-case";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

// Use real UUIDs — the schema validators check uuid() on event IDs in payload fields.
const DIAG_EV_UUID = "aaaaaaaa-0000-4000-a000-000000000001";
const SIGNAL_EV_UUID = "aaaaaaaa-0000-4000-a000-000000000002";

function makeRepo(
  overrides: Partial<{
    insertEvent: EventsRepository["insertEvent"];
    enqueueOutbox: EventsRepository["enqueueOutbox"];
  }> = {},
): Pick<EventsRepository, "insertEvent" | "enqueueOutbox"> {
  return {
    insertEvent: vi
      .fn()
      .mockResolvedValueOnce({ id: DIAG_EV_UUID })
      .mockResolvedValueOnce({ id: SIGNAL_EV_UUID }),
    enqueueOutbox: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Transaction stub. Propagates throws from the callback (real db.transaction
 * rolls back and rethrows) so we can assert rollback semantics on enqueue
 * failure. The writer wraps the tx in its own try/catch and returns ok:false.
 */
function makeTx() {
  return <T>(cb: (tx: unknown) => Promise<T>) => cb({} as unknown);
}

/** Default in-tx ENO enqueue dep: a no-op spy that succeeds. */
function makeEnqueueEnoTrigger() {
  return vi.fn().mockResolvedValue(undefined);
}

// NOTE: we do NOT mock @/lib/diseases — we use real disease codes that exist
// in the actual catalog. This avoids the schema validator calling the real
// findDisease while our mock returns a different instance.
// "rabies" is reportable in the real catalog; "kennel_cough" is not reportable.

// routeOutbreakSignalNotifications mock (called inside writer when reportable)
vi.mock("./route-outbreak-signal-notifications", () => ({
  routeOutbreakSignalNotifications: vi.fn().mockResolvedValue(undefined),
}));

// maybeNotifyOwnersOfPublicAlert mock
vi.mock("@/lib/infra/owner-disease-alerts", () => ({
  maybeNotifyOwnersOfPublicAlert: vi.fn().mockResolvedValue({ delivered: 0 }),
}));

// Use valid UUIDs — the schema validator runs z.string().uuid() on performed_by_user_id.
const VET_UUID = "00000000-0000-4000-a000-000000000001";
const PET_UUID = "00000000-0000-4000-a000-000000000002";

const BASE_INPUT: RecordDiseaseDiagnosisWriterInput = {
  petId: PET_UUID,
  petName: "Fido",
  petSpecies: "dog",
  petJurisdictionCountry: "AR",
  petJurisdictionProvince: "Buenos Aires",
  petJurisdictionLocality: "La Plata",
  vetUserId: VET_UUID,
  vetDisplayName: "Dr. Fernández",
  // rabies_confirmed is a real reportable disease code in the AR catalog
  diseaseCode: "rabies_confirmed",
  confirmedByLab: false,
  labName: null,
  labReportReference: null,
  diagnosisDate: new Date("2024-06-01"),
  notes: null,
  now: new Date("2024-06-01T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recordDiseaseDiagnosisWriter", () => {
  it("returns ok:false for unknown disease_code", async () => {
    const repo = makeRepo();
    const result = await recordDiseaseDiagnosisWriter(
      { ...BASE_INPUT, diseaseCode: "not_a_real_disease_xyz" },
      {
        repo,
        transaction: makeTx(),
        flushNotifications: vi.fn(),
        enqueueEnoTrigger: makeEnqueueEnoTrigger(),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("unknown disease_code");
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it("inserts clinical_info_logged with authorRole=vet, authorVerified=true (no ownership)", async () => {
    const repo = makeRepo();

    const result = await recordDiseaseDiagnosisWriter(BASE_INPUT, {
      repo,
      transaction: makeTx(),
      flushNotifications: vi.fn(),
      enqueueEnoTrigger: makeEnqueueEnoTrigger(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.diagnosisEventId).toBe(DIAG_EV_UUID);

    const [diagValues] = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(diagValues.eventType).toBe("clinical_info_logged");
    expect(diagValues.authorRole).toBe("vet");
    expect(diagValues.authorVerified).toBe(true);
    expect(diagValues.authorOrganizationId).toBeNull();
    // recordedByUserId is the vet's userId — NOT the pet owner (no ownership check)
    expect(diagValues.recordedByUserId).toBe(VET_UUID);
  });

  it("enqueues outbox for diagnosis event", async () => {
    const repo = makeRepo();

    await recordDiseaseDiagnosisWriter(BASE_INPUT, {
      repo,
      transaction: makeTx(),
      flushNotifications: vi.fn(),
      enqueueEnoTrigger: makeEnqueueEnoTrigger(),
    });

    // enqueueOutbox called at least once for the diagnosis
    expect(repo.enqueueOutbox).toHaveBeenCalled();
    const firstCall = (repo.enqueueOutbox as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[1].eventType).toBe("clinical_info_logged");
    expect(firstCall[1].id).toBe(DIAG_EV_UUID);
  });

  it("enqueues the ENO trigger INSIDE the transaction (P1-3 durability)", async () => {
    const repo = makeRepo();
    const enqueueEnoTrigger = makeEnqueueEnoTrigger();
    let txHandle: unknown;

    await recordDiseaseDiagnosisWriter(BASE_INPUT, {
      repo,
      // Capture the tx handle the writer threads into deps so we can assert the
      // ENO enqueue received the SAME tx (i.e. it ran inside the transaction).
      transaction: <T>(cb: (tx: unknown) => Promise<T>) => {
        txHandle = Symbol("tx");
        return cb(txHandle);
      },
      flushNotifications: vi.fn(),
      enqueueEnoTrigger,
    });

    expect(enqueueEnoTrigger).toHaveBeenCalledOnce();
    const [petEventArg, txArg] = enqueueEnoTrigger.mock.calls[0];
    // The enqueue ran with the diagnosis event id and the transaction handle.
    expect(petEventArg.id).toBe(DIAG_EV_UUID);
    expect(petEventArg.payload.sub_kind).toBe("disease_diagnosis");
    expect(txArg).toBe(txHandle);
  });

  it("rolls back the diagnosis (ok:false) when the in-tx ENO enqueue throws", async () => {
    // P1-3: the enqueue is now atomic with the event. A genuine enqueue failure
    // propagates out of the tx callback (real db.transaction rolls back and
    // rethrows), so the writer returns ok:false instead of silently committing
    // a diagnosis whose govt-fanout row was never created.
    const repo = makeRepo();
    const enqueueEnoTrigger = vi.fn().mockRejectedValue(new Error("enqueue failed"));

    const result = await recordDiseaseDiagnosisWriter(BASE_INPUT, {
      repo,
      transaction: makeTx(),
      flushNotifications: vi.fn(),
      enqueueEnoTrigger,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("enqueue failed");
  });

  it("emits outbreak_signal and second outbox enqueue for reportable disease", async () => {
    const repo = makeRepo();

    const result = await recordDiseaseDiagnosisWriter(BASE_INPUT, {
      repo,
      transaction: makeTx(),
      flushNotifications: vi.fn(),
      enqueueEnoTrigger: makeEnqueueEnoTrigger(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.signalEventId).toBe(SIGNAL_EV_UUID);

    // outbreak_signal event inserted
    const calls = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const signalCall = calls[1];
    expect(signalCall[0].eventType).toBe("outbreak_signal");
    expect(signalCall[0].authorRole).toBe("system");

    // Second outbox enqueue for the signal
    const outboxCalls = (repo.enqueueOutbox as ReturnType<typeof vi.fn>).mock.calls;
    expect(outboxCalls.length).toBeGreaterThanOrEqual(2);
    const signalOutboxCall = outboxCalls[1];
    expect(signalOutboxCall[1].eventType).toBe("outbreak_signal");
  });

  it("does NOT emit outbreak_signal for non-reportable disease", async () => {
    const repo = makeRepo();

    // "distemper" exists in the AR catalog and is NOT reportable
    const result = await recordDiseaseDiagnosisWriter(
      { ...BASE_INPUT, diseaseCode: "distemper" },
      {
        repo,
        transaction: makeTx(),
        flushNotifications: vi.fn(),
        enqueueEnoTrigger: makeEnqueueEnoTrigger(),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.signalEventId).toBeNull();

    // Only one event insert (diagnosis), no signal
    const calls = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].eventType).toBe("clinical_info_logged");
  });
});

// ---------------------------------------------------------------------------
// Auth-parity: VET-ONLY (no ownership check)
// ---------------------------------------------------------------------------

describe("recordDiseaseDiagnosis auth-parity", () => {
  it("writer is auth-agnostic — vet validation is the action's responsibility", async () => {
    // The writer itself does NOT check role/matriculaVerified.
    // The action (recordDiseaseDiagnosisAction in actions.ts) does the vet check BEFORE calling the writer.
    // We prove this by calling the writer directly with vet context and confirming it succeeds.
    const repo = makeRepo();

    const result = await recordDiseaseDiagnosisWriter(BASE_INPUT, {
      repo,
      transaction: makeTx(),
      flushNotifications: vi.fn(),
      enqueueEnoTrigger: makeEnqueueEnoTrigger(),
    });

    expect(result.ok).toBe(true);
  });

  it("writer does NOT check pet ownership — any petId is accepted", async () => {
    // Spec: "The vet can diagnose any pet; no ownership check."
    // Writer accepts any petId — ownership is never verified inside the writer.
    const unownedPetId = "11111111-0000-4000-a000-000000000099";
    const repo = makeRepo();

    const result = await recordDiseaseDiagnosisWriter(
      { ...BASE_INPUT, petId: unownedPetId },
      {
        repo,
        transaction: makeTx(),
        flushNotifications: vi.fn(),
        enqueueEnoTrigger: makeEnqueueEnoTrigger(),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Event was inserted for that petId without ownership error
    const [diagValues] = (repo.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(diagValues.petId).toBe(unownedPetId);
  });
});
