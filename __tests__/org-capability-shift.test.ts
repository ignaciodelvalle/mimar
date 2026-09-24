// B9 — the 8-hour shift on the ORG CAPABILITY path.
//
// WHY THIS NEEDS ITS OWN FILE AND ITS OWN ARGUMENT
// ---------------------------------------------------------------------------
// requireLiveUser refuses a shift-expired INSTITUTIONAL profile, and
// __tests__/operator-shift.test.ts pins that. It cannot refuse the principal
// this file is about. An org staffer — a vet in a clinic, a coordinator in a
// refugio — commonly holds `role: "vet"` / `accountType: "personal"`; their
// operator-ness lives in `organization_memberships`, which requireLiveUser never
// reads. Without the second check in resolveLiveActor, the single largest group
// of org-console operators would keep a citizen-length session on exactly the
// shared front-desk machine B9 exists for.
//
// So these tests deliberately use a PERSONAL profile throughout. If the
// implementation ever collapses back to "requireLiveUser already handles it",
// every assertion here fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireLiveUser = vi.fn();

vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: () => mockRequireLiveUser(),
}));

// A DB whose every entry point records the fact it was reached. The shift check
// runs BEFORE membership resolution, so "was the DB touched?" is a direct
// observation of the ordering — a refused operator must not cost a query.
const mockDbSelect = vi.fn();

vi.mock("@/db", () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
  organizationCapabilityGrants: {},
  organizationMemberships: { userId: "userId", leftAt: "leftAt", joinedAt: "joinedAt", id: "id" },
  organizations: { id: "id", publicToken: "publicToken" },
}));

vi.mock("@/src/modules/organizations/domain/capabilities", () => ({
  resolveGrantedCaps: () => new Set<string>(),
}));

const mockReportError = vi.fn();

vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import {
  requireCapability,
  requireCapabilityForOrgToken,
  resolveLiveOrgActor,
} from "@/src/modules/organizations/infrastructure/authz-resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-25T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

/** A LIVE result for an org staffer on a PERSONAL profile — the whole point. */
function liveOrgStaffer(sessionStartedAt: Date | null) {
  return {
    ok: true,
    supabase: {},
    user: { id: "user-001", email: "vet@clinica.test" },
    profile: {
      id: "user-001",
      role: "vet",
      displayName: "Vet",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: null,
    },
    sessionStartedAt,
  };
}

/** Makes the membership query resolve to nothing, so the happy path terminates. */
function dbReturnsNoMemberships() {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve([]),
    limit: () => Promise.resolve([]),
  };
  mockDbSelect.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbReturnsNoMemberships();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("requireCapability — the 8-hour shift for org staff", () => {
  it("refuses a PERSONAL-profile org staffer past 8 hours", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(9)));

    const result = await requireCapability("intake.create");

    expect(result.error).toMatch(/turno de trabajo/i);
    expect(result.membership).toBeNull();
    expect(result.granted).toBeNull();
    // The refusal still names the actor, matching every other failure here.
    expect(result.user?.id).toBe("user-001");
  });

  it("does not spend a query on a refused operator — the shift check runs first", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(9)));

    await requireCapability("intake.create");

    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("lets the same staffer through inside the 8 hours", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(7)));

    const result = await requireCapability("intake.create");

    // Past the liveness gate: it got as far as resolving memberships, and failed
    // on membership rather than on the shift.
    expect(mockDbSelect).toHaveBeenCalled();
    expect(result.error).toBe("No pertenecés a ninguna organización activa.");
  });

  it("applies to READS too, unlike DEACTIVATED", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(9)));

    // A deactivated account keeps its reads so it can see why it was switched
    // off; nothing it does would change that state. A shift is over for
    // everyone and is fixed by signing in again — and leaving org reads open
    // leaves the console populated on the shared desk, which is the exposure.
    const result = await requireCapability("intake.create", undefined, { access: "read" });

    expect(result.error).toMatch(/turno de trabajo/i);
  });

  it("guards the org-token entry point on the same terms", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(9)));

    const result = await requireCapabilityForOrgToken("intake.create", "ORG-TOKEN-0001");

    expect(result.error).toMatch(/turno de trabajo/i);
    // Refused before the org lookup, so the endpoint stays silent about whether
    // that token names a real organization.
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("fails OPEN when the session start is unknown, and reports", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(null));

    const result = await requireCapability("intake.create");

    expect(result.error).toBe("No pertenecés a ninguna organización activa.");
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  // resolveLiveOrgActor is the door the WALK-IN clinical surface entered
  // through on 2026-08-25 (app/org/[orgToken]/atender). It shares
  // resolveLiveActor with the two guards above, and this pins that it does —
  // because if it ever grew its own liveness step, the surface it exists for is
  // a clinic's shared front desk and the check it would forget is this one.
  it("carries the same shift into resolveLiveOrgActor, the walk-in door", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(9)));

    const actor = await resolveLiveOrgActor("ORG-TOKEN-0001");

    expect(actor.ok).toBe(false);
    if (!actor.ok) {
      expect(actor.reason).toBe("SHIFT_EXPIRED");
      expect(actor.error).toMatch(/turno de trabajo/i);
      expect(actor.userId).toBe("user-001");
    }
    // Same ordering guarantee: refused before the org lookup, so the walk-in
    // surface says nothing about whether that token names a real organization.
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("lets the walk-in door through inside the 8 hours", async () => {
    mockRequireLiveUser.mockResolvedValue(liveOrgStaffer(hoursAgo(7)));

    const actor = await resolveLiveOrgActor("ORG-TOKEN-0001");

    // Past the shift: it got as far as the org lookup, which this mock answers
    // with nothing.
    expect(mockDbSelect).toHaveBeenCalled();
    expect(actor.ok).toBe(false);
    if (!actor.ok) expect(actor.reason).toBe("NO_ORGANIZATION");
  });

  it("passes a liveness refusal through unchanged, ahead of any shift logic", async () => {
    mockRequireLiveUser.mockResolvedValue({
      ok: false,
      supabase: null,
      user: null,
      reason: "MAINTENANCE",
      error:
        "miMAR está en mantenimiento. Tu cambio no se registró — probá de nuevo en unos minutos.",
    });

    const result = await requireCapability("intake.create");

    expect(result.error).toMatch(/mantenimiento/i);
    expect(result.user).toBeNull();
  });
});
