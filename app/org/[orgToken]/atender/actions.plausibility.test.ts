// Plausibility wiring tests for the atender (walk-in clinical signing) edge —
// PO decision 2026-07-16: the professional edge runs the same date-only
// IMPOSSIBLE-date guard as the owner edge (P4 item 1).
//
// Module-level unit tests — mock every static import atender/actions.ts pulls
// in so we verify action-edge orchestration without a DB. Mirrors
// src/modules/events/__tests__/actions-parity.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { todayIsoInAr } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const BASE_PET = {
  id: "pet-1",
  publicToken: "DIM-TEST-0001",
  name: "Firulais",
  species: "dog",
  status: "active" as const,
  dateOfBirth: "2020-01-01",
};

const mockResolveAtenderPet = vi.hoisted(() => vi.fn());
vi.mock("./atender-access", async () => {
  // The real normaliser (lib/domain/dim-token.ts, zero dependencies): ASCII
  // a-z only, not the browser's Unicode `toUpperCase()`, which turns
  // lookalikes (Turkish dotless `ı`) into a real token shape.
  const { normalizeDimTokenInput } = await import("@/lib/domain/dim-token");
  return {
    ATENDER_TOKEN_PATTERN: /^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    normalizeAtenderToken: normalizeDimTokenInput,
    resolveAtenderPet: mockResolveAtenderPet,
  };
});

vi.mock("@/db", () => ({
  db: {
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));

const mockNotifyOwners = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/infra/notify-owners-of-clinical-event", () => ({
  notifyOwnersOfClinicalEvent: mockNotifyOwners,
}));

const mockUploadAttachmentIfPresent = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null }),
);
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: mockUploadAttachmentIfPresent,
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) },
  }),
}));

const mockCreateVaccination = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-1" } }),
);
vi.mock("@/src/modules/events/application/medical/vaccination-use-case", () => ({
  createVaccination: mockCreateVaccination,
}));

const mockCreateDeworming = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-2" } }),
);
vi.mock("@/src/modules/events/application/medical/deworming-use-case", () => ({
  createDeworming: mockCreateDeworming,
}));

const mockCreateClinicalInfo = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-3" } }),
);
vi.mock("@/src/modules/events/application/clinical/clinical-info-use-case", () => ({
  createClinicalInfo: mockCreateClinicalInfo,
}));

const mockCreateMedicationStart = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-4" } }),
);
vi.mock("@/src/modules/events/application/medical/medication-start-use-case", () => ({
  createMedicationStart: mockCreateMedicationStart,
}));

const mockCreateNote = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-5" } }),
);
vi.mock("@/src/modules/events/application/identity/note-use-case", () => ({
  createNote: mockCreateNote,
}));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class EventsRepository {},
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// AR calendar-day fixtures — the guard compares ARGENTINE days, so "today"
// must be the AR day, not the runner's UTC day (they differ 21:00-24:00 AR).
const TODAY_AR = todayIsoInAr();
const TOMORROW_AR = (() => {
  const d = new Date(`${TODAY_AR}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

const FUTURE_ERROR = "La fecha no puede ser futura.";

function makeAccess() {
  return {
    ok: true as const,
    user: { id: "user-1" },
    organizationId: "org-1",
    organizationName: "Clinica Test",
    pet: { ...BASE_PET },
    signer: { label: "Dra. Test", matriculaVerified: true },
    eventAuthorship: { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true },
    error: null,
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("atender actions — date plausibility (PO 2026-07-16)", () => {
  let actions: typeof import("./actions");

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveAtenderPet.mockResolvedValue(makeAccess());
    mockUploadAttachmentIfPresent.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });
    actions = await import("./actions");
  });

  it("atenderVaccinationAction accepts today's AR date and rejects tomorrow's", async () => {
    const base = { vaccineName: "Antirrábica" };
    const ok = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TODAY_AR }),
    );
    expect(ok.error).toBeNull();
    expect(mockCreateVaccination).toHaveBeenCalledOnce();

    const rejected = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TOMORROW_AR }),
    );
    expect(rejected.error).toBe(FUTURE_ERROR);
    expect(mockCreateVaccination).toHaveBeenCalledOnce();
  });

  it("atenderDewormingAction accepts today's AR date and rejects tomorrow's", async () => {
    const base = { product: "Frontline", type: "external" };
    const ok = await actions.atenderDewormingAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TODAY_AR }),
    );
    expect(ok.error).toBeNull();
    expect(mockCreateDeworming).toHaveBeenCalledOnce();

    const rejected = await actions.atenderDewormingAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TOMORROW_AR }),
    );
    expect(rejected.error).toBe(FUTURE_ERROR);
    expect(mockCreateDeworming).toHaveBeenCalledOnce();
  });

  it("atenderClinicalInfoAction accepts today's AR date and rejects tomorrow's", async () => {
    const base = { subKind: "surgery", title: "Cirugía menor" };
    const ok = await actions.atenderClinicalInfoAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TODAY_AR }),
    );
    expect(ok.error).toBeNull();
    expect(mockCreateClinicalInfo).toHaveBeenCalledOnce();

    const rejected = await actions.atenderClinicalInfoAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TOMORROW_AR }),
    );
    expect(rejected.error).toBe(FUTURE_ERROR);
    expect(mockCreateClinicalInfo).toHaveBeenCalledOnce();
  });

  it("atenderMedicationStartAction accepts today's AR date and rejects tomorrow's", async () => {
    const base = { drugName: "Amoxicilina", dose: "250 mg", frequency: "daily" };
    const ok = await actions.atenderMedicationStartAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TODAY_AR }),
    );
    expect(ok.error).toBeNull();
    expect(mockCreateMedicationStart).toHaveBeenCalledOnce();

    const rejected = await actions.atenderMedicationStartAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TOMORROW_AR }),
    );
    expect(rejected.error).toBe(FUTURE_ERROR);
    expect(mockCreateMedicationStart).toHaveBeenCalledOnce();
  });

  it("atenderNoteAction accepts today's AR date and rejects tomorrow's", async () => {
    const base = { text: "Control general sin novedades." };
    const ok = await actions.atenderNoteAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TODAY_AR }),
    );
    expect(ok.error).toBeNull();
    expect(mockCreateNote).toHaveBeenCalledOnce();

    const rejected = await actions.atenderNoteAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ ...base, occurredAt: TOMORROW_AR }),
    );
    expect(rejected.error).toBe(FUTURE_ERROR);
    expect(mockCreateNote).toHaveBeenCalledOnce();
  });

  it("rejects an occurredAt before the pet's date of birth (BEFORE_BIRTH leg)", async () => {
    const rejected = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ vaccineName: "Antirrábica", occurredAt: "2019-12-31" }),
    );
    expect(rejected.error).toMatch(/anterior a la fecha de nacimiento/i);
    expect(mockCreateVaccination).not.toHaveBeenCalled();
  });
});
