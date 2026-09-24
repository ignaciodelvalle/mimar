// Plausibility wiring tests for the pregnancy and tattoo action shims —
// PO decision 2026-07-16: every guardless occurred-at writer runs the same
// date-only IMPOSSIBLE-date guard as the events edge (P4 item 1).
//
// Module-level unit tests — the inner writers and auth guards are mocked, so
// these verify action-edge orchestration only (same approach as
// src/modules/events/__tests__/actions-parity.test.ts).

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
  sex: "female",
  status: "active",
  dateOfBirth: "2020-01-01",
};

const mockRequireAlivePetAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/pet-access", () => ({
  requireAlivePetAccess: mockRequireAlivePetAccess,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("REDIRECT");
  }),
}));

const mockPregnancyStartedWriter = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/src/modules/pets/application/pregnancy/record-pregnancy-started", () => ({
  recordPregnancyStartedWriter: mockPregnancyStartedWriter,
}));

const mockPregnancyEndedWriter = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/src/modules/pets/application/pregnancy/record-pregnancy-ended", () => ({
  recordPregnancyEndedWriter: mockPregnancyEndedWriter,
}));

const mockCreateTattooForUser = vi.hoisted(() => vi.fn().mockResolvedValue({ wasNoop: false }));
vi.mock("@/src/modules/pets/application/tattoo/create-tattoo", () => ({
  VALID_LOCATIONS: ["left_ear", "right_ear", "inner_thigh", "belly", "other"],
  createTattooForUser: mockCreateTattooForUser,
}));

const mockUploadAttachmentIfPresent = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    uploadedPath: "tattoo/x.jpg",
    mimeType: "image/jpeg",
    size: 123,
    error: null,
  }),
);
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: mockUploadAttachmentIfPresent,
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
    supabase: { storage: { from: vi.fn().mockReturnValue({ remove: vi.fn() }) } },
    user: { id: "user-1" },
    pet: { ...BASE_PET },
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    accessPath: "owner",
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAlivePetAccess.mockResolvedValue(makeAccess());
  mockUploadAttachmentIfPresent.mockResolvedValue({
    uploadedPath: "tattoo/x.jpg",
    mimeType: "image/jpeg",
    size: 123,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Pregnancy
// ---------------------------------------------------------------------------

describe("recordPregnancyStartedAction — date plausibility", () => {
  it("accepts today's AR date and rejects tomorrow's", async () => {
    const { recordPregnancyStartedAction } = await import("@/app/actions/pregnancy");

    // N3 (B.2): the action RETURNS its destination now — redirect() from a
    // server action is dropped by the App Router in production.
    const state = await recordPregnancyStartedAction(
      "DIM-TEST-0001",
      { error: null },
      formData({ occurredAt: TODAY_AR }),
    );
    expect(state.redirectTo).toBeTruthy();
    expect(mockPregnancyStartedWriter).toHaveBeenCalledOnce();

    mockPregnancyStartedWriter.mockClear();
    const rejected = await recordPregnancyStartedAction(
      "DIM-TEST-0001",
      { error: null },
      formData({ occurredAt: TOMORROW_AR }),
    );
    expect(rejected?.error).toBe(FUTURE_ERROR);
    expect(mockPregnancyStartedWriter).not.toHaveBeenCalled();
  });
});

describe("recordPregnancyEndedAction — date plausibility", () => {
  it("accepts today's AR date and rejects tomorrow's", async () => {
    const { recordPregnancyEndedAction } = await import("@/app/actions/pregnancy");

    // N3 (B.2): the action RETURNS its destination now — redirect() from a
    // server action is dropped by the App Router in production.
    const state = await recordPregnancyEndedAction(
      "DIM-TEST-0001",
      { error: null },
      formData({ occurredAt: TODAY_AR, outcome: "live_birth", liveBirthsCount: "3" }),
    );
    expect(state.redirectTo).toBeTruthy();
    expect(mockPregnancyEndedWriter).toHaveBeenCalledOnce();

    mockPregnancyEndedWriter.mockClear();
    const rejected = await recordPregnancyEndedAction(
      "DIM-TEST-0001",
      { error: null },
      formData({ occurredAt: TOMORROW_AR, outcome: "live_birth", liveBirthsCount: "3" }),
    );
    expect(rejected?.error).toBe(FUTURE_ERROR);
    expect(mockPregnancyEndedWriter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tattoo
// ---------------------------------------------------------------------------

function tattooFormData(recordedAt: string): FormData {
  const fd = formData({ tattooCode: "K9-TEST-01", recordedAt });
  fd.set("attachment", new File(["fake-jpeg-bytes"], "tattoo.jpg", { type: "image/jpeg" }));
  return fd;
}

describe("createTattooAction — date plausibility", () => {
  it("accepts today's AR date and rejects tomorrow's", async () => {
    const { createTattooAction } = await import("@/app/actions/tattoo");

    // N3 (B.2): the action RETURNS its destination now.
    const state = await createTattooAction(
      "DIM-TEST-0001",
      { error: null },
      tattooFormData(TODAY_AR),
    );
    expect(state.redirectTo).toBeTruthy();
    expect(mockCreateTattooForUser).toHaveBeenCalledOnce();

    mockCreateTattooForUser.mockClear();
    const rejected = await createTattooAction(
      "DIM-TEST-0001",
      { error: null },
      tattooFormData(TOMORROW_AR),
    );
    expect(rejected?.error).toBe(FUTURE_ERROR);
    expect(mockCreateTattooForUser).not.toHaveBeenCalled();
  });

  it("rejects a recordedAt before the pet's date of birth", async () => {
    const { createTattooAction } = await import("@/app/actions/tattoo");
    const rejected = await createTattooAction(
      "DIM-TEST-0001",
      { error: null },
      tattooFormData("2019-12-31"),
    );
    expect(rejected?.error).toMatch(/anterior a la fecha de nacimiento/i);
    expect(mockCreateTattooForUser).not.toHaveBeenCalled();
  });
});
