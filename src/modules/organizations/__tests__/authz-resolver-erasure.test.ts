// Mock-based unit test for the erased-account lockout in requireCapability
// (Wave E2 — Ley 25.326 art. 16). Kept separate from authz-resolver.test.ts,
// which is a real-Supabase integration test: this file globally mocks @/db and
// @/lib/supabase/server, which would break the integration fixtures.
//
// requireCapability is the org-side mutation guard behind member management,
// capability grants, cross-org custody transfers, and foster/adoption state
// changes. Like requirePetAccess it resolves the user from the JWT — which stays
// valid after erase_subject_data() soft-deletes the profile. It must reject an
// erased account BEFORE loading memberships.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockSupabaseClient = { auth: { getUser: () => mockGetUser() } };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/request-cache (getProfileCached carries deletedAt)
// ---------------------------------------------------------------------------

const mockGetProfileCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
}));

// ---------------------------------------------------------------------------
// Mock: @/db — the erased path must short-circuit before getActiveMemberships,
// so `mockSelect` asserts no membership query is issued.
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

import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

function userSession(id = "user-001") {
  return { data: { user: { id, email: `${id}@dim-test.local` } }, error: null };
}
function noSession() {
  return { data: { user: null }, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue(noSession());
});

describe("requireCapability — right-to-erasure lockout (Wave E2)", () => {
  it("denies an erased account (deletedAt set) before loading memberships", async () => {
    mockGetUser.mockResolvedValue(userSession("user-erased"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-erased",
      role: "owner",
      displayName: "erased:abc",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: new Date("2026-07-04"),
    });

    const result = await requireCapability(
      "member.invite" as Parameters<typeof requireCapability>[0],
    );

    expect(result.error).toBe("Tu cuenta fue eliminada.");
    expect(result.membership).toBeNull();
    // Short-circuits before the getActiveMemberships query.
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns 'Sesión expirada.' and never loads a profile when there is no session", async () => {
    mockGetUser.mockResolvedValue(noSession());

    const result = await requireCapability(
      "member.invite" as Parameters<typeof requireCapability>[0],
    );

    expect(result.error).toBe("Sesión expirada.");
    expect(mockGetProfileCached).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
