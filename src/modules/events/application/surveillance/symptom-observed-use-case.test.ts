// Test: createSymptomObservedWriter (WU-5 surveillance-bridge)
//
// TDD RED phase — tests written BEFORE implementation.
// Parity contract: byte-for-byte behavior vs app/actions/events.ts::createSymptomObservedWriter.
//
// Invariants under test:
//   - symptom_observed: plain insert (NOT idempotent), with matched codes + alerted diseases.
//   - Matcher is defensive: failure sets empty results, NEVER blocks the insert.
//   - For each alertable disease: insert outbreak_signal (plain, system author) +
//     enqueueOutbox + routeOutbreakSignalNotifications + maybeNotifyOwnersOfPublicAlert.
//   - Rabies escalation: rabiesObservationStatus=in_progress + rabies_suspected high_count>=1
//       → push urgent owner notification (rabies_observation_escalation_owner).
//   - pendingNotifications flushed post-tx (caller's responsibility).
//   - Result: { ok: true, symptomEventId, signalEventIds }
//
// W-1 fix (2026-06-07): clientIdempotencyKey idempotency parity:
//   - When clientIdempotencyKey is provided (non-null), use insertEventIdempotent.
//   - When wasNoop=true, return early with ok:true and empty signalEventIds (no signals).
//   - When clientIdempotencyKey is null/absent, use plain insertEvent (preserves original writer path).

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock insertEventIdempotent so the test is unit-level.
vi.mock("server-only", () => ({}));

// Hoist mock for symptom-matcher so it can be controlled per test.
const mockMatchSymptoms = vi.hoisted(() => vi.fn());
const mockAggregateDiseaseMatches = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain/symptom-matcher", () => ({
  matchSymptoms: mockMatchSymptoms,
  aggregateDiseaseMatches: mockAggregateDiseaseMatches,
}));

const mockMaybeNotifyOwnersOfPublicAlert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/owner-disease-alerts", () => ({
  maybeNotifyOwnersOfPublicAlert: mockMaybeNotifyOwnersOfPublicAlert,
}));

const mockRouteOutbreakSignalNotifications = vi.hoisted(() => vi.fn());
vi.mock("../clinical/route-outbreak-signal-notifications", () => ({
  routeOutbreakSignalNotifications: mockRouteOutbreakSignalNotifications,
}));

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { NewNotification } from "../types";
import { createSymptomObservedWriter } from "./symptom-observed-use-case";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(
  overrides: Partial<ReturnType<typeof buildRepo>> = {},
): ReturnType<typeof buildRepo> {
  return { ...buildRepo(), ...overrides };
}

function buildRepo() {
  const insertEvent = vi.fn().mockResolvedValue({ id: randomUUID() });
  const insertEventIdempotent = vi
    .fn()
    .mockResolvedValue({ event: { id: randomUUID() }, wasNoop: false });
  const enqueueOutbox = vi.fn().mockResolvedValue(undefined);
  return { insertEvent, insertEventIdempotent, enqueueOutbox };
}

function makeTransaction() {
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
}

function makeFlushNotifications() {
  return vi.fn().mockResolvedValue(undefined);
}

const petId = randomUUID();
const userId = randomUUID();

const baseParams = {
  petId,
  petPublicToken: "token-abc",
  petSpecies: "dog",
  petJurisdictionCountry: "AR",
  petJurisdictionProvince: "Buenos Aires",
  petJurisdictionLocality: "La Plata",
  rabiesObservationStatus: null as string | null,
  recordedByUserId: userId,
  eventAuthorship: {
    authorRole: "owner" as const,
    authorOrganizationId: null,
    authorVerified: false,
  },
  freeText: "mi perro tiene fiebre y no come",
  severity: null as "mild" | "moderate" | "severe" | null,
  onsetAt: null as string | null,
  now: new Date("2026-06-01T12:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSymptomObservedWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeNotifyOwnersOfPublicAlert.mockResolvedValue({ delivered: 0 });
    mockRouteOutbreakSignalNotifications.mockResolvedValue(undefined);
  });

  it("inserts symptom_observed (plain) with empty match arrays when no diseases match", async () => {
    mockMatchSymptoms.mockReturnValue([]);
    mockAggregateDiseaseMatches.mockReturnValue([]);

    const repo = makeRepo();
    // Each call to insertEvent returns a unique ID.
    const symptomId = randomUUID();
    repo.insertEvent.mockResolvedValueOnce({ id: symptomId });

    const tx = makeTransaction();
    const flush = makeFlushNotifications();

    const result = await createSymptomObservedWriter(baseParams, {
      repo: repo as unknown as Pick<
        EventsRepository,
        "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
      >,
      transaction: tx,
      flushNotifications: flush,
    });

    expect(result).toEqual({
      ok: true,
      symptomEventId: symptomId,
      signalEventIds: [],
      wasDuplicate: false,
    });

    // Plain insert called once for symptom_observed
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(insertArg.eventType).toBe("symptom_observed");
    expect(insertArg.recordedByUserId).toBe(userId);
    expect(insertArg.authorRole).toBe("owner");

    // No signal events
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
    expect(mockRouteOutbreakSignalNotifications).not.toHaveBeenCalled();
  });

  it("inserts outbreak_signal + enqueues outbox + routes for each alertable disease", async () => {
    const disease = {
      disease_code: "rabies_suspected",
      disease_label: "Rabia sospechada",
      triggers_alert: true,
      is_reportable: true,
      high_count: 2,
      medium_count: 1,
      low_count: 0,
      matched_symptoms: ["symptom_1"],
    };
    mockMatchSymptoms.mockReturnValue([{ symptom_code: "symptom_1" }]);
    mockAggregateDiseaseMatches.mockReturnValue([disease]);

    const symptomId = randomUUID();
    const signalId = randomUUID();
    const repo = makeRepo();
    repo.insertEvent
      .mockResolvedValueOnce({ id: symptomId }) // symptom_observed
      .mockResolvedValueOnce({ id: signalId }); // outbreak_signal

    const tx = makeTransaction();
    const flush = makeFlushNotifications();

    const result = await createSymptomObservedWriter(
      { ...baseParams, rabiesObservationStatus: null },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: tx,
        flushNotifications: flush,
      },
    );

    expect(result).toEqual({
      ok: true,
      symptomEventId: symptomId,
      signalEventIds: [signalId],
      wasDuplicate: false,
    });

    // outbreak_signal insert (system author)
    const signalCall = repo.insertEvent.mock.calls[1] as [Record<string, unknown>, unknown];
    expect(signalCall[0].eventType).toBe("outbreak_signal");
    expect(signalCall[0].authorRole).toBe("system");
    expect(signalCall[0].recordedByUserId).toBeNull();

    // outbox enqueued for the signal
    expect(repo.enqueueOutbox).toHaveBeenCalledTimes(1);

    // route called once
    expect(mockRouteOutbreakSignalNotifications).toHaveBeenCalledTimes(1);

    // maybeNotify called
    expect(mockMaybeNotifyOwnersOfPublicAlert).toHaveBeenCalledTimes(1);
  });

  it("pushes urgent owner notification when rabies escalation is active", async () => {
    const disease = {
      disease_code: "rabies_suspected",
      disease_label: "Rabia sospechada",
      triggers_alert: true,
      is_reportable: true,
      high_count: 1,
      medium_count: 0,
      low_count: 0,
      matched_symptoms: ["symptom_1"],
    };
    mockMatchSymptoms.mockReturnValue([{ symptom_code: "symptom_1" }]);
    mockAggregateDiseaseMatches.mockReturnValue([disease]);

    const symptomId = randomUUID();
    const signalId = randomUUID();
    const repo = makeRepo();
    repo.insertEvent
      .mockResolvedValueOnce({ id: symptomId })
      .mockResolvedValueOnce({ id: signalId });

    const tx = makeTransaction();
    const capturedNotifications: NewNotification[] = [];
    const flush = vi.fn().mockImplementation((notifs: NewNotification[]) => {
      capturedNotifications.push(...notifs);
      return Promise.resolve();
    });

    // Intercept routeOutbreakSignalNotifications to capture pendingNotifications
    mockRouteOutbreakSignalNotifications.mockImplementation(
      (_tx: unknown, _args: unknown, pending: NewNotification[]) => {
        // Does not push — we test the escalation owner notification separately
        return Promise.resolve();
      },
    );

    const result = await createSymptomObservedWriter(
      { ...baseParams, rabiesObservationStatus: "in_progress" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: tx,
        flushNotifications: flush,
      },
    );

    expect(result.ok).toBe(true);

    // flush should have been called with the rabies escalation owner notification
    const flushArg = flush.mock.calls[0][0] as NewNotification[];
    const ownerNotif = flushArg.find(
      (n) => n.notificationType === "rabies_observation_escalation_owner",
    );
    expect(ownerNotif).toBeDefined();
    expect(ownerNotif?.severity).toBe("urgent");
    expect(ownerNotif?.userId).toBe(userId);

    // route called with escalation=true
    const routeCall = mockRouteOutbreakSignalNotifications.mock.calls[0] as [
      unknown,
      { escalation?: boolean },
      NewNotification[],
    ];
    expect(routeCall[1].escalation).toBe(true);
  });

  it("sets empty match arrays and still inserts symptom_observed when matcher throws", async () => {
    mockMatchSymptoms.mockImplementation(() => {
      throw new Error("matcher crash");
    });

    const symptomId = randomUUID();
    const repo = makeRepo();
    repo.insertEvent.mockResolvedValueOnce({ id: symptomId });

    const tx = makeTransaction();
    const flush = makeFlushNotifications();

    const result = await createSymptomObservedWriter(baseParams, {
      repo: repo as unknown as Pick<
        EventsRepository,
        "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
      >,
      transaction: tx,
      flushNotifications: flush,
    });

    expect(result).toEqual({
      ok: true,
      symptomEventId: symptomId,
      signalEventIds: [],
      wasDuplicate: false,
    });

    // symptom_observed still inserted with empty arrays
    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(insertArg.eventType).toBe("symptom_observed");
    const payload = insertArg.payload as Record<string, unknown>;
    expect(payload.matched_symptom_codes).toEqual([]);
    expect(payload.alerted_disease_codes).toEqual([]);
  });

  it("uses onsetAt as occurredAt when provided", async () => {
    mockMatchSymptoms.mockReturnValue([]);
    mockAggregateDiseaseMatches.mockReturnValue([]);

    const symptomId = randomUUID();
    const repo = makeRepo();
    repo.insertEvent.mockResolvedValueOnce({ id: symptomId });

    const tx = makeTransaction();
    const flush = makeFlushNotifications();
    const onsetAt = "2026-05-30";

    await createSymptomObservedWriter(
      { ...baseParams, onsetAt },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: tx,
        flushNotifications: flush,
      },
    );

    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    expect((insertArg.occurredAt as Date).toISOString().startsWith("2026-05-30")).toBe(true);
  });

  it("anchors a date-only onsetAt on that ARGENTINE calendar day (noon UTC, not midnight)", async () => {
    // Regression: `new Date("2026-07-18")` is midnight UTC = 21:00 on the 17th
    // in AR (UTC-3) — the symptom landed one day EARLY. The noon-UTC anchor
    // (parseDateInput) keeps it on the 18th in every zone within ±12h.
    mockMatchSymptoms.mockReturnValue([]);
    mockAggregateDiseaseMatches.mockReturnValue([]);

    const symptomId = randomUUID();
    const repo = makeRepo();
    repo.insertEvent.mockResolvedValueOnce({ id: symptomId });

    await createSymptomObservedWriter(
      { ...baseParams, onsetAt: "2026-07-18" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: makeTransaction(),
        flushNotifications: makeFlushNotifications(),
      },
    );

    const [insertArg] = repo.insertEvent.mock.calls[0] as [Record<string, unknown>, unknown];
    const occurredAt = insertArg.occurredAt as Date;
    expect(occurredAt.toISOString()).toBe("2026-07-18T12:00:00.000Z");
    // And the AR calendar day is the day the user picked.
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Argentina/Buenos_Aires",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(occurredAt),
    ).toBe("2026-07-18");
  });

  it("returns ok=false when the transaction throws", async () => {
    mockMatchSymptoms.mockReturnValue([]);
    mockAggregateDiseaseMatches.mockReturnValue([]);

    const repo = makeRepo();
    repo.insertEvent.mockRejectedValueOnce(new Error("db error"));

    const tx = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    const flush = makeFlushNotifications();

    const result = await createSymptomObservedWriter(baseParams, {
      repo: repo as unknown as Pick<
        EventsRepository,
        "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
      >,
      transaction: tx,
      flushNotifications: flush,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("db error");
    }
  });

  // W-1 fix: clientIdempotencyKey parity tests
  it("uses insertEventIdempotent when clientIdempotencyKey is provided", async () => {
    mockMatchSymptoms.mockReturnValue([]);
    mockAggregateDiseaseMatches.mockReturnValue([]);

    const symptomId = randomUUID();
    const repo = makeRepo();
    repo.insertEventIdempotent.mockResolvedValueOnce({ event: { id: symptomId }, wasNoop: false });

    const tx = makeTransaction();
    const flush = makeFlushNotifications();

    const result = await createSymptomObservedWriter(
      { ...baseParams, clientIdempotencyKey: "client-key-abc" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: tx,
        flushNotifications: flush,
      },
    );

    expect(result).toEqual({
      ok: true,
      symptomEventId: symptomId,
      signalEventIds: [],
      wasDuplicate: false,
    });
    // Must use idempotent path
    expect(repo.insertEventIdempotent).toHaveBeenCalledTimes(1);
    const [insertArg] = repo.insertEventIdempotent.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(insertArg.eventType).toBe("symptom_observed");
    expect(insertArg.clientIdempotencyKey).toBe("client-key-abc");
    // Plain insertEvent must NOT be called for the symptom row
    expect(repo.insertEvent).not.toHaveBeenCalled();
  });

  it("returns early with empty signalEventIds when wasNoop=true (duplicate submission)", async () => {
    mockMatchSymptoms.mockReturnValue([]);
    mockAggregateDiseaseMatches.mockReturnValue([]);

    const symptomId = randomUUID();
    const repo = makeRepo();
    // wasNoop=true simulates a duplicate submission
    repo.insertEventIdempotent.mockResolvedValueOnce({ event: { id: symptomId }, wasNoop: true });

    const tx = makeTransaction();
    const flush = makeFlushNotifications();

    const result = await createSymptomObservedWriter(
      { ...baseParams, clientIdempotencyKey: "client-key-dup" },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: tx,
        flushNotifications: flush,
      },
    );

    // `wasDuplicate: true` IS THE REPLAY, REPORTED. It was known inside the
    // transaction — it is what makes the whole fan-out skip — and used to be
    // dropped at the boundary; `POST /api/v1/pets/{token}/events` answers with
    // it, so a phone can say "ya estaba registrado" instead of congratulating
    // somebody for an asiento they wrote twice.
    expect(result).toEqual({
      ok: true,
      symptomEventId: symptomId,
      signalEventIds: [],
      wasDuplicate: true,
    });
    // No signals, no outbox, no notifications when noop
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
    expect(mockRouteOutbreakSignalNotifications).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledWith([]); // flush called with empty array
  });
});
