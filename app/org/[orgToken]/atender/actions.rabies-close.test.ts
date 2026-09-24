// The veterinary close of a rabies observation (Ley 22.953), at the ACTION edge.
//
// The use case has its own tests, and it explicitly does NOT contain the licence
// gate: a validated matrícula plus `event.write` on this organization lives only
// in atenderCloseRabiesObservationAction. So this file runs the action with the
// REAL use case, the REAL walk-in completion and the REAL owner notifier, and
// fakes only the edges — the repository, the notification service, the owners
// query and the routing. What it pins:
//
//   · no licence → refused, nothing written, nobody notified;
//   · a vet's negative before the deadline → refused, naming the date (PO
//     2026-09-18); what already happened (a positive) is not held back;
//   · the write targets the pet the guard resolved, not the raw URL segment;
//   · the owner notice names the clinic and reaches EVERY active owner and
//     co-owner, once, through the durable service;
//   · the urgent authority fan-out goes through createNotificationsBulk with a
//     deterministic dedupe key.
//
// And the death door beside it (PO D8, 2026-09-18) —
// atenderRecordDeathInObservationAction — with the REAL death writer
// (createDeathRecord) over a faked EventsRepository: same licence gate, the
// canonical death_recorded, the observation closed by THIS vet through the
// guarded update, the audit row, the durable urgent authority alert, every
// owner told, and a double submit that writes once.

import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveAtenderPet: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  createNotification: vi.fn(),
  createNotificationsBulk: vi.fn(),
  closeCase: vi.fn(),
  findAuthoritiesForJurisdiction: vi.fn(),
  revalidatePath: vi.fn(),
  clinicMayRecordObservationDeath: vi.fn(),
  repo: {
    findPetByToken: vi.fn(),
    findLatestObservationStarted: vi.fn(),
    findOpenBiteCase: vi.fn(),
    insertObservationEnded: vi.fn(),
    closeObservationIfOpen: vi.fn(),
    findActiveOwnership: vi.fn(),
    insertObservationCloseAuditLog: vi.fn(),
  },
}));

// D8 — the death writer's edges.
const deathMocks = vi.hoisted(() => ({
  eventsRepo: {
    insertEventIdempotent: vi.fn(),
    insertEvent: vi.fn(),
    insertAttachment: vi.fn(),
    updateDeceased: vi.fn(),
    findActiveFosters: vi.fn(),
    endFoster: vi.fn(),
    findLatestRabiesObservationStarted: vi.fn(),
    updateRabiesObservationStatus: vi.fn(),
    updateStatusProjection: vi.fn(),
  },
  findOpenCaseForPetAndKind: vi.fn(),
  lockPetForDeathRecord: vi.fn(),
  endSponsorshipForDeceasedPet: vi.fn(),
  flushNotifications: vi.fn(),
}));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class {
    insertEventIdempotent = deathMocks.eventsRepo.insertEventIdempotent;
    insertEvent = deathMocks.eventsRepo.insertEvent;
    insertAttachment = deathMocks.eventsRepo.insertAttachment;
    updateDeceased = deathMocks.eventsRepo.updateDeceased;
    findActiveFosters = deathMocks.eventsRepo.findActiveFosters;
    endFoster = deathMocks.eventsRepo.endFoster;
    findLatestRabiesObservationStarted = deathMocks.eventsRepo.findLatestRabiesObservationStarted;
    updateRabiesObservationStatus = deathMocks.eventsRepo.updateRabiesObservationStatus;
    updateStatusProjection = deathMocks.eventsRepo.updateStatusProjection;
  },
}));

vi.mock("@/lib/infra/rehome-death-cascade", () => ({
  lockPetForDeathRecord: deathMocks.lockPetForDeathRecord,
  endSponsorshipForDeceasedPet: deathMocks.endSponsorshipForDeceasedPet,
}));

vi.mock("@/lib/infra/vet-observation-reach", () => ({
  clinicMayRecordObservationDeath: mocks.clinicMayRecordObservationDeath,
}));

vi.mock("./atender-access", async () => {
  // The real normaliser (lib/domain/dim-token.ts, zero dependencies): ASCII
  // a-z only, not the browser's Unicode `toUpperCase()`, which turns
  // lookalikes (Turkish dotless `ı`) into a real token shape.
  const { normalizeDimTokenInput } = await import("@/lib/domain/dim-token");
  return {
    ATENDER_TOKEN_PATTERN: /^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    normalizeAtenderToken: normalizeDimTokenInput,
    resolveAtenderPet: mocks.resolveAtenderPet,
  };
});

vi.mock("./atender-declared-events", () => ({
  rejectIfAlreadySigned: vi.fn().mockResolvedValue(null),
  attemptedChipMatchesDeclaration: vi.fn().mockResolvedValue(true),
}));

// The real schema (so the owners predicate can be compiled and read), a fake
// client: `select` is the owners lookup of the walk-in notifier, `transaction`
// the close's.
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  db: { select: mocks.select, transaction: mocks.transaction },
}));

vi.mock("@/lib/infra/notification-service", () => ({
  createNotification: mocks.createNotification,
  createNotificationsBulk: mocks.createNotificationsBulk,
}));

vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class {
    findPetByToken = mocks.repo.findPetByToken;
    findLatestObservationStarted = mocks.repo.findLatestObservationStarted;
    findOpenBiteCase = mocks.repo.findOpenBiteCase;
    insertObservationEnded = mocks.repo.insertObservationEnded;
    closeObservationIfOpen = mocks.repo.closeObservationIfOpen;
    findActiveOwnership = mocks.repo.findActiveOwnership;
    insertObservationCloseAuditLog = mocks.repo.insertObservationCloseAuditLog;
  },
}));

vi.mock("@/lib/infra/case-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/case-helpers")>()),
  closeCase: mocks.closeCase,
  findOpenCaseForPetAndKind: deathMocks.findOpenCaseForPetAndKind,
}));

vi.mock("@/lib/infra/approval-routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/approval-routing")>()),
  findAuthoritiesForJurisdiction: mocks.findAuthoritiesForJurisdiction,
}));

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidatePath: mocks.revalidatePath,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PET_ID = "b0000000-0000-4000-8000-000000000001";
const BITE_EVENT_ID = "b0000000-0000-4000-8000-000000000002";
const STARTED_EVENT_ID = "b0000000-0000-4000-8000-000000000003";
const ENDED_EVENT_ID = "b0000000-0000-4000-8000-000000000004";
const CLINIC = "Veterinaria San Roque";

// 12:00 UTC is 09:00 in Argentina.
const DEADLINE_ISO = "2026-09-24T12:00:00.000Z";
const BEFORE_DEADLINE = new Date("2026-09-18T15:00:00.000Z");
const AFTER_DEADLINE = new Date("2026-09-25T15:00:00.000Z");

const LICENCE_REFUSAL =
  "El resultado de una observación antirrábica lo registra un profesional con matrícula validada. Si sos veterinario, pedí que se valide tu matrícula desde el perfil de la organización.";

function makeAccess(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    user: { id: "vet-user-1" },
    organizationId: "org-1",
    organizationName: CLINIC,
    pet: {
      id: PET_ID,
      publicToken: "DIM-TEST-0001",
      name: "Pampa",
      species: "dog",
      status: "active" as const,
      dateOfBirth: null,
      rabiesObservationStatus: "in_progress",
    },
    signer: { label: "matrícula 4567", matriculaVerified: true, recordName: null },
    eventAuthorship: { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true },
    error: null,
    ...overrides,
  };
}

/** The owners the walk-in notifier's query returns, and what it was asked. */
const ownersWhere: unknown[] = [];
function answerOwnersWith(rows: Array<{ userId: string }>) {
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: (predicate: unknown) => {
        ownersWhere.push(predicate);
        return Promise.resolve(rows);
      },
    }),
  }));
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type Actions = typeof import("./actions");
let actions: Actions;

function close(outcome: string, token = "DIM-TEST-0001") {
  return actions.atenderCloseRabiesObservationAction(
    "ORG-1",
    token,
    formData({ outcome, closureNotes: "" }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  ownersWhere.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AFTER_DEADLINE);

  mocks.resolveAtenderPet.mockResolvedValue(makeAccess());
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb("fake-tx"),
  );
  mocks.createNotification.mockResolvedValue({ status: "inserted", id: "n-1" });
  mocks.createNotificationsBulk.mockResolvedValue({
    insertedCount: 0,
    duplicateCount: 0,
    deadLetteredCount: 0,
  });
  mocks.closeCase.mockResolvedValue(undefined);
  mocks.findAuthoritiesForJurisdiction.mockResolvedValue(["authority-1", "authority-2"]);
  answerOwnersWith([{ userId: "owner-1" }, { userId: "co-owner-2" }]);

  mocks.repo.findPetByToken.mockResolvedValue({
    id: PET_ID,
    publicToken: "DIM-TEST-0001",
    name: "Pampa",
    species: "dog",
    status: "active",
    rabiesObservationStatus: "in_progress",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });
  mocks.repo.findLatestObservationStarted.mockResolvedValue({
    id: STARTED_EVENT_ID,
    occurredAt: new Date("2026-09-14T12:00:00.000Z"),
    payload: { bite_event_id: BITE_EVENT_ID, observation_until: DEADLINE_ISO },
  });
  mocks.repo.findOpenBiteCase.mockResolvedValue({ id: "case-1" });
  mocks.repo.insertObservationEnded.mockResolvedValue({ id: ENDED_EVENT_ID });
  mocks.repo.closeObservationIfOpen.mockResolvedValue(true);
  // The single `role = 'owner'` row the State's path notifies. If the
  // veterinary path ever goes back to it, the co-owner stops being told.
  mocks.repo.findActiveOwnership.mockResolvedValue({ ownerUserId: "owner-1" });
  mocks.repo.insertObservationCloseAuditLog.mockResolvedValue(undefined);

  actions = await import("./actions");
});

afterEach(() => {
  vi.useRealTimers();
});

function expectNothingWritten() {
  expect(mocks.repo.insertObservationEnded).not.toHaveBeenCalled();
  expect(mocks.repo.closeObservationIfOpen).not.toHaveBeenCalled();
  expect(mocks.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
  expect(mocks.closeCase).not.toHaveBeenCalled();
  expect(mocks.createNotification).not.toHaveBeenCalled();
  expect(mocks.createNotificationsBulk).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------

describe("atenderCloseRabiesObservationAction — the licence gate", () => {
  it("REFUSES a signer without a validated matrícula, and writes nothing", async () => {
    // Both shapes a non-licensed signer can arrive in: the organization tier a
    // plain member signs at, and a vet role whose matrícula is not verified.
    const unlicensed = [
      { authorRole: "shelter", authorOrganizationId: "org-1", authorVerified: false },
      { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: false },
    ];
    for (const eventAuthorship of unlicensed) {
      mocks.resolveAtenderPet.mockResolvedValueOnce(makeAccess({ eventAuthorship }));

      const result = await close("positive_rabies");

      expect(result.error, eventAuthorship.authorRole).toBe(LICENCE_REFUSAL);
      expect(mocks.repo.findPetByToken, eventAuthorship.authorRole).not.toHaveBeenCalled();
      expectNothingWritten();
    }
  });

  it("lets a licensed vet close, signing as a verified professional of this clinic", async () => {
    const result = await close("negative");

    expect(result).toEqual({
      error: null,
      ok: true,
      redirectTo: "/org/ORG-1/atender/DIM-TEST-0001?firmado=1",
    });
    expect(mocks.repo.insertObservationEnded).toHaveBeenCalledTimes(1);
    const [row] = mocks.repo.insertObservationEnded.mock.calls[0];
    expect(row.authorRole).toBe("vet");
    expect(row.authorOrganizationId).toBe("org-1");
    expect(row.authorVerified).toBe(true);
    expect(row.recordedByUserId).toBe("vet-user-1");
  });
});

describe("atenderCloseRabiesObservationAction — the legal window (PO 2026-09-18)", () => {
  it("REFUSES a negative before the deadline, naming the date, and writes nothing", async () => {
    vi.setSystemTime(BEFORE_DEADLINE);

    const result = await close("negative");

    expect(result.error).toContain("termina el 24 de septiembre de 2026 a las 09:00");
    expect(result.redirectTo).toBeUndefined();
    expectNothingWritten();
  });

  it("does not hold back a positive: it closes before the deadline", async () => {
    vi.setSystemTime(BEFORE_DEADLINE);

    const result = await close("positive_rabies");

    expect(result.error).toBeNull();
    expect(mocks.repo.closeObservationIfOpen).toHaveBeenCalledWith(
      PET_ID,
      "completed_positive_rabies",
      expect.any(Date),
      "fake-tx",
    );
  });
});

describe("atenderCloseRabiesObservationAction — one pet, the one the guard resolved", () => {
  it("closes the resolved pet's canonical token, not the raw URL segment", async () => {
    // The guard normalizes the code and refuses an erased pet; the use case's
    // lookup matches exactly and does not filter `deleted_at`. The raw segment
    // must never reach it.
    const result = await close("negative", " dim-test-0001 ");

    expect(mocks.resolveAtenderPet).toHaveBeenCalledWith("ORG-1", " dim-test-0001 ");
    expect(mocks.repo.findPetByToken).toHaveBeenCalledWith("DIM-TEST-0001");
    expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
  });
});

describe("atenderCloseRabiesObservationAction — the owner is told, by name of the clinic", () => {
  it("tells EVERY active owner and co-owner, once each, naming the clinic", async () => {
    await close("negative");

    const sent = mocks.createNotification.mock.calls.map((c) => c[0]);
    expect(sent.map((n) => n.userId)).toEqual(["owner-1", "co-owner-2"]);
    for (const n of sent) {
      expect(n.notificationType).toBe("rabies_observation_completed_professional_owner");
      expect(n.severity).toBe("info");
      expect(n.body).toBe(
        `La observación antirrábica de Pampa fue cerrada por un veterinario matriculado de ${CLINIC} con resultado negativo (animal sano). Si no reconocés esta atención, avisá a la autoridad sanitaria de tu localidad.`,
      );
      expect(n.relatedEventId).toBe(ENDED_EVENT_ID);
      expect(n.relatedCaseId).toBe("case-1");
      expect(n.dedupeKey).toBe(
        `event:${ENDED_EVENT_ID}:${n.userId}:rabies_observation_completed_professional_owner`,
      );
    }
    // ONE notice about the close, not the generic walk-in one beside it — and
    // no owner row smuggled into the bulk path either.
    expect(sent.some((n) => n.notificationType === "clinical_event_recorded")).toBe(false);
    expect(mocks.createNotificationsBulk).toHaveBeenCalledWith([]);
  });

  it("asks for owners AND co-owners that are still active — with no row limit", async () => {
    await close("negative");

    expect(ownersWhere).toHaveLength(1);
    const compiled = new PgDialect().sqlToQuery(ownersWhere[0] as never);
    expect(compiled.sql).toContain('"ownerships"."pet_id" = $1');
    expect(compiled.sql).toContain('"ownerships"."role" in ($2, $3)');
    expect(compiled.sql).toContain('"ownerships"."ended_at" is null');
    expect(compiled.params).toEqual([PET_ID, "owner", "co_owner"]);
  });

  it("a confirmed rabies reaches the owners as URGENT", async () => {
    await close("positive_rabies");

    const sent = mocks.createNotification.mock.calls.map((c) => c[0]);
    expect(sent).toHaveLength(2);
    expect(sent.every((n) => n.severity === "urgent")).toBe(true);
  });
});

describe("atenderCloseRabiesObservationAction — the authority fan-out is durable", () => {
  it("sends the urgent alert through createNotificationsBulk, keyed on the ended event", async () => {
    await close("positive_rabies");

    expect(mocks.findAuthoritiesForJurisdiction).toHaveBeenCalledWith(
      { province: "Buenos Aires", locality: "La Plata" },
      { route: "rabies_observation_positive_authority" },
    );
    expect(mocks.createNotificationsBulk).toHaveBeenCalledTimes(1);
    const [rows] = mocks.createNotificationsBulk.mock.calls[0];
    expect(rows.map((r: { userId: string }) => r.userId)).toEqual(["authority-1", "authority-2"]);
    for (const r of rows) {
      expect(r.notificationType).toBe("rabies_observation_positive_authority");
      expect(r.severity).toBe("urgent");
      expect(r.relatedPetId).toBe(PET_ID);
      expect(r.dedupeKey).toBe(
        `event:${ENDED_EVENT_ID}:${r.userId}:rabies_observation_positive_authority`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PO D8 (2026-09-18) — the vet records a death DURING the observation
// ---------------------------------------------------------------------------

describe("atenderRecordDeathInObservationAction — PO D8", () => {
  const DEATH_EVENT_ID = "b0000000-0000-4000-8000-000000000009";
  const KEY = "c0000000-0000-4000-8000-000000000001";

  function recordDeath(fields: Record<string, string> = {}) {
    return actions.atenderRecordDeathInObservationAction(
      "ORG-1",
      "DIM-TEST-0001",
      formData({
        cause: "sudden",
        occurredAt: "2026-09-18",
        confirmIrreversible: "true",
        clientIdempotencyKey: KEY,
        ...fields,
      }),
    );
  }

  beforeEach(() => {
    vi.setSystemTime(BEFORE_DEADLINE);
    deathMocks.eventsRepo.insertEventIdempotent.mockResolvedValue({
      event: { id: DEATH_EVENT_ID },
      wasNoop: false,
    });
    deathMocks.eventsRepo.insertEvent.mockResolvedValue({ id: ENDED_EVENT_ID });
    deathMocks.eventsRepo.updateDeceased.mockResolvedValue(undefined);
    deathMocks.eventsRepo.findActiveFosters.mockResolvedValue([]);
    deathMocks.eventsRepo.findLatestRabiesObservationStarted.mockResolvedValue({
      id: STARTED_EVENT_ID,
      payload: { bite_event_id: BITE_EVENT_ID, observation_until: DEADLINE_ISO },
    });
    deathMocks.findOpenCaseForPetAndKind.mockResolvedValue(null);
    deathMocks.lockPetForDeathRecord.mockResolvedValue(undefined);
    deathMocks.endSponsorshipForDeceasedPet.mockResolvedValue(null);
    deathMocks.flushNotifications.mockResolvedValue(undefined);
    mocks.clinicMayRecordObservationDeath.mockResolvedValue(true);
  });

  function expectNoDeathWritten() {
    expect(deathMocks.eventsRepo.insertEventIdempotent).not.toHaveBeenCalled();
    expect(mocks.repo.closeObservationIfOpen).not.toHaveBeenCalled();
    expect(mocks.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.createNotificationsBulk).not.toHaveBeenCalled();
  }

  it("REFUSES a signer without a validated matrícula — the close's own gate — and writes nothing", async () => {
    for (const eventAuthorship of [
      { authorRole: "shelter", authorOrganizationId: "org-1", authorVerified: false },
      { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: false },
    ]) {
      mocks.resolveAtenderPet.mockResolvedValueOnce(makeAccess({ eventAuthorship }));
      const result = await recordDeath();
      expect(result.error, eventAuthorship.authorRole).toBe(LICENCE_REFUSAL);
    }
    expectNoDeathWritten();
  });

  it("REFUSES a pet the guard did not resolve (no event.write here, or no code)", async () => {
    mocks.resolveAtenderPet.mockResolvedValueOnce({ ok: false, error: "No tenés acceso." });
    const result = await recordDeath();
    expect(result.error).toBe("No tenés acceso.");
    expectNoDeathWritten();
  });

  it("REFUSES outside a running observation, and without the irreversible confirmation", async () => {
    const base = makeAccess();
    mocks.resolveAtenderPet.mockResolvedValueOnce({
      ...base,
      pet: { ...base.pet, rabiesObservationStatus: "window_expired_unclosed" },
    });
    expect((await recordDeath()).error).toContain("no tiene una observación antirrábica en curso");

    expect((await recordDeath({ confirmIrreversible: "" })).error).toBe(
      "Confirmá que el fallecimiento es definitivo: queda asentado y no se puede deshacer.",
    );
    expectNoDeathWritten();
  });

  it("REFUSES a clinic outside the animal's province that never signed this observation (walk-in trust is not enough for a death)", async () => {
    mocks.clinicMayRecordObservationDeath.mockResolvedValueOnce(false);
    const result = await recordDeath();
    expect(result.error).toContain("Solo puede registrar el fallecimiento una veterinaria");
    expectNoDeathWritten();
    // The reach check is asked about THIS clinic and THIS animal's province.
    expect(mocks.clinicMayRecordObservationDeath).toHaveBeenCalledWith(
      expect.objectContaining({ petProvince: expect.anything() }),
    );
  });

  it("writes the canonical death, closes the observation as THIS vet, audits it, alerts the authority and every owner", async () => {
    const result = await recordDeath();

    expect(result).toEqual({
      error: null,
      ok: true,
      redirectTo: "/org/ORG-1/atender/DIM-TEST-0001?firmado=1",
    });

    // One death_recorded, on the spine, signed by the licensed vet of this clinic.
    expect(deathMocks.eventsRepo.insertEventIdempotent).toHaveBeenCalledTimes(1);
    const [death] = deathMocks.eventsRepo.insertEventIdempotent.mock.calls[0];
    expect(death).toMatchObject({
      petId: PET_ID,
      eventType: "death_recorded",
      recordedByUserId: "vet-user-1",
      authorRole: "vet",
      authorOrganizationId: "org-1",
      authorVerified: true,
      clientIdempotencyKey: KEY,
    });
    expect(death.payload).toMatchObject({
      cause: "sudden",
      confirmed_by_vet: true,
      during_rabies_observation: true,
    });

    // The observation's end, signed by the vet, pointing at the death.
    const [ended] = deathMocks.eventsRepo.insertEvent.mock.calls[0];
    expect(ended).toMatchObject({
      eventType: "rabies_observation_ended",
      recordedByUserId: "vet-user-1",
      authorRole: "vet",
      authorOrganizationId: "org-1",
      authorVerified: true,
      caseId: "case-1",
    });
    expect(ended.payload).toMatchObject({
      outcome: "dead",
      closed_by_role: "vet",
      death_event_id: DEATH_EVENT_ID,
      observation_started_event_id: STARTED_EVENT_ID,
    });

    // The GUARDED close, not the unguarded projection update.
    expect(mocks.repo.closeObservationIfOpen).toHaveBeenCalledWith(
      PET_ID,
      "completed_dead",
      expect.any(Date),
      "fake-tx",
    );
    expect(deathMocks.eventsRepo.updateRabiesObservationStatus).not.toHaveBeenCalled();
    expect(mocks.closeCase).toHaveBeenCalledWith(
      { caseId: "case-1", reason: "resolved", closedByUserId: "vet-user-1" },
      "fake-tx",
    );

    // The accountability row, in the same transaction.
    expect(mocks.repo.insertObservationCloseAuditLog).toHaveBeenCalledTimes(1);
    const [audit, auditTx] = mocks.repo.insertObservationCloseAuditLog.mock.calls[0];
    expect(auditTx).toBe("fake-tx");
    expect(audit).toMatchObject({
      action: "rabies_observation_closed_professional",
      actorUserId: "vet-user-1",
      payload: { outcome: "dead", closed_by_role: "vet", death_event_id: DEATH_EVENT_ID },
      after: { rabies_observation_status: "completed_dead" },
    });

    // The authority: URGENT, durable, keyed on the death.
    expect(mocks.findAuthoritiesForJurisdiction).toHaveBeenCalledWith(
      { province: "Buenos Aires", locality: "La Plata" },
      { route: "rabies_observation_completed_dead_authority" },
    );
    const authorityRows = mocks.createNotificationsBulk.mock.calls.flatMap(([rows]) => rows);
    expect(authorityRows.map((r: { userId: string }) => r.userId)).toEqual([
      "authority-1",
      "authority-2",
    ]);
    for (const r of authorityRows) {
      expect(r.notificationType).toBe("rabies_observation_completed_dead_authority");
      expect(r.severity).toBe("urgent");
      expect(r.dedupeKey).toBe(
        `event:${DEATH_EVENT_ID}:${r.userId}:rabies_observation_completed_dead_authority`,
      );
    }

    // Every active owner and co-owner, URGENT, the clinic named, keyed on the death.
    const sent = mocks.createNotification.mock.calls.map((c) => c[0]);
    expect(sent.map((n) => n.userId)).toEqual(["owner-1", "co-owner-2"]);
    for (const n of sent) {
      expect(n.severity).toBe("urgent");
      expect(n.notificationType).toBe("rabies_observation_completed_professional_owner");
      expect(n.body).toContain(
        `Un veterinario matriculado de ${CLINIC} registró el fallecimiento de Pampa`,
      );
      expect(n.relatedEventId).toBe(DEATH_EVENT_ID);
    }
  });

  it("a double submit (same key) resolves to the first death: no second close, alert or notice", async () => {
    await recordDeath();
    vi.clearAllMocks();
    mocks.resolveAtenderPet.mockResolvedValue(makeAccess());
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb("fake-tx"),
    );
    mocks.repo.findPetByToken.mockResolvedValue({
      id: PET_ID,
      publicToken: "DIM-TEST-0001",
      name: "Pampa",
      species: "dog",
      status: "active",
      rabiesObservationStatus: "in_progress",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    });
    mocks.repo.findOpenBiteCase.mockResolvedValue({ id: "case-1" });
    deathMocks.findOpenCaseForPetAndKind.mockResolvedValue(null);
    deathMocks.lockPetForDeathRecord.mockResolvedValue(undefined);
    deathMocks.flushNotifications.mockResolvedValue(undefined);
    // The idempotent insert finds the row the first submit wrote.
    deathMocks.eventsRepo.insertEventIdempotent.mockResolvedValue({
      event: { id: DEATH_EVENT_ID },
      wasNoop: true,
    });

    const replay = await recordDeath();

    expect(replay.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
    expect(deathMocks.eventsRepo.insertEvent).not.toHaveBeenCalled();
    expect(mocks.repo.closeObservationIfOpen).not.toHaveBeenCalled();
    expect(mocks.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
    expect(mocks.findAuthoritiesForJurisdiction).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("a close that landed in between aborts the death with it — nothing half-recorded, nobody alerted", async () => {
    mocks.repo.closeObservationIfOpen.mockResolvedValueOnce(false);

    const result = await recordDeath();

    expect(result.error).toContain("otra persona cerró esta observación mientras tanto");
    expect(mocks.repo.insertObservationCloseAuditLog).not.toHaveBeenCalled();
    expect(mocks.findAuthoritiesForJurisdiction).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });
});
