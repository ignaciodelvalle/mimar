// Unit tests for findRehomeOrgs pure helper and sendRehomeRequest use-case.
// No DB needed — all behavior is pure logic or faked repos.
// TDD cycle: RED → GREEN

import { describe, expect, it, vi } from "vitest";
import { type RehomeOrgCandidate, filterRehomeOrgCandidates } from "../find-rehome-orgs";

// ---------------------------------------------------------------------------
// filterRehomeOrgCandidates — pure function tests
// ---------------------------------------------------------------------------

describe("filterRehomeOrgCandidates", () => {
  const makeOrg = (overrides: Partial<RehomeOrgCandidate> = {}): RehomeOrgCandidate => ({
    id: "org-1",
    displayName: "Refugio Test",
    orgType: "shelter",
    verified: true,
    publicToken: "org-tok-1",
    email: "test@refugio.org",
    phone: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...overrides,
  });

  it("includes verified shelters", () => {
    const orgs = [makeOrg({ orgType: "shelter", verified: true })];
    const result = filterRehomeOrgCandidates(orgs);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("org-1");
  });

  it("includes verified rescue_networks", () => {
    const orgs = [makeOrg({ orgType: "rescue_network", verified: true })];
    const result = filterRehomeOrgCandidates(orgs);
    expect(result).toHaveLength(1);
  });

  it("excludes unverified orgs", () => {
    const orgs = [makeOrg({ verified: false })];
    const result = filterRehomeOrgCandidates(orgs);
    expect(result).toHaveLength(0);
  });

  it("excludes verified clinics (wrong type)", () => {
    const orgs = [makeOrg({ orgType: "clinic", verified: true })];
    const result = filterRehomeOrgCandidates(orgs);
    expect(result).toHaveLength(0);
  });

  it("excludes verified sanitary_authority orgs", () => {
    const orgs = [makeOrg({ orgType: "sanitary_authority", verified: true })];
    const result = filterRehomeOrgCandidates(orgs);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no orgs match", () => {
    const result = filterRehomeOrgCandidates([]);
    expect(result).toHaveLength(0);
  });

  it("keeps only shelter and rescue_network from mixed list", () => {
    const orgs = [
      makeOrg({ id: "org-1", orgType: "shelter", verified: true }),
      makeOrg({ id: "org-2", orgType: "clinic", verified: true }),
      makeOrg({ id: "org-3", orgType: "rescue_network", verified: true }),
      makeOrg({ id: "org-4", orgType: "shelter", verified: false }),
    ];
    const result = filterRehomeOrgCandidates(orgs);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["org-1", "org-3"]);
  });
});

// ---------------------------------------------------------------------------
// sendRehomeRequest — use-case test
// ---------------------------------------------------------------------------

import { PET_DECEASED_ERROR, PET_LOST_ERROR } from "../../../rehome/domain/rehome-rules";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { sendRehomeRequest } from "../find-rehome-orgs";

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findPetByToken: vi.fn().mockResolvedValue({
      id: "pet-1",
      name: "Luna",
      publicToken: "PT-tok",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    }),
    // W-4 coverage: the default org works where Luna lives.
    findOrgCoverage: vi
      .fn()
      .mockResolvedValue([{ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: null }]),
    findActiveFosterByUser: vi.fn().mockResolvedValue({
      id: "own-foster-1",
      ownerUserId: "foster-user-1",
      petId: "pet-1",
    }),
    findOrgById: vi.fn().mockResolvedValue({
      id: "org-1",
      displayName: "Refugio Test",
      verified: true,
      orgType: "shelter",
    }),
    orgAdminAndCoordinatorUserIds: vi
      .fn()
      .mockResolvedValue([{ userId: "admin-1" }, { userId: "coord-1" }]),
    // unused — required for type compatibility
    findShelterPetByToken: vi.fn().mockResolvedValue(null),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: null }),
    insertAssignFoster: vi.fn().mockResolvedValue({ ownershipId: "own-1", caseId: "case-1" }),
    insertProposeFoster: vi.fn().mockResolvedValue({ proposalId: "prop-1", caseId: "case-2" }),
    insertAcceptFosterProposal: vi.fn().mockResolvedValue({
      ownershipId: "own-1",
      newSlots: 0,
      cascadeCancelledTokens: [],
      cascadeOrgNotifyTargets: [],
      acceptingOrgCoordinatorIds: [],
      actorDisplayName: null,
    }),
    insertRejectFosterProposal: vi.fn().mockResolvedValue({ orgCoordinatorIds: [] }),
    insertCancelFosterProposal: vi.fn().mockResolvedValue({ volunteerUserId: "vol-user-1" }),
    insertSetCoFosterAllowed: vi.fn().mockResolvedValue(undefined),
    findActiveFosterOwnershipById: vi.fn().mockResolvedValue(null),
    findProfileById: vi.fn().mockResolvedValue({
      id: "foster-user-1",
      displayName: "María García",
      phone: "+54 11 1234-5678",
      accountType: "personal",
      role: null,
      dniVerified: false,
    }),
    findActiveMembership: vi.fn().mockResolvedValue(null),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-1" }),
    endFosterOwnership: vi.fn().mockResolvedValue(undefined),
    findVolunteerByUserId: vi.fn().mockResolvedValue(null),
    findProposalByToken: vi.fn().mockResolvedValue(null),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
    pendingProposalsForVolunteer: vi.fn().mockResolvedValue([]),
    insertProposal: vi.fn().mockResolvedValue({ id: "prop-1" }),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
    orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue([]),
    expirablePending: vi.fn().mockResolvedValue([]),
    expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 0, expired: 0, errors: 0 }),
    upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-1", availableSlots: 1 }),
    setVolunteerSlots: vi.fn().mockResolvedValue(undefined),
    withdrawVolunteer: vi.fn().mockResolvedValue(undefined),
    searchVolunteers: vi.fn().mockResolvedValue([]),
    acceptedCountsByVolunteer: vi.fn().mockResolvedValue(new Map()),
    findOrgCustodyByPetId: vi.fn().mockResolvedValue(null),
    insertConvertFosterToOwner: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof FosterRepository;
}

const actor = { user: { id: "foster-user-1" } };

describe("sendRehomeRequest", () => {
  it("returns error when pet is not found", async () => {
    const repo = makeFakeRepo({ findPetByToken: vi.fn().mockResolvedValue(null) });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/mascota/i);
  });

  it("returns error when caller is not the active foster", async () => {
    const repo = makeFakeRepo({ findActiveFosterByUser: vi.fn().mockResolvedValue(null) });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/tránsito activo/i);
  });

  // 2026-08-25. This door had no animal-state check at all, while its titular
  // twin (`validateRequestOpen`) refuses both. The literals are asserted by
  // EXACT TEXT, not by regex: they are copied across a module edge the
  // dependency fence does not allow us to close with an import, so the only
  // thing holding them together is this assertion.
  it("refuses a pet reported lost, in the titular flow's exact words", async () => {
    const repo = makeFakeRepo({
      findPetByToken: vi.fn().mockResolvedValue({
        id: "pet-1",
        name: "Luna",
        publicToken: "PT-tok",
        status: "lost",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      }),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toEqual({ ok: false, error: PET_LOST_ERROR });
    // Refused BEFORE the org is looked up or its inbox is resolved.
    expect(repo.findOrgById).not.toHaveBeenCalled();
    expect(repo.orgAdminAndCoordinatorUserIds).not.toHaveBeenCalled();
  });

  it("refuses a deceased pet, in the titular flow's exact words", async () => {
    const repo = makeFakeRepo({
      findPetByToken: vi.fn().mockResolvedValue({
        id: "pet-1",
        name: "Luna",
        publicToken: "PT-tok",
        status: "deceased",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      }),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toEqual({ ok: false, error: PET_DECEASED_ERROR });
    expect(repo.orgAdminAndCoordinatorUserIds).not.toHaveBeenCalled();
  });

  it("returns error when target org is not found or not verified shelter/rescue_network", async () => {
    const repo = makeFakeRepo({
      findOrgById: vi.fn().mockResolvedValue(null),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-999" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/organización/i);
  });

  it("returns error when target org is a clinic (not shelter/rescue_network)", async () => {
    const repo = makeFakeRepo({
      findOrgById: vi.fn().mockResolvedValue({
        id: "org-1",
        displayName: "Clínica Test",
        verified: true,
        orgType: "clinic",
      }),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/tipo/i);
  });

  // -------------------------------------------------------------------------
  // COVERAGE — the foster half of the hole the rehome-by-titular flow closed
  // (W-4). The picker only lists orgs whose `organization_coverage` reaches
  // the pet's zone, but this is a server action: any active foster can POST
  // any orgId. A filter that lives only in the page is a view, not a rule.
  // -------------------------------------------------------------------------

  it("refuses an org that does not cover the pet's zone — THE RED CONTROL", async () => {
    const repo = makeFakeRepo({
      findOrgCoverage: vi
        .fn()
        .mockResolvedValue([{ jurisdictionProvince: "Córdoba", jurisdictionLocality: null }]),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no cubre la zona/i);
    // And nothing was fanned out: a refusal that still notified the org is
    // exactly the inbox spam the rule exists to prevent.
    expect(repo.orgAdminAndCoordinatorUserIds).not.toHaveBeenCalled();
  });

  it("refuses when the org has NO coverage rows at all", async () => {
    const repo = makeFakeRepo({ findOrgCoverage: vi.fn().mockResolvedValue([]) });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no cubre la zona/i);
  });

  it("refuses a pet with no province — there is no zone to cover", async () => {
    const repo = makeFakeRepo({
      findPetByToken: vi.fn().mockResolvedValue({
        id: "pet-1",
        name: "Luna",
        publicToken: "PT-tok",
        jurisdictionProvince: null,
        jurisdictionLocality: null,
      }),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/provincia/i);
  });

  it("accepts a province-wide coverage row for a pet with a locality (same asymmetry as the picker)", async () => {
    // The picker's SQL treats `jurisdiction_locality IS NULL` as province-wide;
    // the predicate is shared, so the use-case must agree.
    const repo = makeFakeRepo({
      findOrgCoverage: vi
        .fn()
        .mockResolvedValue([{ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: null }]),
    });
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("emits notifications to org admins and coordinators on success", async () => {
    const repo = makeFakeRepo();
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    expect(result).toMatchObject({ ok: true });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    // Both admin-1 and coord-1 should receive a notification.
    const targetUserIds = r.notifications.map((n) => n.userId);
    expect(targetUserIds).toContain("admin-1");
    expect(targetUserIds).toContain("coord-1");
  });

  it("notification body includes pet name and foster contact info", async () => {
    const repo = makeFakeRepo();
    const result = await sendRehomeRequest(
      { petPublicToken: "PT-tok", targetOrgId: "org-1" },
      { repo, actor },
    );
    const r = result as { ok: true; notifications: { body: string; userId: string }[] };
    const adminNotif = r.notifications.find((n) => n.userId === "admin-1");
    expect(adminNotif?.body).toContain("Luna");
    expect(adminNotif?.body).toContain("María García");
  });
});
