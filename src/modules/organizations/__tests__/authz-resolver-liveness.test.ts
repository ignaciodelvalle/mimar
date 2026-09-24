// Mock-based unit tests for the LIVENESS half of requireCapability /
// requireCapabilityForOrgToken — the maintenance kill-switch and institutional
// deactivation (RN re-run HIGH, 2026-08-22).
//
// Same harness as authz-resolver-erasure.test.ts, and kept separate from
// authz-resolver.test.ts for the same reason: that file is a real-Supabase
// integration test and a global mock of @/db would break its fixtures.
//
// WHAT WAS WRONG. Both capability guards resolved the caller with a bare
// `auth.getUser()` plus the erasure check, and nothing else. ~18 org entry
// points — cross-org transfers, foster assignment, member management, bite
// reports, rehome accept/decline, atender — are gated by nothing but these two
// functions, so during a maintenance window an org kept transferring custody,
// and a DEACTIVATED institutional account kept mutating through every one of
// them. requireLiveUser (lib/infra/live-user.ts) already answers all four
// liveness questions in one place; the guards now consult IT instead of a
// parallel, narrower resolution.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockSupabaseClient = { auth: { getUser: () => mockGetUser() } };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/request-cache
// ---------------------------------------------------------------------------

const mockGetProfileCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
}));

// ---------------------------------------------------------------------------
// Mock: @/db — every refusal under test must short-circuit BEFORE any query,
// so `mockSelect` is the witness that no membership (or org) row was read.
// ---------------------------------------------------------------------------

const { chain, mockSelect } = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const chain: Record<string, unknown> = {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return chain;
    },
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve([]),
    limit: () => Promise.resolve([]),
  };
  return { chain, mockSelect };
});

vi.mock("@/db", () => ({
  db: chain,
  ORGANIZATION_CAPABILITIES: [],
  organizationCapabilityGrants: {},
  organizationMemberships: {},
  organizations: {},
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are hoisted
// ---------------------------------------------------------------------------

import {
  DEACTIVATED_MESSAGE_INSTITUTIONAL,
  DEACTIVATED_MESSAGE_PERSONAL,
  liveUserMessage,
} from "@/lib/infra/live-user";
import {
  requireCapability,
  requireCapabilityForOrgToken,
} from "@/src/modules/organizations/infrastructure/authz-resolver";

type Capability = Parameters<typeof requireCapability>[0];
const CAP = "member.invite" as Capability;

function userSession(id = "user-001") {
  return { data: { user: { id, email: `${id}@dim-test.local` } }, error: null };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-001",
    role: "owner",
    displayName: "Someone",
    accountType: "personal",
    deactivatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", undefined);
  mockGetUser.mockResolvedValue(userSession());
  mockGetProfileCached.mockResolvedValue(profile());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Maintenance — the kill-switch must stop every org WRITE, and it must answer
// before any round-trip, because the database may be the thing under repair.
// ---------------------------------------------------------------------------

describe("requireCapability — maintenance kill-switch", () => {
  it("refuses during maintenance BEFORE resolving a session or a profile", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "1");

    const result = await requireCapability(CAP);

    expect(result.error).toBe(liveUserMessage("MAINTENANCE"));
    expect(result.membership).toBeNull();
    expect(result.granted).toBeNull();
    // No client, no profile, no membership query: an env read decided.
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockGetProfileCached).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("requireCapabilityForOrgToken refuses during maintenance WITHOUT looking the org up", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "true");

    const result = await requireCapabilityForOrgToken(CAP, "ORG-TOKEN");

    expect(result.error).toBe(liveUserMessage("MAINTENANCE"));
    // The org-by-token lookup is a DB read. The kill-switch has to work when
    // the database is what is being maintained, so it must not run first.
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("still lets a live caller through when the switch is off (non-vacuity)", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "false");

    const result = await requireCapability(CAP);

    // Reached the membership query and found none — the ordinary refusal,
    // NOT a liveness one. Proves the maintenance branch is not `return refuse`.
    expect(result.error).toBe("No pertenecés a ninguna organización activa.");
    expect(mockSelect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deactivation — reads stay open, writes stop (lib/infra/auth-guards.ts:60-70)
// ---------------------------------------------------------------------------

describe("requireCapability — institutional deactivation", () => {
  const deactivatedInstitutional = () =>
    profile({ accountType: "institutional", deactivatedAt: new Date("2026-08-01") });

  it("refuses a DEACTIVATED institutional account by default — the guards gate writes", async () => {
    mockGetProfileCached.mockResolvedValue(deactivatedInstitutional());

    const result = await requireCapability(CAP, "org-1");

    // The INSTITUTIONAL constant, not liveUserMessage("DEACTIVATED"). Since
    // 2026-09-11 those are different strings: the reason is one wire code with
    // TWO messages behind it, because the refusal now reaches personal accounts
    // too and "Tu cuenta institucional esta desactivada" was being said to
    // people who have no institution. liveUserMessage() is the reason-only
    // fallback and names neither type; this path only ever serves an
    // institutional caller, so it earns the specific sentence.
    expect(result.error).toBe(DEACTIVATED_MESSAGE_INSTITUTIONAL);
    expect(result.user).toEqual({ id: "user-001" });
    expect(result.membership).toBeNull();
    // Short-circuits before the membership query.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("requireCapabilityForOrgToken refuses the same account the same way", async () => {
    mockGetProfileCached.mockResolvedValue(deactivatedInstitutional());

    const result = await requireCapabilityForOrgToken(CAP, "ORG-TOKEN");

    expect(result.error).toBe(DEACTIVATED_MESSAGE_INSTITUTIONAL);
    expect(result.membership).toBeNull();
  });

  it("keeps a READ open for the same account when the caller says so", async () => {
    // The seven org pages and three export/template handlers that gate a READ
    // on a capability pass `access: "read"`: a deactivated account must keep a
    // surface it can read the explanation on, and bouncing it off everything
    // is how the 2026-07-04 ERR_TOO_MANY_REDIRECTS incident happened.
    mockGetProfileCached.mockResolvedValue(deactivatedInstitutional());

    const result = await requireCapability(CAP, "org-1", { access: "read" });

    // Went on to the membership query and found none: the ordinary refusal.
    expect(result.error).toBe("No pertenecés a ninguna organización activa.");
    expect(mockSelect).toHaveBeenCalled();
  });

  it("REFUSES a deactivated personal account too — the predicate widened on 2026-09-11", async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the change
    // rather than a slip. Its old comment read: "`deactivated_at` on a personal
    // account is a bookkeeping flag nothing reads for access today (live-user.ts
    // says why). Widening it here would be a silent policy change, not a fix."
    //
    // That was an accurate description of the code and a bad description of the
    // product. `/cuenta` offered "Desactivar mi cuenta" and told the person the
    // act was irreversible from the panel — while the mark it wrote was read by
    // nothing, so the account kept working. The dialog promised a guarantee that
    // did not exist.
    //
    // The predicate in `requireLiveUser` no longer asks for `accountType ===
    // "institutional"`, and this resolver follows it deliberately: somebody who
    // switched their own account off must not keep acting through an org
    // capability either. The message is the PERSONAL one, because this person
    // has somewhere to go — they can turn it back on themselves — and the
    // institutional sentence would send them to ask a stranger for permission to
    // reverse their own decision.
    mockGetProfileCached.mockResolvedValue(
      profile({ accountType: "personal", deactivatedAt: new Date("2026-08-01") }),
    );

    const result = await requireCapability(CAP, "org-1");

    expect(result.error).toBe(DEACTIVATED_MESSAGE_PERSONAL);
    // Short-circuits before the membership query, exactly like the
    // institutional case — the refusal does not depend on what they belong to.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("an ERASED account outranks deactivation", async () => {
    mockGetProfileCached.mockResolvedValue(
      profile({
        accountType: "institutional",
        deactivatedAt: new Date("2026-08-01"),
        deletedAt: new Date("2026-08-02"),
      }),
    );

    const result = await requireCapability(CAP);

    expect(result.error).toBe(liveUserMessage("ACCOUNT_ERASED"));
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
