// Parity tests for src/modules/foster/actions.ts
//
// Verifies that each thin action:
//   1. Calls requireCapability / auth boundary at the edge.
//   2. Delegates to the correct use-case with parsed args.
//   3. Flushes notifications post-tx (best-effort) and returns the expected shape.
//   4. On use-case error → returns { error } without flushing notifications or redirecting.
//
// All DB, supabase, next/navigation, next/cache, and use-case modules are mocked
// so this test runs without Postgres.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must be before imports)
// ---------------------------------------------------------------------------

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapability: vi.fn(),
  requireCapabilityForOrgToken: vi.fn(),
}));

// requireLiveUser (T1.2) resolves profiles.deleted_at / deactivated_at from the
// DATABASE — the guard is deliberately not claim-based. These action tests mock
// the Supabase client but not the profile read, so without this the guard would
// issue a real query with a fixture user id. A healthy profile keeps every
// assertion below testing what it was written to test.
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async (id: string) => ({
    id,
    role: "owner" as const,
    displayName: "Fixture",
    accountType: "personal" as const,
    deactivatedAt: null,
    deletedAt: null,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    transaction: vi.fn(),
  },
  notifications: {},
}));

// Repository mock — cancelFosterProposalAction loads the proposal before auth
vi.mock("../infrastructure/foster-repository", () => ({
  FosterRepository: {
    findProposalByToken: vi.fn(),
  },
}));

// Use-case mocks
vi.mock("../application/assign-foster", () => ({ assignFoster: vi.fn() }));
vi.mock("../application/end-foster", () => ({ endFoster: vi.fn() }));
vi.mock("../application/propose-foster", () => ({ proposeFoster: vi.fn() }));
vi.mock("../application/cancel-foster-proposal", () => ({
  cancelFosterProposal: vi.fn(),
}));
vi.mock("../application/accept-foster-proposal", () => ({
  acceptFosterProposal: vi.fn(),
}));
vi.mock("../application/reject-foster-proposal", () => ({
  rejectFosterProposal: vi.fn(),
}));
vi.mock("../application/expire-foster-proposals", () => ({
  expireFosterProposals: vi.fn(),
}));
vi.mock("../application/upsert-foster-volunteer", () => ({
  upsertFosterVolunteer: vi.fn(),
}));
vi.mock("../application/withdraw-foster-volunteer", () => ({
  withdrawFosterVolunteer: vi.fn(),
}));
vi.mock("../application/set-co-foster-allowed", () => ({
  setCoFosterAllowed: vi.fn(),
}));
vi.mock("../application/search-foster-volunteers", () => ({
  searchFosterVolunteers: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createClient } from "@/lib/supabase/server";
import {
  requireCapability,
  requireCapabilityForOrgToken,
} from "@/src/modules/organizations/infrastructure/authz-resolver";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { acceptFosterProposal } from "../application/accept-foster-proposal";
import { assignFoster } from "../application/assign-foster";
import { cancelFosterProposal } from "../application/cancel-foster-proposal";
import { endFoster } from "../application/end-foster";
import { expireFosterProposals as expireUseCase } from "../application/expire-foster-proposals";
import { proposeFoster } from "../application/propose-foster";
import { rejectFosterProposal } from "../application/reject-foster-proposal";
import { searchFosterVolunteers as searchUseCase } from "../application/search-foster-volunteers";
import { setCoFosterAllowed } from "../application/set-co-foster-allowed";
import { upsertFosterVolunteer } from "../application/upsert-foster-volunteer";
import { withdrawFosterVolunteer } from "../application/withdraw-foster-volunteer";
import { FosterRepository } from "../infrastructure/foster-repository";

import {
  acceptFosterProposalAction,
  assignFosterAction,
  cancelFosterProposalAction,
  endFosterAction,
  expireFosterProposalsAction,
  proposeFosterAction,
  rejectFosterProposalAction,
  searchFosterVolunteers,
  setCoFosterAllowedAction,
  upsertFosterVolunteerAction,
  withdrawFosterVolunteerAction,
} from "../actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-1" };
const MOCK_ORG = {
  id: "org-1",
  publicToken: "ORG-tok",
  verified: true,
  displayName: "Refugio Test",
};

function mockAuth() {
  // assign/end/propose/search pin the capability to the URL org via
  // requireCapabilityForOrgToken; cancel still uses requireCapability (scoped to
  // proposal.organizationId). Stub both to the same success actor.
  const ok = {
    error: null,
    user: MOCK_USER,
    organization: MOCK_ORG,
  } as ReturnType<typeof requireCapability> extends Promise<infer U> ? U : never;
  vi.mocked(requireCapability).mockResolvedValue(ok);
  vi.mocked(requireCapabilityForOrgToken).mockResolvedValue(ok);
}

function mockAuthError(error: string) {
  const fail = {
    error,
  } as ReturnType<typeof requireCapability> extends Promise<infer U> ? U : never;
  vi.mocked(requireCapability).mockResolvedValue(fail);
  vi.mocked(requireCapabilityForOrgToken).mockResolvedValue(fail);
}

function mockSession(userId: string | null) {
  const getUser = userId
    ? vi.fn().mockResolvedValue({ data: { user: { id: userId } } })
    : vi.fn().mockResolvedValue({ data: { user: null } });
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser },
  } as unknown as ReturnType<typeof createClient> extends Promise<infer U> ? U : never);
}

function fakeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const NOTIFICATION = {
  userId: "user-notif-1",
  notificationType: "foster_assigned",
  title: "T",
  body: "B",
  severity: "info" as const,
};

// ---------------------------------------------------------------------------
// assignFosterAction
// ---------------------------------------------------------------------------

describe("assignFosterAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it("returns { error } when requireCapability fails", async () => {
    mockAuthError("sin permiso");
    const fd = fakeFormData({ fosterUserId: "u-1", expectedWeeks: "4" });
    const result = await assignFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    expect(result).toEqual({ error: "sin permiso" });
    expect(assignFoster).not.toHaveBeenCalled();
  });

  it("returns { error } when use-case fails", async () => {
    vi.mocked(assignFoster).mockResolvedValue({
      ok: false,
      error: "ya tiene tránsito",
    });
    const fd = fakeFormData({ fosterUserId: "u-1", expectedWeeks: "4" });
    const result = await assignFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    expect(result).toEqual({ error: "ya tiene tránsito" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("calls assignFoster with parsed formData and redirects on success", async () => {
    vi.mocked(assignFoster).mockResolvedValue({
      ok: true,
      value: { redirectPath: "/org/ORG-tok/mascotas?foster=PET-tok" },
      notifications: [NOTIFICATION],
    });
    const fd = fakeFormData({ fosterUserId: "u-1", expectedWeeks: "4", notes: "test note" });
    const state = await assignFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    expect(assignFoster).toHaveBeenCalledWith(
      { petPublicToken: "PET-tok", fosterUserId: "u-1", expectedWeeksRaw: "4", notes: "test note" },
      expect.objectContaining({ actor: expect.objectContaining({ user: MOCK_USER }) }),
    );
    // N3 (B.2): returned, not redirect()ed.
    expect(state.redirectTo).toBe("/org/ORG-tok/mascotas?foster=PET-tok");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("uses ?foster= redirect param (not ?fostend=)", async () => {
    vi.mocked(assignFoster).mockResolvedValue({
      ok: true,
      value: { redirectPath: "/org/ORG-tok/mascotas?foster=PET-tok" },
      notifications: [],
    });
    const fd = fakeFormData({ fosterUserId: "u-1" });
    const state = await assignFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    const path = state.redirectTo ?? "";
    expect(path).toContain("?foster=");
    expect(path).not.toContain("?fostend=");
  });
});

// ---------------------------------------------------------------------------
// endFosterAction
// ---------------------------------------------------------------------------

describe("endFosterAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it("returns { error } on auth failure", async () => {
    mockAuthError("no puede");
    const fd = fakeFormData({ reason: "returned" });
    const result = await endFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    expect(result).toEqual({ error: "no puede" });
  });

  it("uses ?fostend= redirect param (not ?foster=) — parity quirk", async () => {
    vi.mocked(endFoster).mockResolvedValue({
      ok: true,
      value: { redirectPath: "/org/ORG-tok/mascotas?fostend=PET-tok" },
      notifications: [],
    });
    const fd = fakeFormData({ reason: "returned" });
    const state = await endFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    const path = state.redirectTo ?? "";
    expect(path).toContain("?fostend=");
    expect(path).not.toContain("?foster=");
  });

  it("delegates to endFoster use-case with correct input", async () => {
    vi.mocked(endFoster).mockResolvedValue({
      ok: true,
      value: { redirectPath: "/org/ORG-tok/mascotas?fostend=PET-tok" },
      notifications: [NOTIFICATION],
    });
    const fd = fakeFormData({ reason: "early_return_by_foster", notes: "no podía más" });
    await endFosterAction("ORG-tok", "PET-tok", { error: null }, fd);
    expect(endFoster).toHaveBeenCalledWith(
      { petPublicToken: "PET-tok", reasonRaw: "early_return_by_foster", notes: "no podía más" },
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// proposeFosterAction — org side (requireCapability with orgId)
// ---------------------------------------------------------------------------

describe("proposeFosterAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it("returns { error } when use-case fails", async () => {
    vi.mocked(proposeFoster).mockResolvedValue({ ok: false, error: "co-foster bloqueado" });
    const result = await proposeFosterAction({
      orgToken: "ORG-tok",
      volunteerUserId: "vol-1",
      petPublicToken: "PET-tok",
    });
    expect(result).toEqual({ error: "co-foster bloqueado" });
  });

  it("returns { proposalPublicToken } on success and revalidates", async () => {
    vi.mocked(proposeFoster).mockResolvedValue({
      ok: true,
      value: {
        proposalPublicToken: "FP-abc123",
        revalidatePath: "/org/ORG-tok/voluntarios/propuestas",
      },
      notifications: [],
    });
    const result = await proposeFosterAction({
      orgToken: "ORG-tok",
      volunteerUserId: "vol-1",
      petPublicToken: "PET-tok",
    });
    expect(result).toEqual({ proposalPublicToken: "FP-abc123" });
    expect(revalidatePath).toHaveBeenCalledWith("/org/ORG-tok/voluntarios/propuestas");
  });
});

// ---------------------------------------------------------------------------
// cancelFosterProposalAction — auth scoped to proposal.organizationId (spec R6)
// ---------------------------------------------------------------------------

// Minimal proposal shape for cancelFosterProposalAction tests.
// Typed via cast because the full ProposalRow has many DB columns not relevant here.
type PartialProposalRow = Awaited<ReturnType<typeof FosterRepository.findProposalByToken>>;
const MOCK_PROPOSAL = {
  id: "prop-1",
  publicToken: "FP-tok",
  organizationId: "org-1",
  volunteerUserId: "vol-user-1",
  petId: "pet-1",
  status: "pending",
  caseId: "case-1",
} as unknown as NonNullable<PartialProposalRow>;

describe("cancelFosterProposalAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: proposal found for org-1; auth succeeds for org-1.
    vi.mocked(FosterRepository.findProposalByToken).mockResolvedValue(MOCK_PROPOSAL);
    mockAuth();
  });

  it("returns { error } when proposal is not found (before auth)", async () => {
    vi.mocked(FosterRepository.findProposalByToken).mockResolvedValue(null);
    const result = await cancelFosterProposalAction({ proposalPublicToken: "FP-tok" });
    expect(result).toEqual({ error: "Propuesta no encontrada." });
    // Auth must NOT be called when the proposal does not exist.
    expect(requireCapability).not.toHaveBeenCalled();
  });

  it("scopes requireCapability to proposal.organizationId (spec R6)", async () => {
    vi.mocked(cancelFosterProposal).mockResolvedValue({
      ok: true,
      value: { ok: true },
      notifications: [],
    });
    await cancelFosterProposalAction({ proposalPublicToken: "FP-tok" });
    expect(requireCapability).toHaveBeenCalledWith("foster.assign", "org-1");
  });

  it("rejects a user with foster.assign in a DIFFERENT org (cross-org bypass fix)", async () => {
    // Proposal belongs to org-1; requireCapability("foster.assign", "org-1") returns
    // an error for a user whose active membership is in a different org.
    vi.mocked(FosterRepository.findProposalByToken).mockResolvedValue(MOCK_PROPOSAL);
    mockAuthError("No tenés permiso en esta organización.");
    const result = await cancelFosterProposalAction({ proposalPublicToken: "FP-tok" });
    expect(result).toEqual({ error: "No tenés permiso en esta organización." });
    expect(cancelFosterProposal).not.toHaveBeenCalled();
  });

  it("returns { error } when use-case fails", async () => {
    vi.mocked(cancelFosterProposal).mockResolvedValue({
      ok: false,
      error: "Esta propuesta ya no está activa.",
    });
    const result = await cancelFosterProposalAction({
      proposalPublicToken: "FP-tok",
    });
    expect(result).toEqual({ error: "Esta propuesta ya no está activa." });
  });

  it("returns { ok: true } on success", async () => {
    vi.mocked(cancelFosterProposal).mockResolvedValue({
      ok: true,
      value: { ok: true },
      notifications: [],
    });
    const result = await cancelFosterProposalAction({
      proposalPublicToken: "FP-tok",
      cancellationReason: "ya no es necesario",
    });
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// acceptFosterProposalAction — auth via session (volunteer side)
// ---------------------------------------------------------------------------

describe("acceptFosterProposalAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession("vol-user-1");
  });

  it("returns { error: Sesión expirada. } when no session", async () => {
    mockSession(null);
    const result = await acceptFosterProposalAction({
      proposalPublicToken: "FP-tok",
      allowCoFoster: false,
    });
    expect(result).toEqual({ error: "Sesión expirada." });
  });

  it("returns use-case error on failure", async () => {
    vi.mocked(acceptFosterProposal).mockResolvedValue({
      ok: false,
      error: "ya sin slots",
    });
    const result = await acceptFosterProposalAction({
      proposalPublicToken: "FP-tok",
      allowCoFoster: false,
    });
    expect(result).toEqual({ error: "ya sin slots" });
  });

  it("returns fosterOwnershipId, remainingSlots, cascadeCancelledProposals on success", async () => {
    vi.mocked(acceptFosterProposal).mockResolvedValue({
      ok: true,
      value: {
        fosterOwnershipId: "own-1",
        remainingSlots: 0,
        cascadeCancelledProposals: ["FP-other"],
      },
      notifications: [],
    });
    const result = await acceptFosterProposalAction({
      proposalPublicToken: "FP-tok",
      allowCoFoster: true,
    });
    expect(result).toEqual({
      fosterOwnershipId: "own-1",
      remainingSlots: 0,
      cascadeCancelledProposals: ["FP-other"],
    });
  });
});

// ---------------------------------------------------------------------------
// rejectFosterProposalAction — auth via session (volunteer side)
// ---------------------------------------------------------------------------

describe("rejectFosterProposalAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession("vol-user-1");
  });

  it("returns { error } when use-case fails", async () => {
    vi.mocked(rejectFosterProposal).mockResolvedValue({ ok: false, error: "motivo inválido" });
    const result = await rejectFosterProposalAction({
      proposalPublicToken: "FP-tok",
      rejectionReason: "capacity",
    });
    expect(result).toEqual({ error: "motivo inválido" });
  });

  it("returns { ok: true } and revalidates on success", async () => {
    vi.mocked(rejectFosterProposal).mockResolvedValue({
      ok: true,
      value: { ok: true, revalidatePath: "/cuenta/transitos/propuestas" },
      notifications: [],
    });
    const result = await rejectFosterProposalAction({
      proposalPublicToken: "FP-tok",
      rejectionReason: "timing",
    });
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/cuenta/transitos/propuestas");
  });
});

// ---------------------------------------------------------------------------
// expireFosterProposalsAction — cron/system path, no actor
// ---------------------------------------------------------------------------

describe("expireFosterProposalsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stats on success", async () => {
    vi.mocked(expireUseCase).mockResolvedValue({
      ok: true,
      value: { candidates: 5, expired: 3, errors: 0 },
      notifications: [],
    });
    const result = await expireFosterProposalsAction();
    expect(result).toEqual({ candidates: 5, expired: 3, errors: 0 });
  });

  it("throws on use-case error", async () => {
    vi.mocked(expireUseCase).mockResolvedValue({ ok: false, error: "db down" });
    await expect(expireFosterProposalsAction()).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// upsertFosterVolunteerAction — auth via session
// ---------------------------------------------------------------------------

describe("upsertFosterVolunteerAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession("user-1");
  });

  it("returns { error } when no session", async () => {
    mockSession(null);
    const result = await upsertFosterVolunteerAction({
      mode: "enroll",
      status: "active",
      acceptsDogs: true,
      acceptsCats: false,
      acceptsOtherSpecies: false,
      acceptsSizeSmall: true,
      acceptsSizeMedium: true,
      acceptsSizeLarge: false,
      acceptsPuppies: false,
      acceptsSeniors: false,
      acceptsChronicConditions: false,
      acceptsDangerousBreeds: false,
    });
    expect(result).toEqual({ error: "Sesión expirada." });
  });

  it("returns volunteerId and availableSlots on success", async () => {
    vi.mocked(upsertFosterVolunteer).mockResolvedValue({
      ok: true,
      value: {
        volunteerId: "vol-1",
        availableSlots: 1,
        revalidatePath: "/cuenta/ofrecerme-como-transito",
      },
      notifications: [],
    });
    const result = await upsertFosterVolunteerAction({
      mode: "enroll",
      status: "active",
      acceptsDogs: true,
      acceptsCats: false,
      acceptsOtherSpecies: false,
      acceptsSizeSmall: true,
      acceptsSizeMedium: true,
      acceptsSizeLarge: false,
      acceptsPuppies: false,
      acceptsSeniors: false,
      acceptsChronicConditions: false,
      acceptsDangerousBreeds: false,
    });
    expect(result).toEqual({ volunteerId: "vol-1", availableSlots: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/cuenta/ofrecerme-como-transito");
  });
});

// ---------------------------------------------------------------------------
// withdrawFosterVolunteerAction — auth via session
// ---------------------------------------------------------------------------

describe("withdrawFosterVolunteerAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession("user-1");
  });

  it("returns { ok: true } and revalidates on success", async () => {
    vi.mocked(withdrawFosterVolunteer).mockResolvedValue({
      ok: true,
      value: { ok: true, revalidatePath: "/cuenta/ofrecerme-como-transito" },
      notifications: [],
    });
    const result = await withdrawFosterVolunteerAction();
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/cuenta/ofrecerme-como-transito");
  });

  it("returns { error } when use-case fails", async () => {
    vi.mocked(withdrawFosterVolunteer).mockResolvedValue({
      ok: false,
      error: "no inscripto",
    });
    const result = await withdrawFosterVolunteerAction();
    expect(result).toEqual({ error: "no inscripto" });
  });
});

// ---------------------------------------------------------------------------
// setCoFosterAllowedAction — auth via session
// ---------------------------------------------------------------------------

describe("setCoFosterAllowedAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession("user-1");
  });

  it("returns { ok: true } on success", async () => {
    vi.mocked(setCoFosterAllowed).mockResolvedValue({
      ok: true,
      value: { ok: true, revalidatePath: "/mis-mascotas" },
      notifications: [],
    });
    const result = await setCoFosterAllowedAction({
      fosterOwnershipId: "own-1",
      allowCoFoster: true,
    });
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/mis-mascotas");
  });

  it("returns { error } on failure", async () => {
    vi.mocked(setCoFosterAllowed).mockResolvedValue({ ok: false, error: "no es tuyo" });
    const result = await setCoFosterAllowedAction({
      fosterOwnershipId: "own-1",
      allowCoFoster: false,
    });
    expect(result).toEqual({ error: "no es tuyo" });
  });
});

// ---------------------------------------------------------------------------
// searchFosterVolunteers (read — org side)
// ---------------------------------------------------------------------------

describe("searchFosterVolunteers action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it("returns { error } on auth failure", async () => {
    mockAuthError("sin acceso");
    const result = await searchFosterVolunteers({ orgToken: "ORG-tok" });
    expect(result).toEqual({ error: "sin acceso" });
  });

  it("returns rows on success", async () => {
    const rows = [
      {
        userId: "u-1",
        displayName: "Test Vol",
        availableSlots: 2,
        acceptedCount: 3,
        matchScore: null,
        matchWarnings: [],
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: null,
      },
    ];
    vi.mocked(searchUseCase).mockResolvedValue({
      ok: true,
      value: { rows },
      notifications: [],
    });
    const result = await searchFosterVolunteers({ orgToken: "ORG-tok", limit: 50 });
    expect(result).toHaveProperty("rows");
    if ("rows" in result) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].userId).toBe("u-1");
    }
  });
});
