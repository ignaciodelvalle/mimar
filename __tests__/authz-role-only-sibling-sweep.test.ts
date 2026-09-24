// Regression tests for the role-only-gate sibling sweep (authz hardening).
//
// Before the fix, three server actions entered via getUser() (or a role-only
// requireAdminUser) and then delegated to a use-case that gated on ROLE ALONE.
// A DEACTIVATED operator, or an ERASED (soft-deleted, session still valid —
// Ley 25.326 art. 16) admin/govt whose profiles.role column still read
// 'admin'/'govt', slipped through. The fix moves the gate to the action
// boundary using the full-invariant institutional guards
// (requireAdminOrGovtOrRedirect / requireAdminOrRedirect), which reject
// role/accountType/deactivatedAt/deletedAt violations.
//
// Strategy (mirrors __tests__/auth-guards.test.ts): run the REAL guards, but
// mock the session (supabase/server), the profile row (request-cache), and
// next/navigation so redirect() is observable. The delegated use-cases are
// mocked so we can assert they are NEVER reached for a rejected actor and ARE
// reached (with the session-derived id) for an active one. No DB required.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- next/navigation: redirect() throws NEXT_REDIRECT in Next; mirror that ---
const mockRedirect = vi.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// --- session ---
const mockGetUser = vi.fn();
const mockSupabaseClient = { auth: { getUser: () => mockGetUser() } };
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

// --- profile row (drives the guards) ---
const mockGetProfileCached = vi.fn();
const mockGetJurisdictionsCached = vi.fn();
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...a: unknown[]) => mockGetProfileCached(...a),
  getJurisdictionsCached: (...a: unknown[]) => mockGetJurisdictionsCached(...a),
  getOrgMembershipCached: vi.fn(),
}));

// --- delegated use-cases (assert reached / not reached) ---
const mockUploadEvidence = vi.fn(async (..._a: unknown[]) => ({ attachmentId: "att-1" }));
vi.mock("@/src/modules/organizations/application/revocations/upload-evidence", () => ({
  uploadRevocationEvidence: (...a: unknown[]) => mockUploadEvidence(...a),
}));

const mockCreateSub = vi.fn(async (..._a: unknown[]) => ({ id: "sub-1" }));
const mockDeleteSub = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
const mockToggleSub = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@/src/modules/alerts/application/subscriptions/create-alert-subscription", () => ({
  createAlertSubscriptionForUser: (...a: unknown[]) => mockCreateSub(...a),
}));
vi.mock("@/src/modules/alerts/application/subscriptions/delete-alert-subscription", () => ({
  deleteAlertSubscriptionForUser: (...a: unknown[]) => mockDeleteSub(...a),
}));
vi.mock("@/src/modules/alerts/application/subscriptions/toggle-alert-subscription", () => ({
  toggleAlertSubscriptionForUser: (...a: unknown[]) => mockToggleSub(...a),
}));

// --- imports AFTER mocks are hoisted ---
import { createAlertSubscriptionAction } from "@/app/actions/alert-subscriptions";
import { uploadRevocationEvidence } from "@/app/actions/revocation-evidence";

function session(id: string) {
  return { data: { user: { id, email: `${id}@dim-test.local` } }, error: null };
}
function noSession() {
  return { data: { user: null }, error: null };
}
const ACTIVE_ADMIN = {
  id: "u-admin",
  role: "admin",
  displayName: "Admin",
  accountType: "institutional",
  deactivatedAt: null,
  deletedAt: null,
};
const DEACTIVATED_ADMIN = { ...ACTIVE_ADMIN, id: "u-deact", deactivatedAt: new Date("2026-01-01") };
const ERASED_ADMIN = { ...ACTIVE_ADMIN, id: "u-erased", deletedAt: new Date("2026-01-01") };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue(noSession());
  mockGetJurisdictionsCached.mockResolvedValue([]);
});

// ===========================================================================
// HIGH — revocation evidence upload (requireAdminOrGovtOrRedirect)
// ===========================================================================

describe("uploadRevocationEvidence — action-boundary gate", () => {
  const input = { targetId: "p", storagePath: "p/x", mimeType: "image/png", fileSize: 1 };

  it("rejects a DEACTIVATED admin before reaching the use-case", async () => {
    mockGetUser.mockResolvedValue(session(DEACTIVATED_ADMIN.id));
    mockGetProfileCached.mockResolvedValue(DEACTIVATED_ADMIN);
    await expect(uploadRevocationEvidence(input)).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockUploadEvidence).not.toHaveBeenCalled();
  });

  it("rejects an ERASED (soft-deleted) admin whose session is still valid", async () => {
    mockGetUser.mockResolvedValue(session(ERASED_ADMIN.id));
    mockGetProfileCached.mockResolvedValue(ERASED_ADMIN);
    await expect(uploadRevocationEvidence(input)).rejects.toThrow("NEXT_REDIRECT:/iniciar-sesion");
    expect(mockUploadEvidence).not.toHaveBeenCalled();
  });

  it("admits an active institutional admin and delegates with the session id", async () => {
    mockGetUser.mockResolvedValue(session(ACTIVE_ADMIN.id));
    mockGetProfileCached.mockResolvedValue(ACTIVE_ADMIN);
    const res = await uploadRevocationEvidence(input);
    expect(res).toEqual({ attachmentId: "att-1" });
    expect(mockUploadEvidence).toHaveBeenCalledWith(ACTIVE_ADMIN.id, input);
  });
});

// ===========================================================================
// MEDIUM — alert subscriptions (requireAdminOrRedirect)
// ===========================================================================

describe("createAlertSubscriptionAction — action-boundary gate", () => {
  const fd = () => {
    const f = new FormData();
    f.set("metricKey", "active_zoonosis");
    f.set("direction", "above");
    f.set("threshold", "10");
    return f;
  };

  it("rejects a DEACTIVATED admin before reaching the use-case", async () => {
    mockGetUser.mockResolvedValue(session(DEACTIVATED_ADMIN.id));
    mockGetProfileCached.mockResolvedValue(DEACTIVATED_ADMIN);
    await expect(createAlertSubscriptionAction(fd())).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockCreateSub).not.toHaveBeenCalled();
  });

  it("rejects an ERASED (soft-deleted) admin whose session is still valid", async () => {
    mockGetUser.mockResolvedValue(session(ERASED_ADMIN.id));
    mockGetProfileCached.mockResolvedValue(ERASED_ADMIN);
    await expect(createAlertSubscriptionAction(fd())).rejects.toThrow(
      "NEXT_REDIRECT:/iniciar-sesion",
    );
    expect(mockCreateSub).not.toHaveBeenCalled();
  });

  it("admits an active institutional admin and delegates with the session id", async () => {
    mockGetUser.mockResolvedValue(session(ACTIVE_ADMIN.id));
    mockGetProfileCached.mockResolvedValue(ACTIVE_ADMIN);
    const res = await createAlertSubscriptionAction(fd());
    expect(res).toEqual({ ok: true, id: "sub-1" });
    expect(mockCreateSub).toHaveBeenCalledWith(ACTIVE_ADMIN.id, expect.any(Object));
  });
});
