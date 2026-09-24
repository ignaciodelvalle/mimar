// Unit tests for submitAdoptionApplication use-case.
// All DB interactions faked — no real Postgres needed.
// TDD cycle: RED (this file) → GREEN (submit-adoption-application.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import type { ApplicantBudgetVerdict } from "../submit-adoption-application";
import { submitAdoptionApplication } from "../submit-adoption-application";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeListablePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    name: "Mochi",
    publicToken: "tok-1",
    adoptionListedAt: new Date("2024-01-01"),
    adoptionListingPausedAt: null,
    status: "active",
    adoptionEligible: true,
    inCustodyDispute: false,
    rabiesObservationStatus: null,
    custodyOwnershipId: "own-1",
    ...overrides,
  };
}

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    publicToken: "org-tok",
    verified: true,
    orgType: "shelter",
    displayName: "Refugio Test",
    ...overrides,
  };
}

// Fake repo with embedded findPetForApplication (pet + org snapshot).
function makeFakeRepo(
  options: {
    petRow?: Record<string, unknown> | null;
    orgRow?: Record<string, unknown> | null;
    applicantProfile?: Record<string, unknown> | null;
    existingApplication?: Record<string, unknown> | null;
    eventId?: string;
  } = {},
): typeof AdoptionRepository & {
  findPetForApplication: (
    petPublicToken: string,
  ) => Promise<{ pet: Record<string, unknown>; org: Record<string, unknown> } | null>;
  findApplicantProfile: (userId: string) => Promise<Record<string, unknown> | null>;
  findExistingApplication: (
    petId: string,
    userId: string,
  ) => Promise<Record<string, unknown> | null>;
  findOrgMembersForNotify: (orgId: string) => Promise<{ userId: string }[]>;
} {
  return {
    findShelterPet: vi.fn().mockResolvedValue(options.petRow ?? makeListablePet()),
    findActiveFoster: vi.fn().mockResolvedValue(null),
    findStubAdopterByDni: vi.fn().mockResolvedValue(null),
    setEligibility: vi.fn().mockResolvedValue(undefined),
    setListingStatus: vi.fn().mockResolvedValue(undefined),
    updateListingContent: vi.fn().mockResolvedValue(undefined),
    insertApplication: vi.fn().mockResolvedValue({ eventId: options.eventId ?? "evt-app-1" }),
    resolveApplication: vi.fn().mockResolvedValue(undefined),
    // Extra methods specific to submit flow:
    findPetForApplication: vi.fn().mockResolvedValue(
      options.petRow === null
        ? null
        : {
            pet: options.petRow ?? makeListablePet(),
            org: options.orgRow ?? makeOrg(),
          },
    ),
    findApplicantProfile: vi
      .fn()
      .mockResolvedValue(
        options.applicantProfile !== undefined
          ? options.applicantProfile
          : { accountType: "personal" },
      ),
    findExistingApplication: vi.fn().mockResolvedValue(options.existingApplication ?? null),
    findOrgMembersForNotify: vi.fn().mockResolvedValue([{ userId: "member-1" }]),
  } as unknown as ReturnType<typeof makeFakeRepo>;
}

const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => unknown) => cb("fake-tx"));

/**
 * The applicant's rate-limit budget, faked.
 *
 * INJECTED IN EVERY CALL BELOW, and the file header's promise is why: "all DB
 * interactions faked — no real Postgres needed". `spendApplicantBudget`'s
 * default is the REAL limiter (a write to `rate_limit_buckets`), so a call site
 * that left it out would quietly turn a unit test into an integration test
 * against shared state — and against a per-day ceiling of 30 keyed on this
 * file's one fake user id, which is a test that starts failing on the
 * thirty-first run of the day and looks like a flake.
 */
const fakeBudget = vi.fn<(userId: string) => Promise<ApplicantBudgetVerdict>>(async () => "ok");

const validInput = {
  petPublicToken: "tok-1",
  housingType: "casa_con_patio" as const,
  otherPets: null,
  dailyRoutine: null,
  notes: null,
  profileSharingConsent: true,
  motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
  priorPets: "yes_before" as const,
};

const applicant = {
  userId: "user-applicant",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitAdoptionApplication", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
    fakeBudget.mockClear();
    fakeBudget.mockResolvedValue("ok");
  });

  // ---- Auth / profile checks --------------------------------------------

  it("returns error when user has no active session", async () => {
    const repo = makeFakeRepo();
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant: null,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/sesión/i);
  });

  it("returns error when institutional account tries to apply", async () => {
    const repo = makeFakeRepo({ applicantProfile: { accountType: "institutional" } });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/institucional/i);
  });

  // ---- Listability checks -----------------------------------------------

  it("returns error when pet is not listable (not published)", async () => {
    const repo = makeFakeRepo({
      petRow: makeListablePet({ adoptionListedAt: null }),
    });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disponible/i);
  });

  it("returns error when pet not found", async () => {
    const repo = makeFakeRepo({ petRow: null });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
  });

  // ---- Duplicate pending ------------------------------------------------

  it("returns error when applicant already has a pending application", async () => {
    const repo = makeFakeRepo({ existingApplication: { id: "evt-existing" } });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/ya postulaste/i);
  });

  // ---- Profile sharing consent -----------------------------------------

  it("returns error when profileSharingConsent is false", async () => {
    const repo = makeFakeRepo();
    const result = await submitAdoptionApplication(
      { ...validInput, profileSharingConsent: false },
      { repo, applicant, transaction: fakeTransaction, spendApplicantBudget: fakeBudget },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/consentimiento/i);
  });

  // ---- Successful insert + notification payload -------------------------

  it("inserts application inside a transaction on valid input", async () => {
    const repo = makeFakeRepo();
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        userId: "user-applicant",
        housingType: "casa_con_patio",
      }),
      "fake-tx",
    );
  });

  it("returns notification payload in result (not flushed inside use-case)", async () => {
    const repo = makeFakeRepo();
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: true });
    const r = result as {
      ok: true;
      value: { eventId: string };
      notifications: { notificationType: string; category?: string | null }[];
    };
    expect(r.notifications.length).toBeGreaterThan(0);
    // Org-member fan-out notifications carry the adoption category (UI-6) so
    // they surface in the /notificaciones adoption tab.
    expect(r.notifications.every((n) => n.category === "adoption")).toBe(true);
    expect(
      r.notifications.every((n) => n.notificationType === "adoption_application_received"),
    ).toBe(true);
    // Notifications are returned, not flushed (best-effort is action's job).
    expect(repo.insertApplication).toHaveBeenCalledOnce();
  });

  it("anchors every notification on the inserted spine event, which is what makes the dedupe key safe", async () => {
    // A PIN FOR SOMETHING TWO FILES AWAY, and it is here rather than there
    // because this is where the fact is PRODUCED.
    // `infrastructure/notification-flush.ts` mints the fan-out's idempotency key
    // as `adoption:{type}:{eventId}:{userId}` and falls back to the pet id when
    // there is no event id. That fallback is the dangerous branch — two
    // applications for one animal would collapse onto one notification and the
    // shelter would never hear about the second person — and it is unreachable
    // only for as long as this use-case keeps setting `relatedEventId`.
    //
    // MUTATION APPLIED: delete `relatedEventId: insertedEventId` from the
    // pendingNotifications push in submit-adoption-application.ts. Red here, and
    // green in every other test in this file and in the flush's own — which is
    // the point: nothing else in the repo notices.
    const repo = makeFakeRepo({ eventId: "evt-app-77" });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    const r = result as {
      ok: true;
      notifications: { relatedEventId?: string | null }[];
    };
    expect(r.notifications.length).toBeGreaterThan(0);
    expect(r.notifications.every((n) => n.relatedEventId === "evt-app-77")).toBe(true);
  });

  it("returns the applicationEventId in value", async () => {
    const repo = makeFakeRepo({ eventId: "evt-app-42" });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    const r = result as { ok: true; value: { eventId: string }; notifications: unknown[] };
    expect(r.value.eventId).toBe("evt-app-42");
  });
});

// ---------------------------------------------------------------------------
// The applicant's budget (WU-U)
// ---------------------------------------------------------------------------
// The board's WU-U row asked for it — "the application flow earns its own rate
// limit here" — and it lives in this use-case rather than in a route so that
// the web form and the bearer door spend ONE counter. What is asserted here is
// the two things that make it real: that it is spent at all, and WHERE in the
// order, because a budget spent before the refusals is a budget a person burns
// on their own typos.
describe("submitAdoptionApplication — the applicant's budget", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
    fakeBudget.mockClear();
    fakeBudget.mockResolvedValue("ok");
  });

  it("spends the budget, keyed on the applicant, on a successful submission", async () => {
    const repo = makeFakeRepo();
    await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(fakeBudget).toHaveBeenCalledExactlyOnceWith(applicant.userId);
  });

  it("refuses the submission and writes nothing when the budget is spent", async () => {
    // "denied" covers BOTH an exhausted budget and a limiter that could not
    // answer — the use-case fails CLOSED here, unlike every other limiter in
    // this repo, because what an outage would open is writes into somebody
    // else's review queue rather than access to the caller's own rows.
    const repo = makeFakeRepo();
    fakeBudget.mockResolvedValue("denied");
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/varias postulaciones/i);
    expect(repo.insertApplication).not.toHaveBeenCalled();
    expect(fakeTransaction).not.toHaveBeenCalled();
  });

  it("does NOT spend the budget on a duplicate application", async () => {
    // THE ORDER IS THE ASSERTION. The one thing a person is most likely to do
    // twice is tap "Enviar" again after a timeout whose result they could not
    // see — and `findExistingApplication` already makes the second write
    // impossible. Charging for it would burn the budget they need for the next
    // animal on a request that was never going to write anything.
    const repo = makeFakeRepo({ existingApplication: { id: "evt-existing" } });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect(fakeBudget).not.toHaveBeenCalled();
  });

  it("does NOT spend the budget on a pet that went off listing", async () => {
    // Same reason, different refusal: somebody who tapped through to an animal
    // and wrote a letter while the shelter unpublished it has done nothing
    // wrong and delivered nothing.
    const repo = makeFakeRepo({ petRow: makeListablePet({ adoptionListingPausedAt: new Date() }) });
    const result = await submitAdoptionApplication(validInput, {
      repo,
      applicant,
      transaction: fakeTransaction,
      spendApplicantBudget: fakeBudget,
    });
    expect(result).toMatchObject({ ok: false });
    expect(fakeBudget).not.toHaveBeenCalled();
  });

  it("does NOT spend the budget on a form the domain refuses", async () => {
    const repo = makeFakeRepo();
    const result = await submitAdoptionApplication(
      { ...validInput, motivation: "corto" },
      { repo, applicant, transaction: fakeTransaction, spendApplicantBudget: fakeBudget },
    );
    expect(result).toMatchObject({ ok: false });
    expect(fakeBudget).not.toHaveBeenCalled();
  });
});
