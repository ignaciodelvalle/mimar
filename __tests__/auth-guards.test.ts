// Unit tests for page-level auth guards in lib/auth-guards.ts.
//
// Strategy:
//   - Mock @/lib/supabase/server so createClient().auth.getUser() is controllable.
//   - Mock @/lib/request-cache so getProfileCached / getJurisdictionsCached /
//     getOrgMembershipCached return deterministic rows.
//   - Mock next/navigation so redirect() and notFound() are captured rather than
//     throwing control-flow exceptions (we still rethrow to mirror Next semantics,
//     but we can spy on the target).
//
// All tests are pure mock-based — no DB, no Supabase instance required.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: next/navigation
// redirect() in Next.js throws NEXT_REDIRECT; we mirror that here so code
// after redirect() is unreachable, but we can spy on the destination.
// notFound() also throws; capture it the same way.
// ---------------------------------------------------------------------------

const mockRedirect = vi.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
const mockNotFound = vi.fn((): never => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
  notFound: () => mockNotFound(),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
// getSession carries the access token whose `aal` claim the second-factor policy
// reads (T2-S6). Default: no session token → the claim is unknown → the policy
// fails open, which is what every pre-MFA test in this file relies on.
const mockGetSession = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/request-cache
// ---------------------------------------------------------------------------

const mockGetProfileCached = vi.fn();
const mockGetJurisdictionsCached = vi.fn();
const mockGetOrgMembershipCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
  getJurisdictionsCached: (...args: unknown[]) => mockGetJurisdictionsCached(...args),
  getOrgMembershipCached: (...args: unknown[]) => mockGetOrgMembershipCached(...args),
}));

// ---------------------------------------------------------------------------
// Import guards AFTER mocks are hoisted
// ---------------------------------------------------------------------------

import {
  requireAdminOrGovtOrRedirect,
  requireAdminOrRedirect,
  requireDecomisoPrincipal,
  requireGobReadAccessOrRedirect,
  requireOrgAccessByToken,
  requireUserOrRedirect,
} from "@/lib/infra/auth-guards";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userSession(id = "user-001", email = "user@dim-test.local") {
  return { data: { user: { id, email } }, error: null };
}

function noSession() {
  return { data: { user: null }, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Maintenance is the first thing every guard now consults (B52); pin it OFF
  // so a stray env value in the shell cannot silently green the whole file.
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "0");
  // Default: no session (safest default — each test sets what it needs)
  mockGetUser.mockResolvedValue(noSession());
  mockGetSession.mockResolvedValue({ data: { session: null } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// requireUserOrRedirect
// ---------------------------------------------------------------------------

describe("requireUserOrRedirect", () => {
  it("redirects to /iniciar-sesion when there is no session", async () => {
    mockGetUser.mockResolvedValue(noSession());
    await expect(requireUserOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/iniciar-sesion");
    expect(mockRedirect).toHaveBeenCalledWith("/iniciar-sesion");
  });

  it("preserves returnTo on the /iniciar-sesion redirect when no session and a path is given", async () => {
    mockGetUser.mockResolvedValue(noSession());
    await expect(requireUserOrRedirect("/mis-mascotas/DIM-ABCD-1234")).rejects.toThrow(
      "NEXT_REDIRECT:/iniciar-sesion?returnTo=",
    );
    expect(mockRedirect).toHaveBeenCalledWith(
      `/iniciar-sesion?returnTo=${encodeURIComponent("/mis-mascotas/DIM-ABCD-1234")}`,
    );
  });

  it("returns the supabase client and user when a session exists", async () => {
    mockGetUser.mockResolvedValue(userSession("user-abc", "alice@dim.local"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-abc",
      role: "owner",
      displayName: "Alice",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: null,
    });
    const result = await requireUserOrRedirect();
    expect(result.user.id).toBe("user-abc");
    expect(result.user.email).toBe("alice@dim.local");
    expect(result.supabase).toBe(mockSupabaseClient);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Wave D2 (Ley 25.326 art. 16 — finding 27-#1): an erased account keeps a
  // valid Supabase session until the token expires. requireUserOrRedirect must
  // treat a non-null profiles.deleted_at as "no access" and bounce to /iniciar-sesion,
  // which renders the "cuenta eliminada" notice instead of looping back in.
  it("redirects to /iniciar-sesion when the profile has been erased (deletedAt set)", async () => {
    mockGetUser.mockResolvedValue(userSession("user-erased", "erased@dim.local"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-erased",
      role: "owner",
      displayName: "erased:abc",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: new Date("2026-07-04"),
    });
    await expect(requireUserOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/iniciar-sesion");
    expect(mockRedirect).toHaveBeenCalledWith("/iniciar-sesion");
  });

  // An erased account can never come back, so returnTo is intentionally dropped:
  // it bounces to plain /iniciar-sesion (which renders the "cuenta eliminada" notice),
  // NOT to a returnTo that would loop it back into a surface it can't reach.
  it("ignores returnTo for an erased account and redirects to plain /iniciar-sesion", async () => {
    mockGetUser.mockResolvedValue(userSession("user-erased", "erased@dim.local"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-erased",
      role: "owner",
      displayName: "erased:abc",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: new Date("2026-07-04"),
    });
    await expect(requireUserOrRedirect("/mis-mascotas/DIM-ABCD-1234")).rejects.toThrow(
      "NEXT_REDIRECT:/iniciar-sesion",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/iniciar-sesion");
  });

  // B52 — the live-bug half of T1.2. Before this, maintenance was enforced in
  // FOUR LAYOUTS only. A layout gates a render; a Server Action runs its body
  // before any layout re-renders, so a maintenance window did not stop an
  // in-flight write — the mutation committed and the user was then shown the
  // maintenance screen. Routing every guard through requireLiveUser() moves the
  // decision to the one place a write actually passes through.
  it("redirects to /mantenimiento while the maintenance kill-switch is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "1");
    mockGetUser.mockResolvedValue(userSession("user-live"));

    await expect(requireUserOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/mantenimiento");
    expect(mockRedirect).toHaveBeenCalledWith("/mantenimiento");
  });

  it("does not resolve a session at all during maintenance", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "true");

    await expect(requireUserOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/mantenimiento");
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockGetProfileCached).not.toHaveBeenCalled();
  });

  // Deliberate asymmetry, not an oversight. requireLiveUser() reports
  // DEACTIVATED, and every WRITE boundary refuses on it — but this page-level
  // wrapper tolerates it. A deactivated institutional account that is bounced
  // off every surface has no /cuenta to read the explanation on and no logout
  // affordance to reach; that shape is exactly the 2026-07-04 redirect loop
  // (ERR_TOO_MANY_REDIRECTS, no app surface, no feedback). The operator portals
  // still reject it in loadActiveInstitutionalProfile, unchanged.
  it("tolerates a deactivated institutional account so it can still reach /cuenta", async () => {
    mockGetUser.mockResolvedValue(userSession("user-deact"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-deact",
      role: "govt",
      displayName: "Govt",
      accountType: "institutional",
      deactivatedAt: new Date("2026-08-01"),
      deletedAt: null,
    });

    const result = await requireUserOrRedirect();

    expect(result.user.id).toBe("user-deact");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does not redirect an active (non-erased) account with a session", async () => {
    mockGetUser.mockResolvedValue(userSession("user-live"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-live",
      role: "owner",
      displayName: "Live User",
      accountType: "personal",
      deactivatedAt: null,
      deletedAt: null,
    });
    const result = await requireUserOrRedirect();
    expect(result.user.id).toBe("user-live");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Pilot T1-P3: a session minted by an institutional invite link owes its
  // password. Every guarded page sends it to the first-access step — the
  // operator portals included, since they all start here.
  const govtProfile = {
    id: "user-invited",
    role: "govt",
    displayName: "Invitado",
    accountType: "institutional",
    deactivatedAt: null,
    deletedAt: null,
  };

  it("sends a session that still owes its password to /primer-acceso", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-invited", app_metadata: { password_setup_pending: true } } },
      error: null,
    });
    mockGetProfileCached.mockResolvedValue(govtProfile);
    await expect(requireUserOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/primer-acceso");
    await expect(requireGobReadAccessOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/primer-acceso");
  });

  it("lets the same account through once the flag is cleared, and ignores a non-boolean flag", async () => {
    mockGetProfileCached.mockResolvedValue(govtProfile);
    for (const flag of [false, "true", undefined]) {
      mockGetUser.mockResolvedValue({
        data: { user: { id: "user-invited", app_metadata: { password_setup_pending: flag } } },
        error: null,
      });
      const result = await requireUserOrRedirect();
      expect(result.user.id).toBe("user-invited");
    }
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Second factor (T2-S6) — institutional sessions go to /mfa or /mfa/configurar
// ---------------------------------------------------------------------------

describe("second factor for institutional accounts (T2-S6)", () => {
  const govt = {
    id: "user-govt",
    role: "govt",
    displayName: "Funcionaria",
    accountType: "institutional",
    deactivatedAt: null,
    deletedAt: null,
  };
  const verifiedTotp = [{ id: "f-1", factor_type: "totp", status: "verified" }];
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tokenAt = (aal: string) => `${b64({ alg: "HS256" })}.${b64({ aal, amr: [] })}.sig`;

  function signedIn(factors: unknown[] | undefined, aal: string, profile: object = govt) {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-govt", email: "g@x.test", factors } },
      error: null,
    });
    mockGetSession.mockResolvedValue({ data: { session: { access_token: tokenAt(aal) } } });
    mockGetProfileCached.mockResolvedValue(profile);
    mockGetJurisdictionsCached.mockResolvedValue([]);
  }

  it("sends an institutional account with no verified factor to enrol", async () => {
    signedIn([{ id: "f-0", factor_type: "totp", status: "unverified" }], "aal1");
    await expect(requireGobReadAccessOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/mfa/configurar");
  });

  it("sends a verified-factor account still at aal1 to the challenge, keeping returnTo", async () => {
    signedIn(verifiedTotp, "aal1");
    await expect(requireUserOrRedirect("/gob/cola")).rejects.toThrow(
      "NEXT_REDIRECT:/mfa?returnTo=%2Fgob%2Fcola",
    );
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/mfa");
  });

  it("lets an aal2 session with a verified factor through", async () => {
    signedIn(verifiedTotp, "aal2");
    const result = await requireAdminOrGovtOrRedirect();
    expect(result.profile.role).toBe("govt");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does not ask a personal account for a second factor", async () => {
    signedIn(undefined, "aal1", { ...govt, role: "owner", accountType: "personal" });
    const result = await requireUserOrRedirect();
    expect(result.user.id).toBe("user-govt");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requireAdminOrGovtOrRedirect
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// national — the read-only institutional role (migration 0214)
//
// ONE read gate admits it (requireGobReadAccessOrRedirect, the /gob layout and
// read pages); EVERY write-authority gate refuses it. The refusal at
// requireAdminOrGovtOrRedirect is what keeps the eleven app/actions writers and
// the src/modules action files closed to it without touching any of them.
// ---------------------------------------------------------------------------

function nationalProfile(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "user-national",
    role: "national",
    displayName: "Lectura nacional",
    accountType: "institutional",
    deactivatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("national role — read gate admits, write gates refuse", () => {
  it("requireGobReadAccessOrRedirect admits an active institutional national with EMPTY jurisdictions and no assignment fetch", async () => {
    mockGetUser.mockResolvedValue(userSession("user-national"));
    mockGetProfileCached.mockResolvedValue(nationalProfile());
    const result = await requireGobReadAccessOrRedirect();
    expect(result.profile.role).toBe("national");
    expect(result.jurisdictions).toEqual([]);
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("requireGobReadAccessOrRedirect still admits admin and govt (govt with its tuples)", async () => {
    mockGetUser.mockResolvedValue(userSession("user-govt"));
    mockGetProfileCached.mockResolvedValue(nationalProfile({ id: "user-govt", role: "govt" }));
    mockGetJurisdictionsCached.mockResolvedValue([{ province: "CABA", locality: "Palermo" }]);
    const result = await requireGobReadAccessOrRedirect();
    expect(result.profile.role).toBe("govt");
    expect(result.jurisdictions).toEqual([{ province: "CABA", locality: "Palermo" }]);
  });

  it("requireGobReadAccessOrRedirect bounces a personal role to the explained access-denied screen", async () => {
    mockGetUser.mockResolvedValue(userSession("user-owner"));
    mockGetProfileCached.mockResolvedValue(
      nationalProfile({ id: "user-owner", role: "owner", accountType: "personal" }),
    );
    await expect(requireGobReadAccessOrRedirect()).rejects.toThrow(
      "NEXT_REDIRECT:/acceso-denegado?portal=gob",
    );
  });

  it("requireGobReadAccessOrRedirect bounces a DEACTIVATED national to /", async () => {
    mockGetUser.mockResolvedValue(userSession("user-national"));
    mockGetProfileCached.mockResolvedValue(nationalProfile({ deactivatedAt: new Date() }));
    await expect(requireGobReadAccessOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("requireGobReadAccessOrRedirect bounces a national on a PERSONAL account type to /", async () => {
    mockGetUser.mockResolvedValue(userSession("user-national"));
    mockGetProfileCached.mockResolvedValue(nationalProfile({ accountType: "personal" }));
    await expect(requireGobReadAccessOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("requireAdminOrGovtOrRedirect (the write-authority gate) REFUSES national", async () => {
    mockGetUser.mockResolvedValue(userSession("user-national"));
    mockGetProfileCached.mockResolvedValue(nationalProfile());
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(
      "NEXT_REDIRECT:/acceso-denegado?portal=gob",
    );
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("requireDecomisoPrincipal REFUSES national (a decomiso is an act of the State)", async () => {
    mockGetUser.mockResolvedValue(userSession("user-national"));
    mockGetProfileCached.mockResolvedValue(nationalProfile());
    await expect(requireDecomisoPrincipal()).rejects.toThrow(
      "NEXT_REDIRECT:/acceso-denegado?portal=gob",
    );
  });

  it("requireAdminOrRedirect (/admin) REFUSES national and bounces it to /", async () => {
    mockGetUser.mockResolvedValue(userSession("user-national"));
    mockGetProfileCached.mockResolvedValue(nationalProfile());
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});

describe("requireAdminOrGovtOrRedirect", () => {
  it("redirects to /iniciar-sesion when no session", async () => {
    mockGetUser.mockResolvedValue(noSession());
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/iniciar-sesion");
    expect(mockRedirect).toHaveBeenCalledWith("/iniciar-sesion");
  });

  // A4: a personal-role account hitting /gob lands on the explained access-denied
  // screen (not a silent bounce to /mis-mascotas) so it learns WHY it was moved.
  it("redirects to the explained access-denied screen when role is owner", async () => {
    mockGetUser.mockResolvedValue(userSession("user-owner"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-owner",
      role: "owner",
      displayName: "Owner User",
      accountType: "personal",
      deactivatedAt: null,
    });
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(
      "NEXT_REDIRECT:/acceso-denegado?portal=gob",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/acceso-denegado?portal=gob");
  });

  it("redirects to the explained access-denied screen when role is vet", async () => {
    mockGetUser.mockResolvedValue(userSession("user-vet"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-vet",
      role: "vet",
      displayName: "Vet User",
      accountType: "personal",
      deactivatedAt: null,
    });
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(
      "NEXT_REDIRECT:/acceso-denegado?portal=gob",
    );
  });

  it("redirects to the explained access-denied screen when profile is null", async () => {
    mockGetUser.mockResolvedValue(userSession("user-noprofile"));
    mockGetProfileCached.mockResolvedValue(null);
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow(
      "NEXT_REDIRECT:/acceso-denegado?portal=gob",
    );
  });

  it("passes for role=admin and returns empty jurisdictions", async () => {
    mockGetUser.mockResolvedValue(userSession("user-admin"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-admin",
      role: "admin",
      displayName: "Admin User",
      accountType: "institutional",
      deactivatedAt: null,
    });
    const result = await requireAdminOrGovtOrRedirect();
    expect(result.profile.role).toBe("admin");
    expect(result.jurisdictions).toEqual([]);
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("passes for role=govt and returns jurisdiction tuples", async () => {
    mockGetUser.mockResolvedValue(userSession("user-govt"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-govt",
      role: "govt",
      displayName: "Govt User",
      accountType: "institutional",
      deactivatedAt: null,
    });
    mockGetJurisdictionsCached.mockResolvedValue([
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
    const result = await requireAdminOrGovtOrRedirect();
    expect(result.profile.role).toBe("govt");
    expect(result.jurisdictions).toEqual([{ province: "Buenos Aires", locality: "La Plata" }]);
    expect(mockGetJurisdictionsCached).toHaveBeenCalledWith("user-govt");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Defense in depth (WS-AUTHZ 1.1): the consolidated institutional guard always
  // rejects non-institutional accounts, mirroring requireAdminOrRedirect. A
  // role=admin/govt row with accountType='personal' is a data inconsistency that
  // must not retain /gob access.
  it("redirects to / when role=admin but accountType is personal", async () => {
    mockGetUser.mockResolvedValue(userSession("user-personal-admin"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-personal-admin",
      role: "admin",
      displayName: "Personal Admin",
      accountType: "personal",
      deactivatedAt: null,
    });
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
    // Account-type rejection happens before the jurisdictions lookup.
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("redirects to / when role=govt but accountType is personal", async () => {
    mockGetUser.mockResolvedValue(userSession("user-personal-govt"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-personal-govt",
      role: "govt",
      displayName: "Personal Govt",
      accountType: "personal",
      deactivatedAt: null,
    });
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  // AC1: the shared /gob guard must reject deactivated authorities, mirroring
  // requireAdminOrRedirect. Before the fix a deactivated govt/admin kept full
  // read+write access to every /gob surface and server action.
  it("redirects to / when a govt is deactivated", async () => {
    mockGetUser.mockResolvedValue(userSession("user-govt-deactivated"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-govt-deactivated",
      role: "govt",
      displayName: "Deactivated Govt",
      accountType: "institutional",
      deactivatedAt: new Date("2026-01-01"),
    });
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
    // Deactivation is rejected BEFORE the jurisdictions lookup — no scope leak.
    expect(mockGetJurisdictionsCached).not.toHaveBeenCalled();
  });

  it("redirects to / when an admin is deactivated", async () => {
    mockGetUser.mockResolvedValue(userSession("user-admin-deactivated"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-admin-deactivated",
      role: "admin",
      displayName: "Deactivated Admin",
      accountType: "institutional",
      deactivatedAt: new Date("2026-01-01"),
    });
    await expect(requireAdminOrGovtOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});

// ---------------------------------------------------------------------------
// requireDecomisoPrincipal — reuses requireAdminOrGovtOrRedirect verbatim, so
// the AC1 deactivation gate must apply to decomiso authority too.
// ---------------------------------------------------------------------------

describe("requireDecomisoPrincipal", () => {
  it("passes for an active govt with jurisdictions", async () => {
    mockGetUser.mockResolvedValue(userSession("user-govt-active"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-govt-active",
      role: "govt",
      displayName: "Active Govt",
      accountType: "institutional",
      deactivatedAt: null,
    });
    mockGetJurisdictionsCached.mockResolvedValue([
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
    const result = await requireDecomisoPrincipal();
    expect(result.profile.role).toBe("govt");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects to / when the decomiso principal is deactivated (inherits AC1 gate)", async () => {
    mockGetUser.mockResolvedValue(userSession("user-decomiso-deactivated"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-decomiso-deactivated",
      role: "govt",
      displayName: "Deactivated Decomiso Principal",
      accountType: "institutional",
      deactivatedAt: new Date("2026-01-01"),
    });
    await expect(requireDecomisoPrincipal()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});

// ---------------------------------------------------------------------------
// requireAdminOrRedirect
// ---------------------------------------------------------------------------

describe("requireAdminOrRedirect", () => {
  it("redirects to /iniciar-sesion when no session", async () => {
    mockGetUser.mockResolvedValue(noSession());
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/iniciar-sesion");
  });

  it("redirects to / when profile is null", async () => {
    mockGetUser.mockResolvedValue(userSession("user-noprofile"));
    mockGetProfileCached.mockResolvedValue(null);
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("redirects to / when role is owner", async () => {
    mockGetUser.mockResolvedValue(userSession("user-owner"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-owner",
      role: "owner",
      displayName: "Owner",
      accountType: "personal",
      deactivatedAt: null,
    });
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("redirects to / when role is govt (not admin)", async () => {
    mockGetUser.mockResolvedValue(userSession("user-govt"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-govt",
      role: "govt",
      displayName: "Govt",
      accountType: "institutional",
      deactivatedAt: null,
    });
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("redirects to / when role=admin but accountType is personal (not institutional)", async () => {
    mockGetUser.mockResolvedValue(userSession("user-personal-admin"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-personal-admin",
      role: "admin",
      displayName: "Personal Admin",
      accountType: "personal",
      deactivatedAt: null,
    });
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("redirects to / when admin is deactivated", async () => {
    mockGetUser.mockResolvedValue(userSession("user-deactivated-admin"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-deactivated-admin",
      role: "admin",
      displayName: "Deactivated Admin",
      accountType: "institutional",
      deactivatedAt: new Date("2026-01-01"),
    });
    await expect(requireAdminOrRedirect()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("passes for an active institutional admin", async () => {
    mockGetUser.mockResolvedValue(userSession("user-admin-ok"));
    mockGetProfileCached.mockResolvedValue({
      id: "user-admin-ok",
      role: "admin",
      displayName: "Active Admin",
      accountType: "institutional",
      deactivatedAt: null,
    });
    const result = await requireAdminOrRedirect();
    expect(result.profile.id).toBe("user-admin-ok");
    expect(result.profile.role).toBe("admin");
    expect(result.profile.accountType).toBe("institutional");
    expect(result.profile.deactivatedAt).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requireOrgAccessByToken
// ---------------------------------------------------------------------------

describe("requireOrgAccessByToken", () => {
  const ORG_TOKEN = "ORG-GUARD-TEST-001";
  const ORG_ID = "org-guard-0000-0000-000000000001";
  const USER_ID = "user-org-00-0000-000000000001";

  const FAKE_ORG = {
    id: ORG_ID,
    publicToken: ORG_TOKEN,
    name: "Test Org",
    createdAt: new Date("2026-01-01"),
  };

  const FAKE_MEMBERSHIP = {
    id: "mem-guard-0000-0000-000000000001",
    userId: USER_ID,
    organizationId: ORG_ID,
    role: "admin",
    joinedAt: new Date("2026-01-02"),
  };

  it("redirects to /iniciar-sesion when no session", async () => {
    mockGetUser.mockResolvedValue(noSession());
    await expect(requireOrgAccessByToken(ORG_TOKEN)).rejects.toThrow(
      "NEXT_REDIRECT:/iniciar-sesion",
    );
  });

  it("calls notFound() when the org does not exist or user has no membership", async () => {
    mockGetUser.mockResolvedValue(userSession(USER_ID));
    mockGetOrgMembershipCached.mockResolvedValue(null);
    await expect(requireOrgAccessByToken(ORG_TOKEN)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("does not leak whether the org exists vs the user lacking membership (notFound either way)", async () => {
    // Decision D4: no information leakage — both cases produce notFound().
    mockGetUser.mockResolvedValue(userSession("user-other"));
    mockGetOrgMembershipCached.mockResolvedValue(null);
    await expect(requireOrgAccessByToken(ORG_TOKEN)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("passes and returns org + membership when membership row exists", async () => {
    mockGetUser.mockResolvedValue(userSession(USER_ID));
    mockGetOrgMembershipCached.mockResolvedValue({
      organization: FAKE_ORG,
      membership: FAKE_MEMBERSHIP,
    });
    const result = await requireOrgAccessByToken(ORG_TOKEN);
    expect(result.user.id).toBe(USER_ID);
    expect(result.organization.id).toBe(ORG_ID);
    expect(result.membership.role).toBe("admin");
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("passes orgToken and userId to getOrgMembershipCached", async () => {
    mockGetUser.mockResolvedValue(userSession(USER_ID));
    mockGetOrgMembershipCached.mockResolvedValue({
      organization: FAKE_ORG,
      membership: FAKE_MEMBERSHIP,
    });
    await requireOrgAccessByToken(ORG_TOKEN);
    expect(mockGetOrgMembershipCached).toHaveBeenCalledWith(ORG_TOKEN, USER_ID);
  });
});
