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

// The dedup lookup needs a real transaction; unit-level it answers "no recent
// signal" unless a test says otherwise. The folding rule itself stays real.
const mockLockAndFindRecentSignals = vi.hoisted(() => vi.fn());
vi.mock("./recent-outbreak-signals", async (importActual) => ({
  ...(await importActual<typeof import("./recent-outbreak-signals")>()),
  lockAndFindRecentSignals: mockLockAndFindRecentSignals,
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
  petName: "Firulais",
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
    mockLockAndFindRecentSignals.mockResolvedValue([]);
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
      corroboratedSignalEventIds: [],
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
      corroboratedSignalEventIds: [],
      wasDuplicate: false,
    });

    // outbreak_signal insert (system author)
    const signalCall = repo.insertEvent.mock.calls[1] as [Record<string, unknown>, unknown];
    expect(signalCall[0].eventType).toBe("outbreak_signal");
    expect(signalCall[0].authorRole).toBe("system");
    expect(signalCall[0].recordedByUserId).toBeNull();

    // PO S1: an owner's symptom is a SIGNAL — no legal ENO row is enqueued.
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();

    // route called once
    expect(mockRouteOutbreakSignalNotifications).toHaveBeenCalledTimes(1);

    // maybeNotify called — with the pet's REAL name (health audit #13: it
    // used to receive "", so the alert copy named nobody).
    expect(mockMaybeNotifyOwnersOfPublicAlert).toHaveBeenCalledTimes(1);
    const alertInput = mockMaybeNotifyOwnersOfPublicAlert.mock.calls[0][0] as {
      pet: { id: string; name: string };
    };
    expect(alertInput.pet).toEqual({ id: petId, name: "Firulais" });
  });

  // localidades-por-id D3: the signal carries the home place.
  it("the signal carries the home place", async () => {
    mockMatchSymptoms.mockReturnValue([{ symptom_code: "symptom_1" }]);
    mockAggregateDiseaseMatches.mockReturnValue([
      {
        disease_code: "rabies_suspected",
        disease_label: "Rabia sospechada",
        triggers_alert: true,
        is_reportable: true,
        high_count: 2,
        medium_count: 1,
        low_count: 0,
        matched_symptoms: ["symptom_1"],
      },
    ]);
    const HOME = "11111111-1111-4111-8111-111111111111";
    const repo = makeRepo();
    repo.insertEvent
      .mockResolvedValueOnce({ id: randomUUID() })
      .mockResolvedValueOnce({ id: randomUUID() });
    await createSymptomObservedWriter(
      { ...baseParams, rabiesObservationStatus: null, petLocalityId: HOME, petPlaceMethod: null },
      {
        repo: repo as unknown as Pick<
          EventsRepository,
          "insertEvent" | "insertEventIdempotent" | "enqueueOutbox"
        >,
        transaction: makeTransaction(),
        flushNotifications: makeFlushNotifications(),
      },
    );
    const signal = repo.insertEvent.mock.calls[1]?.[0] as { payload: Record<string, unknown> };
    expect(signal.payload.place).toMatchObject({
      resolved: { locality_id: HOME, method: "catalogue_id" },
    });
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
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
      corroboratedSignalEventIds: [],
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
      corroboratedSignalEventIds: [],
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
      corroboratedSignalEventIds: [],
      wasDuplicate: true,
    });
    // No signals, no outbox, no notifications when noop
    expect(repo.enqueueOutbox).not.toHaveBeenCalled();
    expect(mockRouteOutbreakSignalNotifications).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledWith([]); // flush called with empty array
  });
});

// vet-visit-record (2026-09-29): the writer stops hardcoding the owner.
describe("createSymptomObservedWriter — reporterRole", () => {
  const rabies = {
    disease_code: "rabies_suspected",
    disease_label: "Rabia sospechada",
    triggers_alert: true,
    is_reportable: true,
    high_count: 1,
    medium_count: 0,
    low_count: 0,
    matched_symptoms: ["symptom_1"],
  };
  const vetAuthorship = {
    authorRole: "vet" as const,
    authorOrganizationId: randomUUID(),
    authorVerified: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeNotifyOwnersOfPublicAlert.mockResolvedValue({ delivered: 0 });
    mockRouteOutbreakSignalNotifications.mockResolvedValue(undefined);
    mockMatchSymptoms.mockReturnValue([{ symptom_code: "symptom_1" }]);
    mockAggregateDiseaseMatches.mockReturnValue([rabies]);
    mockLockAndFindRecentSignals.mockResolvedValue([]);
  });

  function deps(repo: ReturnType<typeof makeRepo>, flush = makeFlushNotifications()) {
    return {
      repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "insertEventIdempotent">,
      transaction: makeTransaction(),
      flushNotifications: flush,
    };
  }

  it("defaults to owner when no reporterRole is given", async () => {
    const repo = makeRepo();
    await createSymptomObservedWriter(baseParams, deps(repo));
    const symptom = repo.insertEvent.mock.calls[0][0] as { payload: { reporter_role: string } };
    expect(symptom.payload.reporter_role).toBe("owner");
  });

  it("a vet reporter writes reporter_role=vet and stamps the visit on the symptom only", async () => {
    const repo = makeRepo();
    const visitId = randomUUID();
    const result = await createSymptomObservedWriter(
      { ...baseParams, eventAuthorship: vetAuthorship, reporterRole: "vet", visitId },
      deps(repo),
    );
    expect(result.ok).toBe(true);
    const [symptom, signal] = repo.insertEvent.mock.calls.map(
      (c) => c[0] as { eventType: string; visitId?: string; payload: { reporter_role?: string } },
    );
    expect(symptom.eventType).toBe("symptom_observed");
    expect(symptom.payload.reporter_role).toBe("vet");
    expect(symptom.visitId).toBe(visitId);
    expect(signal.eventType).toBe("outbreak_signal");
    expect(signal.visitId).toBeUndefined();
  });

  it("suppresses the owner-worded rabies escalation push for a vet reporter, and still escalates to the authority", async () => {
    const repo = makeRepo();
    const flush = makeFlushNotifications();
    await createSymptomObservedWriter(
      {
        ...baseParams,
        eventAuthorship: vetAuthorship,
        reporterRole: "vet",
        rabiesObservationStatus: "in_progress",
      },
      deps(repo, flush),
    );
    const flushed = flush.mock.calls[0][0] as NewNotification[];
    expect(flushed.some((n) => n.notificationType === "rabies_observation_escalation_owner")).toBe(
      false,
    );
    const routeCall = mockRouteOutbreakSignalNotifications.mock.calls[0] as [
      unknown,
      { escalation?: boolean },
      NewNotification[],
    ];
    expect(routeCall[1].escalation).toBe(true);
  });

  it("the owner reporter still gets the escalation push (control)", async () => {
    const repo = makeRepo();
    const flush = makeFlushNotifications();
    await createSymptomObservedWriter(
      { ...baseParams, rabiesObservationStatus: "in_progress" },
      deps(repo, flush),
    );
    const flushed = flush.mock.calls[0][0] as NewNotification[];
    expect(flushed.some((n) => n.notificationType === "rabies_observation_escalation_owner")).toBe(
      true,
    );
  });
});

describe("createSymptomObservedWriter — corroboration instead of a second signal", () => {
  const rabies = {
    disease_code: "rabies_suspected",
    disease_label: "Rabia sospechada",
    triggers_alert: true,
    is_reportable: true,
    high_count: 1,
    medium_count: 0,
    low_count: 0,
    matched_symptoms: ["symptom_1"],
  };
  const existingId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeNotifyOwnersOfPublicAlert.mockResolvedValue({ delivered: 0 });
    mockRouteOutbreakSignalNotifications.mockResolvedValue(undefined);
    mockMatchSymptoms.mockReturnValue([{ symptom_code: "symptom_1" }]);
    mockAggregateDiseaseMatches.mockReturnValue([rabies]);
  });

  function run(params: Partial<typeof baseParams> & { rabiesObservationStatus?: string | null }) {
    const repo = makeRepo();
    const flush = makeFlushNotifications();
    const result = createSymptomObservedWriter(
      { ...baseParams, ...params },
      {
        repo: repo as unknown as Pick<EventsRepository, "insertEvent" | "insertEventIdempotent">,
        transaction: makeTransaction(),
        flushNotifications: flush,
      },
    );
    return { repo, flush, result };
  }

  it("an existing routine signal is corroborated: no new signal, no routing, no owner alert", async () => {
    mockLockAndFindRecentSignals.mockResolvedValue([
      { id: existingId, diseaseCode: "rabies_suspected", escalation: false },
    ]);
    const { repo, result } = run({});
    const r = await result;
    if (!r.ok) throw new Error(r.error);
    expect(r.signalEventIds).toEqual([]);
    expect(r.corroboratedSignalEventIds).toEqual([existingId]);
    expect(repo.insertEvent).toHaveBeenCalledTimes(1);
    const symptom = repo.insertEvent.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(symptom.payload.corroborated_signals).toEqual([
      { disease_code: "rabies_suspected", outbreak_signal_event_id: existingId },
    ]);
    // The disease stays in alerted_disease_codes: the rabies-observation
    // escalation reader keys on it and the report DID alert.
    expect(symptom.payload.alerted_disease_codes).toEqual(["rabies_suspected"]);
    expect(mockRouteOutbreakSignalNotifications).not.toHaveBeenCalled();
    expect(mockMaybeNotifyOwnersOfPublicAlert).not.toHaveBeenCalled();
  });

  it("an escalation is never folded into a routine signal that sent no urgent notice", async () => {
    mockLockAndFindRecentSignals.mockResolvedValue([
      { id: existingId, diseaseCode: "rabies_suspected", escalation: false },
    ]);
    const { repo, result } = run({ rabiesObservationStatus: "in_progress" });
    const r = await result;
    if (!r.ok) throw new Error(r.error);
    expect(r.signalEventIds).toHaveLength(1);
    expect(r.corroboratedSignalEventIds).toEqual([]);
    expect(repo.insertEvent).toHaveBeenCalledTimes(2);
  });

  it("an escalation IS folded into an earlier escalation", async () => {
    mockLockAndFindRecentSignals.mockResolvedValue([
      { id: existingId, diseaseCode: "rabies_suspected", escalation: true },
    ]);
    const { flush, result } = run({ rabiesObservationStatus: "in_progress" });
    const r = await result;
    if (!r.ok) throw new Error(r.error);
    expect(r.signalEventIds).toEqual([]);
    expect(r.corroboratedSignalEventIds).toEqual([existingId]);
    const flushed = flush.mock.calls[0][0] as NewNotification[];
    expect(flushed).toEqual([]);
  });

  it("a recent signal for ANOTHER disease does not fold this one", async () => {
    mockLockAndFindRecentSignals.mockResolvedValue([
      { id: existingId, diseaseCode: "leptospirosis", escalation: false },
    ]);
    const { result } = run({});
    const r = await result;
    if (!r.ok) throw new Error(r.error);
    expect(r.signalEventIds).toHaveLength(1);
    expect(r.corroboratedSignalEventIds).toEqual([]);
  });
});
