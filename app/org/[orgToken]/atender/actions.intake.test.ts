// The Atender door to "Estado al ingreso" (vet-visit-record, 2026-09-29): only
// a matriculated vet, refused BEFORE a visit is opened; the visit the action
// resolves is the one the use-case writes into; a matched symptom's notices go
// out after commit; the walk-in exit tells the owner — except on a replay.
//
// The rows themselves (one visit_id across intake, weight and symptom; replay
// writes once) are pinned against the real spine in
// src/modules/events/application/clinical/condition-at-intake-use-case.test.ts
// and src/modules/visits/__tests__/visit-service.test.ts. This file pins the
// action's orchestration.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventFormState } from "@/src/modules/events/actions";

const mockOpenAtenderVisit = vi.hoisted(() => vi.fn());
vi.mock("./atender-visit", () => ({
  atenderEventsRepository: vi.fn(),
  openAtenderVisit: mockOpenAtenderVisit,
}));

const mockResolveAtenderPet = vi.hoisted(() => vi.fn());
vi.mock("./atender-access", () => ({
  ATENDER_TOKEN_PATTERN: /^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  normalizeAtenderToken: (s: string) => s,
  resolveAtenderPet: mockResolveAtenderPet,
}));

vi.mock("@/db", () => ({
  db: {
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));

const mockNotifyOwners = vi.hoisted(() => vi.fn().mockResolvedValue({ delivered: 1 }));
vi.mock("@/lib/infra/notify-owners-of-clinical-event", () => ({
  notifyOwnersOfClinicalEvent: mockNotifyOwners,
}));

const mockCreateNotificationsBulk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: mockCreateNotificationsBulk,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const mockRecordIntake = vi.hoisted(() => vi.fn());
vi.mock(
  "@/src/modules/events/application/clinical/condition-at-intake-use-case",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/src/modules/events/application/clinical/condition-at-intake-use-case")
    >()),
    recordConditionAtIntake: mockRecordIntake,
  }),
);

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class EventsRepository {},
}));

vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class SurveillanceRepository {
    findPetByToken = vi.fn().mockResolvedValue({
      id: "pet-1",
      publicToken: "DIM-TEST-0001",
      species: "dog",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      localityId: null,
      placeMethod: null,
    });
  },
}));

const VET = { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true };
const VISIT = {
  id: "visit-1",
  petId: "pet-1",
  organizationId: "org-1",
  vetUserId: "vet-user-1",
  modality: "home",
  appointmentId: null,
  openedAt: new Date("2026-09-21T12:00:00Z"),
  closedAt: null,
  closeReason: null,
};

function access(eventAuthorship: Record<string, unknown>) {
  return {
    ok: true as const,
    user: { id: "vet-user-1" },
    organizationId: "org-1",
    organizationName: "Clínica del Parque",
    pet: {
      id: "pet-1",
      publicToken: "DIM-TEST-0001",
      name: "Firulais",
      species: "dog",
      status: "active",
      dateOfBirth: "2020-01-01",
      rabiesObservationStatus: null,
    },
    signer: { label: "Dra. Test", matriculaVerified: eventAuthorship.authorVerified === true },
    eventAuthorship,
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type Actions = typeof import("./actions");
let actions: Actions;
const call = (fields: Record<string, string>): Promise<EventFormState> =>
  actions.atenderConditionAtIntakeAction(
    "ORG-1",
    "DIM-TEST-0001",
    { error: null },
    formData(fields),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  mockOpenAtenderVisit.mockResolvedValue({ ok: true, visit: VISIT, created: true });
  actions = await import("./actions");
});

describe("atenderConditionAtIntakeAction", () => {
  it("refuses a signer without a validated matrícula BEFORE opening a visit", async () => {
    mockResolveAtenderPet.mockResolvedValue(
      access({ authorRole: "shelter", authorOrganizationId: "org-1", authorVerified: false }),
    );
    const result = await call({ generalCondition: "good" });
    expect(result.error).toContain("matrícula validada");
    expect(mockOpenAtenderVisit).not.toHaveBeenCalled();
    expect(mockRecordIntake).not.toHaveBeenCalled();
  });

  it("refuses an unparseable form with the parser's sentence, before opening a visit", async () => {
    mockResolveAtenderPet.mockResolvedValue(access(VET));
    const result = await call({ generalCondition: "excellent" });
    expect(result.error).toBe("Elegí el estado general del animal al ingreso.");
    expect(mockOpenAtenderVisit).not.toHaveBeenCalled();
  });

  it("withholds everything when the walk-in authorization is refused", async () => {
    mockResolveAtenderPet.mockResolvedValue({ ok: false, reason: "NOT_FOUND", error: "No." });
    const result = await call({ generalCondition: "good" });
    expect(result.error).toBe("No.");
    expect(mockOpenAtenderVisit).not.toHaveBeenCalled();
    expect(mockRecordIntake).not.toHaveBeenCalled();
  });

  it("writes into the visit it resolved, flushes a matched symptom's notices, and alerts the owner", async () => {
    mockResolveAtenderPet.mockResolvedValue(access(VET));
    mockRecordIntake.mockResolvedValue({
      ok: true,
      value: {
        eventId: "evt-intake",
        wasDuplicate: false,
        weightEventId: "evt-w",
        symptomEventId: "evt-s",
      },
      notifications: [
        {
          userId: "govt-1",
          notificationType: "symptom_signal",
          relatedEventId: "evt-s",
          title: "t",
          body: "b",
        },
      ],
    });
    const result = await call({ generalCondition: "poor", weightKg: "8,5" });

    expect(result.error).toBeNull();
    expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
    expect(mockOpenAtenderVisit).toHaveBeenCalledTimes(1);
    const [input] = mockRecordIntake.mock.calls[0];
    expect(input).toMatchObject({
      visit: { id: "visit-1", organizationId: "org-1", modality: "home" },
      pet: { id: "pet-1", species: "dog", jurisdictionProvince: "Buenos Aires" },
      fields: { generalCondition: "poor", weightKg: "8.50" },
    });
    expect(mockCreateNotificationsBulk).toHaveBeenCalledWith([
      expect.objectContaining({ dedupeKey: "event:evt-s:govt-1:symptom_signal" }),
    ]);
    expect(mockNotifyOwners).toHaveBeenCalledTimes(1);
    expect(mockNotifyOwners.mock.calls[0][0]).toMatchObject({
      eventId: "evt-intake",
      eventType: "condition_at_intake_recorded",
    });
  });

  it("a replay still gets the receipt but does not alert the owner twice", async () => {
    mockResolveAtenderPet.mockResolvedValue(access(VET));
    mockRecordIntake.mockResolvedValue({
      ok: true,
      value: {
        eventId: "evt-intake",
        wasDuplicate: true,
        weightEventId: null,
        symptomEventId: null,
      },
      notifications: [],
    });
    const result = await call({ generalCondition: "good" });
    expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
    expect(mockNotifyOwners).not.toHaveBeenCalled();
    expect(mockCreateNotificationsBulk).not.toHaveBeenCalled();
  });

  it("the use-case's refusal (a second intake) reaches the vet as its sentence", async () => {
    mockResolveAtenderPet.mockResolvedValue(access(VET));
    mockRecordIntake.mockResolvedValue({ ok: false, error: "Ya registrado." });
    const result = await call({ generalCondition: "good" });
    expect(result.error).toBe("Ya registrado.");
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });
});
