// Tests for the #5 vaccine-catalog server mirror and the #3 chip/esterilización
// sign-off actions (atenderMicrochipAction / atenderSterilizationAction).
//
// Module-level unit tests — mock every static import atender/actions.ts pulls
// in so we verify action-edge orchestration without a DB. Mirrors
// ./actions.plausibility.test.ts.

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

const mockRejectIfAlreadySigned = vi.hoisted(() => vi.fn().mockResolvedValue(null));
// Proof-of-scan matcher. The real SQL-predicate implementation is pinned
// against the live spine in atender-declared-events.db.test.ts; what the action
// owes is the WIRING — call it whenever a declaration is being confirmed, and
// refuse without writing when it says no.
const mockAttemptedChipMatchesDeclaration = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("./atender-declared-events", () => ({
  rejectIfAlreadySigned: mockRejectIfAlreadySigned,
  attemptedChipMatchesDeclaration: mockAttemptedChipMatchesDeclaration,
}));

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

const mockFetchActiveIdentifications = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ microchip: null, tattoo: null }),
);
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: mockFetchActiveIdentifications,
}));

vi.mock("@/lib/reference/drugs", () => ({
  findDrugByLabel: vi.fn().mockReturnValue(null),
}));

const mockFindVaccineByName = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reference/lookups", () => ({
  findVaccineByName: mockFindVaccineByName,
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

vi.mock("@/src/modules/events/application/medical/deworming-use-case", () => ({
  createDeworming: vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-2" } }),
}));

vi.mock("@/src/modules/events/application/clinical/clinical-info-use-case", () => ({
  createClinicalInfo: vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-3" } }),
}));

vi.mock("@/src/modules/events/application/medical/medication-start-use-case", () => ({
  createMedicationStart: vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-4" } }),
}));

vi.mock("@/src/modules/events/application/identity/note-use-case", () => ({
  createNote: vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-5" } }),
}));

const mockCreateMicrochip = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-6" } }),
);
vi.mock("@/src/modules/events/application/identity/microchip-use-case", () => ({
  createMicrochip: mockCreateMicrochip,
}));

const mockCreateSterilization = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { eventId: "evt-7" } }),
);
vi.mock("@/src/modules/events/application/medical/sterilization-use-case", () => ({
  createSterilization: mockCreateSterilization,
}));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class EventsRepository {},
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TODAY_AR = todayIsoInAr();

function makeAccess(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    user: { id: "user-1" },
    organizationId: "org-1",
    organizationName: "Clinica Test",
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

describe("atenderVaccinationAction — vaccine catalog gate server mirror (#5)", () => {
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

  it("accepts a catalogued vaccine name", async () => {
    mockFindVaccineByName.mockReturnValue({
      name: "Antirrábica",
      species: ["dog"],
      isCore: true,
      intervalMonths: 12,
    });
    const result = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ vaccineName: "Antirrábica", occurredAt: TODAY_AR }),
    );
    expect(result.error).toBeNull();
    expect(mockCreateVaccination).toHaveBeenCalledOnce();
  });

  it("rejects an uncatalogued vaccine name with no flag in notes", async () => {
    mockFindVaccineByName.mockReturnValue(null);
    const result = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({ vaccineName: "Vacuna Rarísima", occurredAt: TODAY_AR }),
    );
    expect(result.error).toMatch(/no está en el catálogo/i);
    expect(mockCreateVaccination).not.toHaveBeenCalled();
  });

  it("accepts an uncatalogued vaccine name when notes carry the uncatalogued flag", async () => {
    mockFindVaccineByName.mockReturnValue(null);
    const result = await actions.atenderVaccinationAction(
      "ORG-1",
      "DIM-TEST-0001",
      { error: null },
      formData({
        vaccineName: "Vacuna Rarísima",
        occurredAt: TODAY_AR,
        notes: "vacuna no catalogada: Vacuna Rarísima",
      }),
    );
    expect(result.error).toBeNull();
    expect(mockCreateVaccination).toHaveBeenCalledOnce();
  });
});

describe("atenderMicrochipAction — declared-by-owner sign-off (#3)", () => {
  let actions: typeof import("./actions");

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveAtenderPet.mockResolvedValue(makeAccess());
    mockRejectIfAlreadySigned.mockResolvedValue(null);
    mockAttemptedChipMatchesDeclaration.mockResolvedValue(true);
    mockFetchActiveIdentifications.mockResolvedValue({ microchip: null, tattoo: null });
    mockUploadAttachmentIfPresent.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });
    actions = await import("./actions");
  });

  it("signs a fresh chip entry (no confirmEventId) with vet-verified provenance", async () => {
    const result = await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      null,
      { error: null },
      formData({ chipNumber: "985141004321456", occurredAt: TODAY_AR }),
    );
    expect(result.error).toBeNull();
    expect(mockCreateMicrochip).toHaveBeenCalledOnce();
    expect(mockCreateMicrochip).toHaveBeenCalledWith(
      expect.objectContaining({
        eventAuthorship: { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true },
      }),
      expect.anything(),
    );
    // Signing never touches the guard's target lookup when nothing is being confirmed.
    expect(mockRejectIfAlreadySigned).not.toHaveBeenCalled();
  });

  it("confirms a still-pending declared event (confirmEventId given, guard allows)", async () => {
    mockRejectIfAlreadySigned.mockResolvedValue(null);
    const result = await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-1",
      { error: null },
      formData({ chipNumber: "985141004321456", occurredAt: TODAY_AR }),
    );
    expect(result.error).toBeNull();
    // RA-2 F2: the SIGNER's provenance is part of the guard's question — a
    // non-matriculated member's record can be a duplicate at their own tier
    // even though it never reaches the professional bar. Forwarding it is not
    // optional; without it the guard cannot tell the two signer tiers apart.
    expect(mockRejectIfAlreadySigned).toHaveBeenCalledWith(
      "pet-1",
      "microchip_implanted",
      "declared-evt-1",
      { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true },
    );
    expect(mockCreateMicrochip).toHaveBeenCalledOnce();
  });

  it("rejects (no-op) signing an already-verified declared event — append-only preserved", async () => {
    mockRejectIfAlreadySigned.mockResolvedValue({
      error: "Este registro ya fue firmado por un profesional.",
    });
    const result = await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-1",
      { error: null },
      formData({ chipNumber: "985141004321456", occurredAt: TODAY_AR }),
    );
    expect(result.error).toMatch(/ya fue firmado/i);
    // No new event is written — the guard short-circuits before the writer call.
    expect(mockCreateMicrochip).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Proof of scan — the other half of not disclosing the declared number
  // -------------------------------------------------------------------------
  //
  // The pending-signatures card no longer prefills the declared chip, so the
  // signer types what the scanner read. Removing the prefill WITHOUT this gate
  // would have been worse than the leak it closed: a typo (or a deliberate
  // substitution) would still mark the declaration named by confirmEventId
  // professionally verified, stamping a number that declaration never
  // contained onto an append-only record.

  it("refuses to sign when the typed number does not match the declaration", async () => {
    mockAttemptedChipMatchesDeclaration.mockResolvedValue(false);
    const result = await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-1",
      { error: null },
      formData({ chipNumber: "985141009999999", occurredAt: TODAY_AR }),
    );
    expect(result.error).toMatch(/no coincide con el microchip declarado/i);
    // Nothing is written: no signature attaches to a number the owner never
    // declared.
    expect(mockCreateMicrochip).not.toHaveBeenCalled();
  });

  it("passes the pet, the declaration id and the TYPED number to the matcher", async () => {
    await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-1",
      { error: null },
      formData({ chipNumber: "985141004321456", occurredAt: TODAY_AR }),
    );
    expect(mockAttemptedChipMatchesDeclaration).toHaveBeenCalledWith(
      "pet-1",
      "declared-evt-1",
      "985141004321456",
    );
  });

  it("does not consult the matcher for a fresh entry — there is no declaration to match", async () => {
    // A walk-in chip entry with no confirmEventId is not confirming anything,
    // so demanding a match would block the legitimate first registration.
    const result = await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      null,
      { error: null },
      formData({ chipNumber: "985141004321456", occurredAt: TODAY_AR }),
    );
    expect(result.error).toBeNull();
    expect(mockAttemptedChipMatchesDeclaration).not.toHaveBeenCalled();
    expect(mockCreateMicrochip).toHaveBeenCalledOnce();
  });

  it("checks the signature guard BEFORE the scan match — an already-signed act says so", async () => {
    // Ordering matters for the message the signer gets: if a vet already
    // signed, "ya fue firmado" is the useful answer, not "no coincide".
    mockRejectIfAlreadySigned.mockResolvedValue({
      error: "Este registro ya fue firmado por un profesional.",
    });
    mockAttemptedChipMatchesDeclaration.mockResolvedValue(false);
    const result = await actions.atenderMicrochipAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-1",
      { error: null },
      formData({ chipNumber: "985141009999999", occurredAt: TODAY_AR }),
    );
    expect(result.error).toMatch(/ya fue firmado/i);
    expect(mockAttemptedChipMatchesDeclaration).not.toHaveBeenCalled();
    expect(mockCreateMicrochip).not.toHaveBeenCalled();
  });
});

describe("atenderSterilizationAction — declared-by-owner sign-off (#3)", () => {
  let actions: typeof import("./actions");

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolveAtenderPet.mockResolvedValue(makeAccess());
    mockRejectIfAlreadySigned.mockResolvedValue(null);
    mockUploadAttachmentIfPresent.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });
    actions = await import("./actions");
  });

  it("signs a fresh sterilization entry (no confirmEventId) with vet-verified provenance", async () => {
    const result = await actions.atenderSterilizationAction(
      "ORG-1",
      "DIM-TEST-0001",
      null,
      { error: null },
      formData({ procedure: "castration", occurredAt: TODAY_AR }),
    );
    expect(result.error).toBeNull();
    expect(mockCreateSterilization).toHaveBeenCalledOnce();
    expect(mockCreateSterilization).toHaveBeenCalledWith(
      expect.objectContaining({
        eventAuthorship: { authorRole: "vet", authorOrganizationId: "org-1", authorVerified: true },
      }),
      expect.anything(),
    );
  });

  it("rejects (no-op) signing an already-verified declared event — append-only preserved", async () => {
    mockRejectIfAlreadySigned.mockResolvedValue({
      error: "Este registro ya fue firmado por un profesional.",
    });
    const result = await actions.atenderSterilizationAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-2",
      { error: null },
      formData({ procedure: "spay", occurredAt: TODAY_AR }),
    );
    expect(result.error).toMatch(/ya fue firmado/i);
    expect(mockCreateSterilization).not.toHaveBeenCalled();
  });

  it("rejects an unknown procedure before touching the sign-off guard", async () => {
    const result = await actions.atenderSterilizationAction(
      "ORG-1",
      "DIM-TEST-0001",
      "declared-evt-2",
      { error: null },
      formData({ procedure: "unknown-proc", occurredAt: TODAY_AR }),
    );
    expect(result.error).toBe("Procedimiento inválido.");
    expect(mockRejectIfAlreadySigned).not.toHaveBeenCalled();
    expect(mockCreateSterilization).not.toHaveBeenCalled();
  });
});
