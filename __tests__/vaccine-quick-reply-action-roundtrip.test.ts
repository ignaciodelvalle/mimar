// Notification quick-reply (capture-console surface #4) — round trip proof
// that the autoconfirm path's FormData is exactly what the REAL
// createVaccinationAction (src/modules/events/actions.ts) accepts and
// succeeds with.
//
// Mock scaffolding duplicated from
// src/modules/events/__tests__/actions-parity.test.ts (the existing vaccine
// action test harness) — createVaccinationAction pulls in every sibling
// use-case at module load time, so the whole set must be mocked for the
// import to resolve, not just the vaccination use-case this file cares
// about. Kept as a separate file (rather than adding to actions-parity.test.ts)
// so this feature's tests stay isolated in their own territory.
//
// What this proves, on top of __tests__/vaccine-checkin-autoconfirm.test.tsx
// (which proves VaccinationForm calls its `action` prop with the right
// FormData when autoConfirm validates): that FormData shape — vaccineName
// from the reminder title, occurredAt=today, sourceReminderId set,
// sameDayOverride="0" — is accepted by the REAL action and reaches the
// vaccination use-case with sourceReminderId intact (the reminder-closing
// contract buildReminderVaccineUrl exists for).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { todayIsoInAr } from "@/lib/utils/format";

const BASE_PET = {
  id: "pet-1",
  name: "Firulais",
  species: "dog",
  dateOfBirth: "2020-01-01",
  status: "active",
  rabiesObservationStatus: null,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
  discloseFirstNameWhenLost: false,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: false,
  allowFinderFormWhenLost: false,
};

const mockRequireAlivePetAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/pet-access", () => ({
  requireAlivePetAccess: mockRequireAlivePetAccess,
  requirePetAccess: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn().mockResolvedValue({ deletedAt: null }),
}));

const mockUploadAttachmentIfPresent = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null }),
);
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: mockUploadAttachmentIfPresent,
}));

vi.mock("@/lib/reference/diseases", () => ({
  findDisease: vi.fn().mockReturnValue({ code: "rabies", label: "Rabia" }),
  isReportable: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/reference/drugs", () => ({
  findDrugByLabel: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/reference/medication-schedule", () => ({
  FREQUENCY_LABELS: {},
  generateDoseSchedule: vi.fn().mockReturnValue([]),
  intervalHoursForFrequency: vi.fn().mockReturnValue(24),
  parseFrequencyFields: vi.fn().mockReturnValue({
    error: null,
    frequency: "daily",
    customHours: null,
    durationDays: null,
    firstDoseAt: new Date("2026-01-01T00:00:00Z"),
  }),
}));

vi.mock("@/lib/domain/location-normalize", () => ({
  CoordError: class CoordError extends Error {},
  normalizeLocationForWrite: vi.fn().mockResolvedValue({
    province: "Buenos Aires",
    locality: "La Plata",
    lat: null,
    lng: null,
  }),
}));

vi.mock("@/lib/domain/location-value", () => ({
  parseLocationFromFormData: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
  }),
}));

vi.mock("@/src/modules/surveillance/application/enqueue-eno-trigger", () => ({
  enqueueEnoTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/infra/case-helpers", () => ({
  findOpenCaseForPetAndKind: vi.fn().mockResolvedValue(null),
  openCase: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class SurveillanceRepository {},
}));

vi.mock("@/db", () => ({
  db: {
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    }),
  },
  profiles: {},
  pets: {},
  notifications: { $inferInsert: {} },
}));

const mockFindSameDayEventOfType = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockRepoInsertEventIdempotent = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/events/infrastructure/events-repository", () => {
  class FakeEventsRepository {
    findSameDayEventOfType = mockFindSameDayEventOfType;
    insertEventIdempotent = mockRepoInsertEventIdempotent;
    insertAttachment = vi.fn();
    completeReminder = vi.fn();
    insertReminders = vi.fn();
    findOpenReminders = vi.fn().mockResolvedValue([]);
    updateWeightProjection = vi.fn();
  }
  return { EventsRepository: FakeEventsRepository };
});

const mockCreateVaccination = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-1" }, notifications: [] }),
);
vi.mock("../src/modules/events/application/medical/vaccination-use-case", () => ({
  createVaccination: mockCreateVaccination,
}));

// Every other use-case actions.ts imports at module load — stubbed to
// resolve so the import graph loads without pulling in real DB code.
vi.mock("../src/modules/events/application/medical/weight-use-case", () => ({
  createWeight: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/medical/deworming-use-case", () => ({
  createDeworming: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/medical/sterilization-use-case", () => ({
  createSterilization: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/medical/medication-start-use-case", () => ({
  createMedicationStart: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/medical/medication-end-use-case", () => ({
  createMedicationEnd: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/medical/medication-dose-taken-use-case", () => ({
  markMedicationDoseTaken: vi.fn().mockResolvedValue({ ok: true, value: { petPublicToken: "x" } }),
}));
vi.mock("../src/modules/events/application/identity/microchip-use-case", () => ({
  createMicrochip: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/identity/dangerous-breed-attestation-use-case", () => ({
  createDangerousBreedAttestation: vi
    .fn()
    .mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/identity/note-use-case", () => ({
  createNote: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/clinical/vet-visit-use-case", () => ({
  createVetVisit: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/clinical/clinical-info-use-case", () => ({
  createClinicalInfo: vi.fn().mockResolvedValue({ ok: true, value: {}, notifications: [] }),
}));
vi.mock("../src/modules/events/application/clinical/record-disease-diagnosis-use-case", () => ({
  recordDiseaseDiagnosisWriter: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));
vi.mock("../src/modules/events/application/lifecycle/death-record-use-case", () => ({
  createDeathRecord: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));
vi.mock("../src/modules/events/application/lifecycle/set-pet-found-use-case", () => ({
  setPetFound: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/modules/events/application/lifecycle/set-pet-lost-use-case", () => ({
  setPetLostWriter: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock("../src/modules/events/application/lifecycle/update-lost-last-seen-use-case", () => ({
  updateLostLastSeen: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock("../src/modules/events/application/surveillance/symptom-observed-use-case", () => ({
  createSymptomObservedWriter: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));

function makeAliveAccess() {
  return {
    ok: true as const,
    supabase: { storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) } },
    user: { id: "user-1" },
    pet: BASE_PET,
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    accessPath: "owner",
  };
}

type ActionsModule = typeof import("../src/modules/events/actions-medical");

describe("createVaccinationAction — notification quick-reply autoconfirm round trip", () => {
  let createVaccinationAction: ActionsModule["createVaccinationAction"];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireAlivePetAccess.mockResolvedValue(makeAliveAccess());
    mockFindSameDayEventOfType.mockResolvedValue(null);
    mockRepoInsertEventIdempotent.mockResolvedValue({ event: { id: "evt-x" }, wasNoop: false });
    mockUploadAttachmentIfPresent.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });

    // Moved with the clinical family on 2026-08-21.
    const mod = await import("../src/modules/events/actions-medical");
    createVaccinationAction = mod.createVaccinationAction;
  });

  it("accepts the exact FormData the autoconfirm path produces (reminder-title vaccineName + today + sourceReminderId) and succeeds", async () => {
    // Mirrors what VaccinationForm submits when autoConfirm validates: the
    // reminder-linked page prefilled vaccineName from reminder.title,
    // occurredAt defaults to today, sourceReminderId carries the reminder so
    // it closes on submit — see app/(app)/mis-mascotas/[publicToken]/eventos/
    // nuevo/vacuna/page.tsx and VaccinationForm's hidden sourceReminderId input.
    const fd = new FormData();
    fd.set("vaccineName", "Antirrábica");
    fd.set("occurredAt", todayIsoInAr());
    fd.set("sourceReminderId", "reminder-quick-reply-1");
    fd.set("clientIdempotencyKey", "test-idempotency-key");
    fd.set("sameDayOverride", "0");

    const result = await createVaccinationAction("DIM-TEST-0001", { error: null }, fd);

    expect(result.error).toBeNull();
    expect(result.sameDayPrompt).toBeUndefined();
    expect(mockCreateVaccination).toHaveBeenCalledOnce();
    const [args] = mockCreateVaccination.mock.calls[0];
    expect(args.sourceReminderId).toBe("reminder-quick-reply-1");
  });
});
