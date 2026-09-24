// The walk-in owner alert, at the ACTION edge.
//
// resolveAtenderPet lets any org with event.write write on any pet in the
// country from a photo of the tag — by design (see its header; the PO chose
// detection over prevention so real clinical care is not broken). The alert to
// the owner is the entire mitigation, so it is tested here as behaviour of the
// action, not only as behaviour of the helper: every walk-in writer must emit
// exactly one alert per committed event, with the facts the owner is shown, and
// NONE must emit one when nothing was written.
//
// The static companion is scripts/check-atender-owner-alerts.ts, which catches
// the writer that is added tomorrow and never gets a test at all.
//
// Mocks mirror ./actions.signing.test.ts. Note what is NOT mocked:
// ./atender-signature-completion — the real completion path runs, so this
// exercises the actual coupling between "returned success" and "owner told".

import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatDate } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";

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

vi.mock("./atender-declared-events", () => ({
  rejectIfAlreadySigned: vi.fn().mockResolvedValue(null),
  attemptedChipMatchesDeclaration: vi.fn().mockResolvedValue(true),
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

const mockUploadAttachmentIfPresent = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null }),
);
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: mockUploadAttachmentIfPresent,
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn().mockResolvedValue({ microchip: null, tattoo: null }),
}));

vi.mock("@/lib/reference/drugs", () => ({
  findDrugByLabel: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/reference/lookups", () => ({
  findVaccineByName: vi.fn().mockReturnValue({
    name: "Antirrábica",
    species: ["dog"],
    isCore: true,
    intervalMonths: 12,
  }),
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

const mockCreateVaccination = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/medical/vaccination-use-case", () => ({
  createVaccination: mockCreateVaccination,
}));
const mockCreateDeworming = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/medical/deworming-use-case", () => ({
  createDeworming: mockCreateDeworming,
}));
const mockCreateClinicalInfo = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/clinical/clinical-info-use-case", () => ({
  createClinicalInfo: mockCreateClinicalInfo,
}));
const mockCreateMedicationStart = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/medical/medication-start-use-case", () => ({
  createMedicationStart: mockCreateMedicationStart,
}));
const mockCreateNote = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/identity/note-use-case", () => ({
  createNote: mockCreateNote,
}));
const mockCreateMicrochip = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/identity/microchip-use-case", () => ({
  createMicrochip: mockCreateMicrochip,
}));
const mockCreateSterilization = vi.hoisted(() => vi.fn());
vi.mock("@/src/modules/events/application/medical/sterilization-use-case", () => ({
  createSterilization: mockCreateSterilization,
}));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class EventsRepository {},
}));

vi.mock("./atender-vaccine-gate", () => ({
  hasUncataloguedVaccineFlag: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A past date, so the plausibility guard (real, unmocked) lets it through. */
const OCCURRED_AT = "2026-07-16";
const OCCURRED_AT_ES = "16 de julio de 2026";

function makeAccess(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    user: { id: "vet-user-1" },
    organizationId: "org-1",
    organizationName: "Refugio Patitas del Norte",
    pet: { ...BASE_PET },
    signer: { label: "Dra. Test", matriculaVerified: true },
    eventAuthorship: { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true },
    error: null,
    ...overrides,
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/**
 * Every walk-in writer, with the minimum valid form for each and the event type
 * the owner must be told about. Deliberately a table over the SEVEN that exist
 * today: if an eighth appears, the static fence fails in CI and points here.
 */
const WRITERS = [
  {
    action: "atenderVaccinationAction",
    useCase: () => mockCreateVaccination,
    eventId: "evt-vac",
    eventType: "vaccination_administered",
    fields: { vaccineName: "Antirrábica", occurredAt: OCCURRED_AT },
  },
  {
    action: "atenderDewormingAction",
    useCase: () => mockCreateDeworming,
    eventId: "evt-dew",
    eventType: "deworming_administered",
    fields: { product: "Drontal", type: "internal", occurredAt: OCCURRED_AT },
  },
  {
    action: "atenderClinicalInfoAction",
    useCase: () => mockCreateClinicalInfo,
    eventId: "evt-cli",
    eventType: "clinical_info_logged",
    fields: { subKind: "surgery", title: "Radiografía", occurredAt: OCCURRED_AT },
  },
  {
    action: "atenderMedicationStartAction",
    useCase: () => mockCreateMedicationStart,
    eventId: "evt-med",
    eventType: "medication_started",
    fields: {
      drugName: "Meloxicam",
      dose: "1 mg",
      occurredAt: OCCURRED_AT,
      frequency: "daily",
    },
  },
  {
    action: "atenderNoteAction",
    useCase: () => mockCreateNote,
    eventId: "evt-note",
    eventType: "note_added",
    fields: { text: "Control general", occurredAt: OCCURRED_AT },
  },
  {
    action: "atenderMicrochipAction",
    useCase: () => mockCreateMicrochip,
    eventId: "evt-chip",
    eventType: "microchip_implanted",
    boundArg: null,
    fields: { chipNumber: "982000123456789", occurredAt: OCCURRED_AT },
  },
  {
    action: "atenderSterilizationAction",
    useCase: () => mockCreateSterilization,
    eventId: "evt-ster",
    eventType: "sterilization_performed",
    boundArg: null,
    fields: { procedure: "castration", occurredAt: OCCURRED_AT },
  },
] as const;

type Actions = typeof import("./actions");

/** Call a writer. The two sign-off actions take one extra bound argument. */
function invoke(actions: Actions, writer: (typeof WRITERS)[number]): Promise<EventFormState> {
  const fd = formData(writer.fields);
  const fn = actions[writer.action] as (...args: unknown[]) => Promise<EventFormState>;
  return "boundArg" in writer
    ? fn("ORG-1", "DIM-TEST-0001", writer.boundArg, { error: null }, fd)
    : fn("ORG-1", "DIM-TEST-0001", { error: null }, fd);
}

// ---------------------------------------------------------------------------

describe("atender walk-in — the owner is told, on every writer", () => {
  let actions: Actions;

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

  it("sends the alert with the pet, the event, the signer and the clinical date", async () => {
    mockCreateVaccination.mockResolvedValue({ ok: true, value: { eventId: "evt-vac" } });

    const result = await invoke(actions, WRITERS[0]);

    expect(result.error).toBeNull();
    expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
    expect(mockNotifyOwners).toHaveBeenCalledTimes(1);

    const alert = mockNotifyOwners.mock.calls[0][0];
    expect(alert.petId).toBe("pet-1");
    expect(alert.petName).toBe("Firulais");
    expect(alert.petPublicToken).toBe("DIM-TEST-0001");
    expect(alert.eventId).toBe("evt-vac");
    expect(alert.eventType).toBe("vaccination_administered");
    // WHO: the organization, which is what the owner can act on — not the
    // individual signer's name, which the walk-in surface never promises.
    expect(alert.authorLabel).toBe("Refugio Patitas del Norte");
    // The signer's id travels so the helper can drop a self-authored write.
    expect(alert.authorUserId).toBe("vet-user-1");
    // WHEN: the DECLARED clinical date, rendered AR-correct.
    expect(formatDate(alert.occurredAt)).toBe(OCCURRED_AT_ES);
  });

  for (const writer of WRITERS) {
    it(`${writer.action} alerts the owner exactly once, tagged ${writer.eventType}`, async () => {
      writer.useCase().mockResolvedValue({ ok: true, value: { eventId: writer.eventId } });

      const result = await invoke(actions, writer);

      expect(result.error).toBeNull();
      expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
      expect(mockNotifyOwners).toHaveBeenCalledTimes(1);
      const alert = mockNotifyOwners.mock.calls[0][0];
      expect(alert.eventId).toBe(writer.eventId);
      expect(alert.eventType).toBe(writer.eventType);
      expect(formatDate(alert.occurredAt)).toBe(OCCURRED_AT_ES);
    });
  }
});

describe("atender walk-in — no write, no alert", () => {
  let actions: Actions;

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

  it("stays silent when the use-case REFUSES the write", async () => {
    mockCreateVaccination.mockResolvedValue({ ok: false, error: "Vacuna duplicada." });

    const result = await invoke(actions, WRITERS[0]);

    // Pinned to the exact refusal string: `toHaveProperty("error")` would be
    // satisfied by any other error the action returns a line later.
    expect(result.error).toBe("Vacuna duplicada.");
    expect(result.redirectTo).toBeUndefined();
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });

  it("stays silent when the use-case THROWS", async () => {
    mockCreateVaccination.mockRejectedValue(new Error("db down"));

    const result = await invoke(actions, WRITERS[0]);

    expect(result.error).toBe("No se pudo registrar la vacuna: db down");
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });

  it("stays silent when validation rejects BEFORE any write", async () => {
    mockCreateVaccination.mockResolvedValue({ ok: true, value: { eventId: "evt-vac" } });

    const result = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ vaccineName: "Antirrábica", occurredAt: "" }),
    );

    expect(result.error).toBe("Falta la fecha de aplicación.");
    expect(mockCreateVaccination).not.toHaveBeenCalled();
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });

  it("stays silent when the walk-in authorization itself is refused", async () => {
    mockResolveAtenderPet.mockResolvedValue({
      ok: false,
      error: "Esta mascota está registrada como fallecida y no acepta nuevos eventos.",
    });

    const result = await invoke(actions, WRITERS[0]);

    expect(result.error).toBe(
      "Esta mascota está registrada como fallecida y no acepta nuevos eventos.",
    );
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });

  it("stays silent when the write committed WITHOUT a new event id (idempotent replay)", async () => {
    // The signer still gets their receipt — there is simply no new event to
    // tell the owner about, and re-alerting on a replay is exactly the noise
    // this design refuses.
    mockCreateVaccination.mockResolvedValue({ ok: true, value: { eventId: null } });

    const result = await invoke(actions, WRITERS[0]);

    expect(result.redirectTo).toBe("/org/ORG-1/atender/DIM-TEST-0001?firmado=1");
    expect(mockNotifyOwners).not.toHaveBeenCalled();
  });
});
