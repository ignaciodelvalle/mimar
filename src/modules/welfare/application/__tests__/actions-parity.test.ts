// Parity tests for welfare actions.ts — thin action auth scope.
//
// Each test proves that a caller with the WRONG principal is REJECTED before
// the use-case runs. This is the foster cross-org bypass lesson applied to
// welfare: scope MUST be enforced at the action edge, not assumed.
//
// These tests mock the auth-guard module so they run without a real session.
// They do NOT mock the use-case — they import actions.ts directly.
//
// Auth scope contract (from spec):
//   - triage / start / close / assign / unassign / mpf-export:
//       requireAdminOrGovtOrRedirect()
//   - moderation pass / confirm:
//       requireAdminOrRedirect() — govt CANNOT moderate
//
// A "wrong principal" for moderation is a govt user.
// A "wrong principal" for triage is an unauthenticated caller (redirect = throws).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock auth-guards — vi.mock is hoisted, so we use a factory
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: vi.fn(),
  requireAdminOrRedirect: vi.fn(),
}));

// vi.mock is hoisted — imports after this are module-level
import * as authGuards from "@/lib/infra/auth-guards";

// We also need to mock next/cache (server action context)
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// These tests verify that if requireAdminOrRedirect is called for moderation
// actions (instead of requireAdminOrGovtOrRedirect), a govt session that
// calls the admin-only guard gets redirected (i.e., the guard throws or
// redirects and the action does not proceed).
//
// The actual actions are in src/modules/welfare/actions.ts (created in task 2.6).
// We import them here.
// ---------------------------------------------------------------------------

describe("auth scope — moderation actions are admin-ONLY", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // Timeout is generous: a prior file in the serial suite may call
  // vi.resetModules(), forcing a cold re-import of actions.ts here.
  // 15 s covers the warm-up; under normal conditions this runs in < 1 s.
  it("passWelfareToTriageAction: calls requireAdminOrRedirect (not the govt-inclusive guard)", async () => {
    // Mock requireAdminOrRedirect to simulate redirect (throws NEXT_REDIRECT)
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireAdminOrRedirect).mockRejectedValue(redirect);

    // Dynamically import to avoid caching issues in test env
    const { passWelfareToTriageAction } = await import("../../actions");

    await expect(
      passWelfareToTriageAction({ welfareReportId: "rpt-001", notes: "Denuncia parece válida." }),
    ).rejects.toThrow("NEXT_REDIRECT");

    // The CORRECT guard was called — admin-only
    expect(authGuards.requireAdminOrRedirect).toHaveBeenCalled();
    // The WRONG guard was NOT called
    expect(authGuards.requireAdminOrGovtOrRedirect).not.toHaveBeenCalled();
  }, 15_000);

  it("confirmWelfareAsSpamAction: calls requireAdminOrRedirect (not the govt-inclusive guard)", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireAdminOrRedirect).mockRejectedValue(redirect);

    const { confirmWelfareAsSpamAction } = await import("../../actions");

    await expect(
      confirmWelfareAsSpamAction({ welfareReportId: "rpt-001", notes: "Claramente spam aquí." }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(authGuards.requireAdminOrRedirect).toHaveBeenCalled();
    expect(authGuards.requireAdminOrGovtOrRedirect).not.toHaveBeenCalled();
  });
});

describe("auth scope — triage/assign/unassign/mpf use requireAdminOrGovtOrRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("triageWelfareReportAction: calls requireAdminOrGovtOrRedirect", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireAdminOrGovtOrRedirect).mockRejectedValue(redirect);

    const { triageWelfareReportAction } = await import("../../actions");

    await expect(
      triageWelfareReportAction({
        welfareReportId: "rpt-001",
        decision: "triaged",
        notes: "Denuncia parece válida.",
      }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(authGuards.requireAdminOrGovtOrRedirect).toHaveBeenCalled();
    expect(authGuards.requireAdminOrRedirect).not.toHaveBeenCalled();
  });

  it("assignWelfareToMeAction: calls requireAdminOrGovtOrRedirect", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireAdminOrGovtOrRedirect).mockRejectedValue(redirect);

    const { assignWelfareToMeAction } = await import("../../actions");

    await expect(assignWelfareToMeAction("rpt-001")).rejects.toThrow("NEXT_REDIRECT");

    expect(authGuards.requireAdminOrGovtOrRedirect).toHaveBeenCalled();
    expect(authGuards.requireAdminOrRedirect).not.toHaveBeenCalled();
  });

  it("unassignWelfareAction: calls requireAdminOrGovtOrRedirect", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireAdminOrGovtOrRedirect).mockRejectedValue(redirect);

    const { unassignWelfareAction } = await import("../../actions");

    await expect(unassignWelfareAction("rpt-001")).rejects.toThrow("NEXT_REDIRECT");

    expect(authGuards.requireAdminOrGovtOrRedirect).toHaveBeenCalled();
  });

  it("generateMpfExportAction: calls requireAdminOrGovtOrRedirect", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(authGuards.requireAdminOrGovtOrRedirect).mockRejectedValue(redirect);

    const { generateMpfExportAction } = await import("../../actions");

    await expect(generateMpfExportAction("rpt-001")).rejects.toThrow("NEXT_REDIRECT");

    expect(authGuards.requireAdminOrGovtOrRedirect).toHaveBeenCalled();
  });
});
