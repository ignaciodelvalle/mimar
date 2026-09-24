// Unit tests for withdrawAdoptionApplication use-case (applicant-side retract).
// All DB interactions faked — no real Postgres needed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import { withdrawAdoptionApplication } from "../withdraw-adoption-application";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeLoaded(overrides: Record<string, unknown> = {}) {
  return {
    application: { id: "evt-app-1" },
    pet: { id: "pet-1", name: "Luna" },
    org: { id: "org-1", publicToken: "org-tok", displayName: "Refugio Test" },
    ...overrides,
  };
}

function makeFakeRepo(
  options: {
    withdrawalLoad?: ReturnType<typeof makeLoaded> | { error: string };
    orgMembers?: { userId: string }[];
  } = {},
): typeof AdoptionRepository {
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
    findOrgMembersForNotify: vi
      .fn()
      .mockResolvedValue(options.orgMembers ?? [{ userId: "member-1" }]),
    findApplicationForReview: vi.fn().mockResolvedValue({ error: "n/a" }),
    findPendingApplicationsExcluding: vi.fn().mockResolvedValue([]),
    findApplicationForWithdrawal: vi.fn().mockResolvedValue(options.withdrawalLoad ?? makeLoaded()),
    withdrawApplication: vi.fn().mockResolvedValue(undefined),
    insertInfoRequestedNote: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof AdoptionRepository;
}

const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => unknown) => cb("fake-tx"));

const applicant = { userId: "applicant-user-1" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withdrawAdoptionApplication", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("requires an active session (applicant=null → error, no write)", async () => {
    const repo = makeFakeRepo();
    const result = await withdrawAdoptionApplication(
      { applicationEventId: "evt-app-1" },
      { repo, applicant: null, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/iniciar sesión/i);
    expect(repo.findApplicationForWithdrawal).not.toHaveBeenCalled();
    expect(repo.withdrawApplication).not.toHaveBeenCalled();
  });

  it("returns the guard error when the application is not the applicant's", async () => {
    const repo = makeFakeRepo({
      withdrawalLoad: { error: "Solo podés retirar tus propias postulaciones." },
    });
    const result = await withdrawAdoptionApplication(
      { applicationEventId: "evt-app-1" },
      { repo, applicant, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propias postulaciones/i);
    expect(repo.withdrawApplication).not.toHaveBeenCalled();
  });

  it("returns the guard error when the application is already resolved (pending-only)", async () => {
    const repo = makeFakeRepo({
      withdrawalLoad: { error: "Esta postulación ya fue resuelta y no se puede retirar." },
    });
    const result = await withdrawAdoptionApplication(
      { applicationEventId: "evt-app-1" },
      { repo, applicant, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/ya fue resuelta/i);
    expect(repo.withdrawApplication).not.toHaveBeenCalled();
  });

  it("emits the withdrawal resolution with the applicant as actor", async () => {
    const repo = makeFakeRepo();
    const result = await withdrawAdoptionApplication(
      { applicationEventId: "evt-app-1" },
      { repo, applicant, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.withdrawApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        applicationEventId: "evt-app-1",
        applicantUserId: "applicant-user-1",
      }),
      "fake-tx",
    );
  });

  it("notifies the org (category=adoption, CTA to the adopciones list)", async () => {
    const repo = makeFakeRepo({ orgMembers: [{ userId: "member-1" }, { userId: "member-2" }] });
    const result = await withdrawAdoptionApplication(
      { applicationEventId: "evt-app-1" },
      { repo, applicant, transaction: fakeTransaction },
    );
    const r = result as {
      ok: true;
      notifications: {
        userId: string;
        notificationType: string;
        category?: string | null;
        ctaUrl?: string | null;
      }[];
    };
    expect(r.notifications).toHaveLength(2);
    for (const n of r.notifications) {
      expect(n.notificationType).toBe("adoption_application_withdrawn");
      expect(n.category).toBe("adoption");
      expect(n.ctaUrl).toBe("/org/org-tok/adopciones");
    }
    expect(r.notifications.map((n) => n.userId).sort()).toEqual(["member-1", "member-2"]);
  });

  it("succeeds with an empty notifications array when the org has no members", async () => {
    const repo = makeFakeRepo({ orgMembers: [] });
    const result = await withdrawAdoptionApplication(
      { applicationEventId: "evt-app-1" },
      { repo, applicant, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect((result as { ok: true; notifications: unknown[] }).notifications).toEqual([]);
    expect(repo.withdrawApplication).toHaveBeenCalledTimes(1);
  });
});
