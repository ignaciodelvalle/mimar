// Integration test: handle_new_user() NEVER derives the role from request
// metadata (CRITICAL-1 — self-minted admin, migrations 0133 → 0134).
//
// The original vulnerability: the signup trigger set profiles.role from
//   new.raw_user_meta_data->>'user_role'
// but raw_user_meta_data IS user_metadata — client-writable via the public anon
// key (supabase.auth.signUp({ options: { data: { user_role: 'admin' } } })). Any
// anonymous caller could self-mint an admin.
//
// 0133 moved the read to raw_app_meta_data (service-role-only). That closed the
// hole, but the app_metadata read is a DEAD path: GoTrue's admin.createUser does
// INSERT-then-UPDATE, so the trigger fires BEFORE the caller's custom
// app_metadata is merged — raw_app_meta_data->>'user_role' is always NULL at
// trigger time. Every account resolved to 'owner' regardless.
//
// 0134 makes this honest and unconditional: the trigger ALWAYS writes 'owner'
// and reads NO metadata for the role. Privileged roles are granted EXCLUSIVELY
// by an explicit service-role UPDATE after the auth user exists (this is exactly
// what bootstrapAdmin() and seed-genesis-admin.ts do).
//
// This test hits the local Supabase stack (same pattern as
// __tests__/account-type-role-invariant.test.ts):
//   1. user_metadata.user_role='admin' → trigger IGNORES it → role='owner'
//   2. app_metadata.user_role='admin'  → trigger IGNORES it → role='owner'
//      (honest: app_metadata is NOT an elevation channel at signup)
//   3. plain signup                    → role='owner'
//   4. explicit service-role UPDATE    → role='admin' (the ONLY elevation path)

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachments, auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAILS = {
  userMetaAdmin: "trigger-usermeta-admin@dim-test.local",
  appMetaAdmin: "trigger-appmeta-admin@dim-test.local",
  plainSignup: "trigger-plain-signup@dim-test.local",
  elevated: "trigger-elevated-admin@dim-test.local",
} as const;

const PASSWORD = "TriggerRoleTest_2026!";

async function deleteTestUser(email: string): Promise<void> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;

  const uid = found.id;
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
    await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
  });
  await db.delete(attachments).where(eq(attachments.uploadedByUserId, uid));
  await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
  await db.delete(notifications).where(eq(notifications.userId, uid));
  await db.delete(profiles).where(eq(profiles.id, uid));
  await adminSdk.auth.admin.deleteUser(uid);
}

async function readRole(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row?.role ?? null;
}

beforeAll(async () => {
  await Promise.all(Object.values(EMAILS).map(deleteTestUser));
}, 30_000);

afterAll(async () => {
  await Promise.all(Object.values(EMAILS).map(deleteTestUser));
}, 30_000);

describe("handle_new_user never trusts request metadata for the role", () => {
  it("IGNORES user_metadata.user_role='admin' → defaults to role='owner'", async () => {
    const { data, error } = await createFreshTestUser(adminSdk, {
      email: EMAILS.userMetaAdmin,
      password: PASSWORD,
      email_confirm: true,
      // The attack surface: an anon signup lands its options.data HERE.
      user_metadata: { display_name: "Attacker", user_role: "admin" },
    });
    expect(error).toBeNull();
    expect(data.user).toBeTruthy();
    const role = await readRole(data.user!.id);
    expect(role).toBe("owner");
  }, 20_000);

  it("IGNORES app_metadata.user_role='admin' → defaults to role='owner'", async () => {
    // app_metadata is service-role-only, but it is STILL not an elevation
    // channel at signup: GoTrue merges custom app_metadata AFTER the trigger has
    // already inserted the profile. The honest contract is 'owner' here.
    const { data, error } = await createFreshTestUser(adminSdk, {
      email: EMAILS.appMetaAdmin,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Founder" },
      app_metadata: { user_role: "admin" },
    });
    expect(error).toBeNull();
    expect(data.user).toBeTruthy();
    const role = await readRole(data.user!.id);
    expect(role).toBe("owner");
  }, 20_000);

  it("a plain signup (no role metadata) → role='owner'", async () => {
    const { data, error } = await createFreshTestUser(adminSdk, {
      email: EMAILS.plainSignup,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Citizen" },
    });
    expect(error).toBeNull();
    const role = await readRole(data.user!.id);
    expect(role).toBe("owner");
  }, 20_000);

  it("elevates ONLY via an explicit service-role UPDATE (the genesis/bootstrap path)", async () => {
    const { data, error } = await createFreshTestUser(adminSdk, {
      email: EMAILS.elevated,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Genesis Admin" },
    });
    expect(error).toBeNull();
    const uid = data.user!.id;
    // Trigger created it as an owner.
    expect(await readRole(uid)).toBe("owner");

    // Exactly what bootstrapAdmin() and seed-genesis-admin.ts do: an explicit
    // service-role UPDATE. This is the ONLY sanctioned elevation mechanism.
    await db
      .update(profiles)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(profiles.id, uid));

    expect(await readRole(uid)).toBe("admin");
  }, 20_000);
});
