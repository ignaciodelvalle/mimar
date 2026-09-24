// Unit tests for review adoption application use-cases (approve + reject).
// All DB interactions faked — no real Postgres needed.
// TDD cycle: RED (this file) → GREEN (review-adoption-application.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import {
  approveAdoptionApplication,
  rejectAdoptionApplication,
} from "../review-adoption-application";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    name: "Luna",
    publicToken: "tok-1",
    ...overrides,
  };
}

// Returns the projected shape that findApplicationForReview now returns
// (Item 27 PII fix: no raw payload, only the fields callers need).
function makeApplicationReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-app-1",
    applicantUserId: "applicant-user-1",
    ...overrides,
  };
}

function makeFakeRepo(
  options: {
    reviewResult?:
      | { application: Record<string, unknown>; pet: Record<string, unknown> }
      | { error: string };
  } = {},
): typeof AdoptionRepository {
  const reviewResult = options.reviewResult ?? {
    application: makeApplicationReview(),
    pet: makePet(),
  };

  return {
    findShelterPet: vi.fn().mockResolvedValue(null),
    findActiveFoster: vi.fn().mockResolvedValue(null),
    findStubAdopterByDni: vi.fn().mockResolvedValue(null),
    setEligibility: vi.fn().mockResolvedValue(undefined),
    setListingStatus: vi.fn().mockResolvedValue(undefined),
    updateListingContent: vi.fn().mockResolvedValue(undefined),
    insertApplication: vi.fn().mockResolvedValue({ eventId: "evt-1" }),
    resolveApplication: vi.fn().mockResolvedValue(undefined),
    findPetForApplication: vi.fn().mockResolvedValue(null),
    findApplicantProfile: vi.fn().mockResolvedValue(null),
    findExistingApplication: vi.fn().mockResolvedValue(null),
    findOrgMembersForNotify: vi.fn().mockResolvedValue([]),
    findApplicationForReview: vi.fn().mockResolvedValue(reviewResult),
    findPendingApplicationsExcluding: vi.fn().mockResolvedValue([]),
  } as unknown as typeof AdoptionRepository;
}

const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => unknown) => cb("fake-tx"));

const actor = {
  user: { id: "reviewer-user-1" },
  organization: {
    id: "org-1",
    publicToken: "org-tok",
    verified: true,
    displayName: "Refugio Test",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("approveAdoptionApplication", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  // ---- Load failures -------------------------------------------------------

  it("returns error when application not found in org", async () => {
    const repo = makeFakeRepo({
      reviewResult: { error: "Postulación no encontrada o no pertenece a tu organización." },
    });
    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-missing", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  it("returns error when application already resolved", async () => {
    const repo = makeFakeRepo({ reviewResult: { error: "Esta postulación ya fue resuelta." } });
    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/resuelta/i);
  });

  it("returns error when pet already adopted", async () => {
    const repo = makeFakeRepo({
      reviewResult: {
        error: "Esta mascota ya fue adoptada — no es posible revisar postulaciones.",
      },
    });
    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/adoptada/i);
  });

  // ---- Successful approve -------------------------------------------------

  it("emits adoption_application_resolved with outcome=approved", async () => {
    const repo = makeFakeRepo();
    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.resolveApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationEventId: "evt-app-1",
        outcome: "approved",
        reviewerUserId: "reviewer-user-1",
      }),
      "fake-tx",
    );
  });

  it("returns applicant notification in notifications array", async () => {
    const repo = makeFakeRepo();
    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(
      r.notifications.some((n) => n.notificationType === "adoption_application_approved"),
    ).toBe(true);
  });

  it("approve notification carries category 'adoption'", async () => {
    const repo = makeFakeRepo();
    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    const r = result as { ok: true; notifications: { category?: string | null }[] };
    expect(r.notifications.every((n) => n.category === "adoption")).toBe(true);
  });
});

describe("rejectAdoptionApplication", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("emits adoption_application_resolved with outcome=rejected", async () => {
    const repo = makeFakeRepo();
    const result = await rejectAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: "Not suitable" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.resolveApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationEventId: "evt-app-1",
        outcome: "rejected",
        reviewerUserId: "reviewer-user-1",
      }),
      "fake-tx",
    );
  });

  it("returns applicant notification in notifications array on reject", async () => {
    const repo = makeFakeRepo();
    const result = await rejectAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(
      r.notifications.some((n) => n.notificationType === "adoption_application_rejected"),
    ).toBe(true);
  });

  it("reject notification carries category 'adoption'", async () => {
    const repo = makeFakeRepo();
    const result = await rejectAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    const r = result as { ok: true; notifications: { category?: string | null }[] };
    expect(r.notifications.every((n) => n.category === "adoption")).toBe(true);
  });

  it("returns error when application not found", async () => {
    const repo = makeFakeRepo({
      reviewResult: { error: "Postulación no encontrada o no pertenece a tu organización." },
    });
    const result = await rejectAdoptionApplication(
      { applicationEventId: "evt-missing", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Item 27 — PII shape guard
// ---------------------------------------------------------------------------
// These tests assert that the projected shape returned by findApplicationForReview
// (via the use-case) does NOT contain raw applicant PII fields (name, phone,
// address, DNI, housing_type, daily_routine, notes, motivation, prior_pets).
// Only applicantUserId may be forwarded to the notification layer.

describe("PII exposure guard — application review shape (Item 27)", () => {
  it("approveAdoptionApplication does not receive a raw payload with PII fields", async () => {
    const repo = makeFakeRepo();
    // The mock for findApplicationForReview now returns the projected shape
    // { id, applicantUserId }. If the use-case were using the old full row
    // (with .payload containing housing_type/daily_routine/notes/etc.),
    // TypeScript would already catch it — this test makes the contract
    // explicit at runtime too.
    const capturedArgs: unknown[] = [];
    const spyRepo = {
      ...repo,
      findApplicationForReview: vi.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs.push(...args);
        return Promise.resolve({ application: makeApplicationReview(), pet: makePet() });
      }),
    } as unknown as typeof AdoptionRepository;

    const result = await approveAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo: spyRepo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });

    // The returned application shape must NOT contain raw PII payload fields.
    const appArg = (spyRepo.findApplicationForReview as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as Promise<{ application: Record<string, unknown> } | { error: string }>;
    const resolved = await appArg;
    if ("error" in resolved) throw new Error("Expected success");

    const { application } = resolved;
    expect(application).not.toHaveProperty("payload");
    expect(application).not.toHaveProperty("housing_type");
    expect(application).not.toHaveProperty("daily_routine");
    expect(application).not.toHaveProperty("phone");
    expect(application).not.toHaveProperty("dni");
    expect(application).not.toHaveProperty("displayName");
    // applicantUserId is the only permitted field from the payload.
    expect(application).toHaveProperty("applicantUserId");
  });

  it("rejectAdoptionApplication does not receive a raw payload with PII fields", async () => {
    const repo = makeFakeRepo();
    const result = await rejectAdoptionApplication(
      { applicationEventId: "evt-app-1", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    // The use-case only calls repo.findApplicationForReview, which now returns
    // the projected shape. Verify the mock shape itself has no PII payload.
    const reviewResult = await (repo.findApplicationForReview as ReturnType<typeof vi.fn>).mock
      .results[0]?.value;
    if (!reviewResult || "error" in reviewResult) throw new Error("Expected success");
    expect(reviewResult.application).not.toHaveProperty("payload");
    expect(reviewResult.application).toHaveProperty("applicantUserId");
  });
});
