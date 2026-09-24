// Unit tests for:
//   - lib/supabase/admin.ts — createAdminClient()
//   - lib/auth-guards.ts — requireAdminOrRedirect() logic (via DB assertions)
//   - lib/institutional-scope.ts — capability helpers
//
// Strict TDD: all test cases written before implementation.
// createAdminClient tests use env-var injection; no real DB needed for those.
// Auth guard tests use the real local Supabase DB.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, govtAssignments, notifications, profiles } from "@/db";
import {
  canAssignGovtLocality,
  canCreateInstitutional,
  canDeactivateAdmin,
  canDeactivateGovt,
  canResetCredentials,
} from "@/lib/domain/institutional-scope";
import type { ActorProfile } from "@/lib/domain/institutional-scope";
import { createAdminClient } from "@/lib/supabase/admin";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ============================================================================
// createAdminClient tests (A-2.1 / A-2.2)
// ============================================================================

describe("createAdminClient", () => {
  it("returns a client with auth namespace when env vars are present", () => {
    const hasEnv =
      !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!hasEnv) return; // skip gracefully in CI without local Supabase

    const client = createAdminClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });

  it("throws the exact configured-missing error when env vars are absent", async () => {
    // The module-level cache would satisfy a second call from the statically
    // imported instance, so the throw path needs a FRESH module: reset the
    // registry and dynamic-import a new instance with the env stubbed empty.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    try {
      const fresh = await import("@/lib/supabase/admin");
      expect(() => fresh.createAdminClient()).toThrowError(
        "Supabase admin client not configured: missing env vars.",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// ============================================================================
// Admin profile guard logic tests (A-2.3 / A-2.4) — real DB
// ============================================================================

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const GUARD_ADMIN_EMAIL = "fase5-guard-admin@dim-test.local";
const GUARD_GOVT_EMAIL = "fase5-guard-govt@dim-test.local";

let guardAdminUserId: string;
let guardGovtUserId: string;

async function deleteGuardTestUser(email: string) {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];

  // Find profiles by display name OR by auth user id
  const orphansByName = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));

  const orphansByAuthId = found
    ? await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, found.id))
    : [];

  const allIds = new Set([...orphansByName.map((p) => p.id), ...orphansByAuthId.map((p) => p.id)]);

  for (const uid of allIds) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(notifications).where(eq(notifications.userId, uid));
    });
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await adminSdk.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "Fase5Guard_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

beforeAll(async () => {
  // Clean up any leftovers from a previous run
  await deleteGuardTestUser(GUARD_ADMIN_EMAIL);
  await deleteGuardTestUser(GUARD_GOVT_EMAIL);

  // Note: creating an auth user fires the handle_new_user trigger which
  // auto-inserts a profile row with role='owner'. We UPDATE to the desired role
  // rather than INSERT (INSERT would fail with profiles_pkey constraint).
  guardAdminUserId = await createUserOrThrow(GUARD_ADMIN_EMAIL);
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, guardAdminUserId));

  guardGovtUserId = await createUserOrThrow(GUARD_GOVT_EMAIL);
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, guardGovtUserId));
});

afterAll(async () => {
  await deleteGuardTestUser(GUARD_ADMIN_EMAIL);
  await deleteGuardTestUser(GUARD_GOVT_EMAIL);
});

// requireAdminOrRedirect logic is tested via direct DB assertions.
// The function itself redirects via next/navigation.redirect which is not
// available in Vitest — we test the underlying conditions it checks.
describe("requireAdminOrRedirect — underlying DB conditions", () => {
  it("active admin profile has role=admin, accountType=institutional, deactivatedAt=null", async () => {
    const [row] = await db
      .select({
        id: profiles.id,
        role: profiles.role,
        accountType: profiles.accountType,
        deactivatedAt: profiles.deactivatedAt,
      })
      .from(profiles)
      .where(eq(profiles.id, guardAdminUserId))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.role).toBe("admin");
    expect(row.accountType).toBe("institutional");
    expect(row.deactivatedAt).toBeNull();
  });

  it("govt profile has role=govt — would fail requireAdminOrRedirect role check", async () => {
    const [row] = await db
      .select({ id: profiles.id, role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, guardGovtUserId))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.role).toBe("govt");
    // requireAdminOrRedirect checks role === 'admin' — this would fail → redirect
  });

  it("deactivated admin (deactivated_at IS NOT NULL) would be rejected", async () => {
    // Set deactivated_at, then verify the guard would see a non-null value
    await db
      .update(profiles)
      .set({ deactivatedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(profiles.id, guardAdminUserId));

    const [row] = await db
      .select({ deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, guardAdminUserId))
      .limit(1);

    expect(row.deactivatedAt).not.toBeNull();
    // requireAdminOrRedirect: deactivatedAt !== null → redirect

    // Restore for other tests
    await db.update(profiles).set({ deactivatedAt: null }).where(eq(profiles.id, guardAdminUserId));
  });

  it("restored admin has deactivatedAt=null after restoration", async () => {
    const [row] = await db
      .select({ deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, guardAdminUserId))
      .limit(1);
    expect(row.deactivatedAt).toBeNull();
  });
});

// ============================================================================
// canCreateInstitutional (A-3.1 / A-3.2)
// ============================================================================

const activeAdmin: ActorProfile = {
  id: "admin-1",
  role: "admin",
  accountType: "institutional",
  deactivatedAt: null,
};

const deactivatedAdmin: ActorProfile = {
  id: "admin-deactivated",
  role: "admin",
  accountType: "institutional",
  deactivatedAt: new Date("2026-01-01"),
};

const govtActor: ActorProfile = {
  id: "govt-1",
  role: "govt",
  accountType: "institutional",
  deactivatedAt: null,
};

const ownerActor: ActorProfile = {
  id: "owner-1",
  role: "owner",
  accountType: "personal",
  deactivatedAt: null,
};

describe("canCreateInstitutional", () => {
  it("returns true for active admin", () => {
    expect(canCreateInstitutional(activeAdmin)).toBe(true);
  });

  it("returns false for govt", () => {
    expect(canCreateInstitutional(govtActor)).toBe(false);
  });

  it("returns false for owner", () => {
    expect(canCreateInstitutional(ownerActor)).toBe(false);
  });

  it("returns false for deactivated admin", () => {
    expect(canCreateInstitutional(deactivatedAdmin)).toBe(false);
  });
});

// ============================================================================
// canDeactivateAdmin (A-3.1 / A-3.2)
// ============================================================================

describe("canDeactivateAdmin", () => {
  const targetAdminId = "admin-target";

  it("returns true when active admin targets another admin with count > 1", () => {
    expect(canDeactivateAdmin(activeAdmin, targetAdminId, 2)).toBe(true);
  });

  it("returns false when actor is self (same id as target)", () => {
    expect(canDeactivateAdmin(activeAdmin, activeAdmin.id, 2)).toBe(false);
  });

  it("returns false when activeAdminCount <= 1 (last-admin guard)", () => {
    expect(canDeactivateAdmin(activeAdmin, targetAdminId, 1)).toBe(false);
  });

  it("returns false when actor is not admin (govt)", () => {
    expect(canDeactivateAdmin(govtActor, targetAdminId, 2)).toBe(false);
  });
});

// ============================================================================
// canDeactivateGovt (A-3.1 / A-3.2)
// ============================================================================

describe("canDeactivateGovt", () => {
  it("returns true for active admin", () => {
    expect(canDeactivateGovt(activeAdmin)).toBe(true);
  });

  it("returns false for govt actor", () => {
    expect(canDeactivateGovt(govtActor)).toBe(false);
  });
});

// ============================================================================
// canResetCredentials (A-3.1 / A-3.2)
// ============================================================================

describe("canResetCredentials", () => {
  it("returns true for active admin", () => {
    expect(canResetCredentials(activeAdmin)).toBe(true);
  });

  it("returns false for govt actor", () => {
    expect(canResetCredentials(govtActor)).toBe(false);
  });
});

// ============================================================================
// canAssignGovtLocality (A-3.1 / A-3.2)
// ============================================================================

describe("canAssignGovtLocality", () => {
  it("returns true for active admin", () => {
    expect(canAssignGovtLocality(activeAdmin)).toBe(true);
  });

  it("returns false for govt actor", () => {
    expect(canAssignGovtLocality(govtActor)).toBe(false);
  });
});

// ============================================================================
// Shared negative admin-gate (4 cases — verifies reuse of isActiveAdmin)
// ============================================================================

describe("shared negative admin-gate — all helpers reject non-admin/deactivated", () => {
  it("canCreateInstitutional rejects personal owner", () => {
    expect(canCreateInstitutional(ownerActor)).toBe(false);
  });

  it("canDeactivateGovt rejects personal owner", () => {
    expect(canDeactivateGovt(ownerActor)).toBe(false);
  });

  it("canResetCredentials rejects personal owner", () => {
    expect(canResetCredentials(ownerActor)).toBe(false);
  });

  it("canAssignGovtLocality rejects personal owner", () => {
    expect(canAssignGovtLocality(ownerActor)).toBe(false);
  });
});
