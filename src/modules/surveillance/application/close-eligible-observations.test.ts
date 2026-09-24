// Unit tests for application/close-eligible-observations.ts (spec §E).
//
// THE CONTRACT THIS FILE PINS (rewritten 2026-08-17)
// ---------------------------------------------------------------------------
// The sweep must NEVER assert a clinical outcome. It used to insert
// rabies_observation_ended with outcome='negative', closed_by_role='system' and
// recorded_by_user_id NULL — the State's own document saying the animal that bit
// somebody was clear, authored by a cron. The tests below exist to make that
// impossible to reintroduce silently:
//
//   1. no rabies_observation_ended event, ever, from this sweep;
//   2. the status lands on `window_expired_unclosed`, never on a completed_*;
//   3. the bite expediente is NOT auto-expired (nothing was resolved);
//   4. the owner message does not read as an all-clear and does name who can
//      close it;
//   5. copy quotes the window resolved for THIS observation, never a
//      hardcoded 10.

import { describe, expect, it, vi } from "vitest";

import type { PetEvent } from "@/db/schema";
import type {
  SurveillancePet,
  SurveillanceRepository,
} from "../infrastructure/surveillance-repository";
import {
  type CloseEligibleObservationsOptions,
  closeEligibleObservations,
} from "./close-eligible-observations";

type FakeRepo = Partial<Record<keyof SurveillanceRepository, ReturnType<typeof vi.fn>>>;

const NOW = new Date("2024-08-20T12:00:00Z");
const PAST_DUE = new Date("2024-08-10T12:00:00Z"); // before NOW
const FUTURE_DUE = new Date("2024-08-25T12:00:00Z"); // after NOW

const FAKE_BITE_ID = "a0000000-0000-4000-8000-000000000007";
const FAKE_STARTED_ID = "a0000000-0000-4000-8000-000000000008";

function makePet(overrides: Partial<SurveillancePet> = {}): SurveillancePet {
  return {
    id: "pet-cron-1",
    publicToken: "tok-cron-1",
    name: "Coco",
    species: "dog",
    status: "alive",
    rabiesObservationStatus: "in_progress",
    jurisdictionProvince: "Santa Fe",
    jurisdictionLocality: "Rosario",
    ...overrides,
  } as unknown as SurveillancePet;
}

function makeStartedEvent(observationUntil: Date, observationDays: number | null = 10): PetEvent {
  return {
    id: FAKE_STARTED_ID,
    petId: "pet-cron-1",
    eventType: "rabies_observation_started",
    occurredAt: new Date("2024-08-10"),
    recordedAt: new Date("2024-08-10"),
    recordedByUserId: null,
    authorRole: "system",
    authorOrganizationId: null,
    authorVerified: false,
    payload: {
      bite_event_id: FAKE_BITE_ID,
      observation_until: observationUntil.toISOString(),
      ...(observationDays === null ? {} : { observation_days: observationDays }),
      location: "in_situ",
      official_site_organization_id: null,
    },
    caseId: "case-cron-1",
    clientIdempotencyKey: null,
    createdAt: new Date("2024-08-10"),
  } as unknown as PetEvent;
}

function makeRepo(overrides: FakeRepo = {}): SurveillanceRepository {
  return {
    findPetsInProgress: vi.fn().mockResolvedValue([makePet()]),
    findLatestObservationStarted: vi.fn().mockResolvedValue(makeStartedEvent(PAST_DUE)),
    findEscalatingSymptom: vi.fn().mockResolvedValue(null),
    findOpenBiteCase: vi.fn().mockResolvedValue({ id: "case-cron-1" }),
    insertObservationEnded: vi.fn().mockResolvedValue(undefined),
    setObservationStatus: vi.fn().mockResolvedValue(undefined),
    // Por defecto GANA la carrera: devuelve true. Los tests que quieren
    // ejercitar al perdedor lo sobreescriben con false.
    closeObservationIfOpen: vi.fn().mockResolvedValue(true),
    autoExpireBiteCase: vi.fn().mockResolvedValue(undefined),
    findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-cron-1"]),
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    findGovtTargetsForJurisdiction: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

function makeDeps(repoOverrides: FakeRepo = {}) {
  const repo = makeRepo(repoOverrides);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb("fake-tx");
  });
  const findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue([]);
  const createNotificationsBulk = vi.fn().mockResolvedValue(undefined);
  return { repo, transaction, findAuthoritiesForJurisdiction, createNotificationsBulk };
}

/** Rows handed to the DURABLE service (dedupe key + dead-letter), flattened. */
function durableNotifications(deps: ReturnType<typeof makeDeps>): Record<string, unknown>[] {
  return deps.createNotificationsBulk.mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);
}

/**
 * Every notification row written, through either path, flattened — so the
 * owners' notice, which moved to the durable service, is still found by the
 * assertions that only care about content.
 */
function allNotifications(deps: ReturnType<typeof makeDeps>): Record<string, unknown>[] {
  const raw = (
    deps.repo.insertNotifications as unknown as ReturnType<typeof vi.fn>
  ).mock.calls.flatMap((c) => c[0] as Record<string, unknown>[]);
  return [...raw, ...durableNotifications(deps)];
}

const BASE_OPTIONS: CloseEligibleObservationsOptions = { now: NOW };

// ---------------------------------------------------------------------------
// Window elapsed with no professional closure
// ---------------------------------------------------------------------------

describe("closeEligibleObservations — expired window, no professional closure", () => {
  it("returns stats with windowExpiredUnclosed=1 for an eligible pet", async () => {
    const deps = makeDeps();
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.windowExpiredUnclosed).toBe(1);
    expect(stats.scanned).toBe(1);
  });

  it("NEVER inserts a rabies_observation_ended event — no outcome is asserted", async () => {
    const deps = makeDeps();
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
  });

  it("sets pet status to window_expired_unclosed, never to a completed_* value", async () => {
    const deps = makeDeps();
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.repo.closeObservationIfOpen).toHaveBeenCalledWith(
      "pet-cron-1",
      "window_expired_unclosed",
      NOW,
      "fake-tx",
    );
    const statuses = (deps.repo.closeObservationIfOpen as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as string,
    );
    expect(statuses.some((s) => s.startsWith("completed_"))).toBe(false);
  });

  it("leaves the bite expediente OPEN — nothing was resolved", async () => {
    const deps = makeDeps();
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.repo.autoExpireBiteCase).not.toHaveBeenCalled();
  });

  it("does NOT call closeCase either", async () => {
    const deps = makeDeps();
    const closeCaseSpy = vi.fn();
    (deps as unknown as Record<string, unknown>).closeCase = closeCaseSpy;
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(closeCaseSpy).not.toHaveBeenCalled();
  });

  it("tells the owner the observation is still open and who can close it", async () => {
    const deps = makeDeps();
    await closeEligibleObservations(BASE_OPTIONS, deps);
    const owner = allNotifications(deps).find((n) => n.userId === "owner-cron-1");
    expect(owner).toBeDefined();
    expect(owner?.notificationType).toBe("rabies_observation_window_expired_owner");
    const body = String(owner?.body);
    expect(body).toContain("sigue abierta");
    expect(body).toContain("veterinario matriculado");
    // The all-clear the old message gave must be gone in every spelling.
    expect(body).not.toMatch(/sin incidentes|sigue normal|negativ/i);
  });

  it("tells EVERY active owner and co-owner, through the durable service, keyed on the observation", async () => {
    const deps = makeDeps({
      findActiveOwnerUserIds: vi.fn().mockResolvedValue(["owner-cron-1", "coowner-cron-2"]),
    });
    await closeEligibleObservations(BASE_OPTIONS, deps);

    expect(deps.repo.findActiveOwnerUserIds).toHaveBeenCalledWith("pet-cron-1", "fake-tx");
    const owners = durableNotifications(deps).filter(
      (n) => n.notificationType === "rabies_observation_window_expired_owner",
    );
    expect(owners.map((n) => n.userId)).toEqual(["owner-cron-1", "coowner-cron-2"]);
    expect(owners.map((n) => n.dedupeKey)).toEqual([
      `event:${FAKE_STARTED_ID}:owner-cron-1:rabies_observation_window_expired_owner`,
      `event:${FAKE_STARTED_ID}:coowner-cron-2:rabies_observation_window_expired_owner`,
    ]);
    // Not through the raw repo insert any more.
    const raw = (deps.repo.insertNotifications as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((c) => c[0] as Record<string, unknown>[])
      .filter((n) => n.notificationType === "rabies_observation_window_expired_owner");
    expect(raw).toEqual([]);
  });

  it("tells no owner when the guard lost the race to a professional close", async () => {
    const deps = makeDeps({ closeObservationIfOpen: vi.fn().mockResolvedValue(false) });
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.repo.findActiveOwnerUserIds).not.toHaveBeenCalled();
    expect(
      durableNotifications(deps).filter(
        (n) => n.notificationType === "rabies_observation_window_expired_owner",
      ),
    ).toEqual([]);
  });

  it("hands the expired observation to the jurisdiction's authorities", async () => {
    const deps = makeDeps();
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-1"]);
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Santa Fe",
      locality: "Rosario",
    });
    const auth = allNotifications(deps).find((n) => n.userId === "auth-1");
    expect(auth?.notificationType).toBe("rabies_observation_pending_review");
    expect(String(auth?.body)).toContain("sin cierre profesional");
  });

  it("quotes the window resolved for THIS observation, not the national baseline", async () => {
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(makeStartedEvent(PAST_DUE, 14)),
    });
    await closeEligibleObservations(BASE_OPTIONS, deps);
    const owner = allNotifications(deps).find((n) => n.userId === "owner-cron-1");
    expect(String(owner?.body)).toContain("de 14 días");
    expect(String(owner?.body)).not.toContain("10 días");
  });

  it("quotes NO day count when the observation predates observation_days", async () => {
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(makeStartedEvent(PAST_DUE, null)),
    });
    await closeEligibleObservations(BASE_OPTIONS, deps);
    const body = String(allNotifications(deps).find((n) => n.userId === "owner-cron-1")?.body);
    expect(body).not.toMatch(/\d+ días/);
    // …but it still names the exact deadline, which is always computable.
    expect(body).toContain("vencía el");
  });
});

// ---------------------------------------------------------------------------
// Escalating symptom path (spec §E)
// ---------------------------------------------------------------------------

describe("closeEligibleObservations — escalation path", () => {
  it("flags instead of transitioning when an escalating symptom exists", async () => {
    const deps = makeDeps({
      findEscalatingSymptom: vi.fn().mockResolvedValue({ id: "symptom-1" }),
    });
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.windowExpiredUnclosed).toBe(0);
    expect(stats.flaggedForReview).toBe(1);
    // Stays in_progress ON PURPOSE: symptoms compatible with rabies are an
    // ongoing danger, so the public banner must keep saying so.
    expect(deps.repo.closeObservationIfOpen).not.toHaveBeenCalled();
  });

  it("does NOT insert observation_ended when escalating", async () => {
    const deps = makeDeps({
      findEscalatingSymptom: vi.fn().mockResolvedValue({ id: "symptom-1" }),
    });
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.repo.insertObservationEnded).not.toHaveBeenCalled();
  });

  it("notifies authorities when escalating symptom exists (urgent severity)", async () => {
    // 14-day jurisdiction on purpose: this message hardcoded "El período de 10
    // días terminó" until 2026-08-17, so it lied to every jurisdiction that
    // runs a longer window — on the ONE notification that says an animal may
    // be rabid.
    const deps = makeDeps({
      findEscalatingSymptom: vi.fn().mockResolvedValue({ id: "symptom-1" }),
      findLatestObservationStarted: vi.fn().mockResolvedValue(makeStartedEvent(PAST_DUE, 14)),
    });
    deps.findAuthoritiesForJurisdiction = vi.fn().mockResolvedValue(["auth-1"]);
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(deps.findAuthoritiesForJurisdiction).toHaveBeenCalledWith({
      province: "Santa Fe",
      locality: "Rosario",
    });
    const auth = allNotifications(deps).find((n) => n.userId === "auth-1");
    expect(auth?.severity).toBe("urgent");
    expect(String(auth?.body)).toContain("de 14 días");
    expect(String(auth?.body)).not.toContain("10 días");
  });
});

// ---------------------------------------------------------------------------
// Not-yet-due path
// ---------------------------------------------------------------------------

describe("closeEligibleObservations — not yet due", () => {
  it("skips pets whose observation_until is in the future", async () => {
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(makeStartedEvent(FUTURE_DUE)),
    });
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.skippedNotYetDue).toBe(1);
    expect(stats.windowExpiredUnclosed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error handling / idempotency
// ---------------------------------------------------------------------------

describe("closeEligibleObservations — error handling", () => {
  it("records error when no started event found", async () => {
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(null),
    });
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]?.petId).toBe("pet-cron-1");
  });

  it("isolates per-pet failures — other pets still process", async () => {
    const pet1 = makePet({ id: "pet-fail", publicToken: "tok-fail", name: "Fail" });
    const pet2 = makePet({ id: "pet-ok", publicToken: "tok-ok", name: "Ok" });

    const deps = makeDeps({
      findPetsInProgress: vi.fn().mockResolvedValue([pet1, pet2]),
      findLatestObservationStarted: vi
        .fn()
        .mockResolvedValueOnce(null) // pet1: no event → error
        .mockResolvedValueOnce(makeStartedEvent(PAST_DUE)), // pet2: ok
    });
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.errors).toHaveLength(1);
    expect(stats.windowExpiredUnclosed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Robustness: seed/older observations with missing payload fields (QA 2026-07-08)
// ---------------------------------------------------------------------------

describe("closeEligibleObservations — resilient sweep for incomplete payloads", () => {
  it("transitions when observation_until is MISSING (fallback = started.occurredAt + 10d)", async () => {
    // started.occurredAt = 2024-08-10 → fallback deadline 2024-08-20 < NOW.
    const startedNoUntil = {
      ...makeStartedEvent(PAST_DUE),
      payload: {
        bite_event_id: FAKE_BITE_ID,
        location: "in_situ",
        official_site_organization_id: null,
      },
    } as unknown as PetEvent;
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(startedNoUntil),
    });
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.errors).toHaveLength(0);
    expect(stats.windowExpiredUnclosed).toBe(1);
  });

  it("transitions when bite_event_id is MISSING — never throws", async () => {
    const startedNoBite = {
      ...makeStartedEvent(PAST_DUE),
      payload: {
        observation_until: PAST_DUE.toISOString(),
        location: "in_situ",
        official_site_organization_id: null,
      },
    } as unknown as PetEvent;
    const deps = makeDeps({
      findLatestObservationStarted: vi.fn().mockResolvedValue(startedNoBite),
    });
    const stats = await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(stats.errors).toHaveLength(0);
    expect(stats.windowExpiredUnclosed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Audit log parity (spec §E AUDIT_LOG: NONE — no operator acts here)
// ---------------------------------------------------------------------------

describe("closeEligibleObservations — audit_log absence", () => {
  it("does NOT call any insertAudit method", async () => {
    const deps = makeDeps();
    const insertAuditSpy = vi.fn();
    (deps.repo as unknown as Record<string, unknown>).insertAudit = insertAuditSpy;
    await closeEligibleObservations(BASE_OPTIONS, deps);
    expect(insertAuditSpy).not.toHaveBeenCalled();
  });
});
