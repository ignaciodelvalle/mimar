// Integration tests for V0-5 org verification admin actions.
//
// Tests: verifyOrgForAuthority + unverifyOrgForAuthority inner writers,
//        plus verifyOrgAction public wrapper gate.
//
// Pattern mirrors admin-revocations.test.ts:
//   - beforeAll seeds ephemeral users via Supabase admin SDK
//   - afterAll deletes them with app.allow_audit_mutation GUC
//   - Each test calls the inner *ForAuthority writer directly (no Next.js runtime)
//   - Wrapper gate test (verifyOrgAction) asserts NEXT_REDIRECT for non-admin

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyOrgAction } from "@/app/actions/admin-org-verification";
import {
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { unverifyOrgForAuthority } from "@/src/modules/organizations/application/admin-org-verification/unverify-org";
import { verifyOrgForAuthority } from "@/src/modules/organizations/application/admin-org-verification/verify-org";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ADMIN_EMAIL = "v05-verify-admin@dim-test.local";
const OWNER_EMAIL = "v05-verify-owner@dim-test.local";
// Admin with role=admin but accountType=personal (should be CAPABILITY_DENIED — fix #2).
const PERSONAL_ADMIN_EMAIL = "v05-verify-personal-admin@dim-test.local";
const PASS = "V05_Verify_2026!";

let adminUserId: string;
let ownerUserId: string;
let personalAdminUserId: string;

// ---------------------------------------------------------------------------
// Teardown helper
// ---------------------------------------------------------------------------

async function deleteTestUser(email: string) {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);

  const displayName = email.split("@")[0];
  const orphansByName = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const orphansByAuthId = found
    ? await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, found.id))
    : [];

  const allIds = new Set([...orphansByName.map((p) => p.id), ...orphansByAuthId.map((p) => p.id)]);

  for (const uid of allIds) {
    // Find orgs created/admin'd by this user
    const adminOrgRows = await db
      .select({ orgId: organizationMemberships.organizationId })
      .from(organizationMemberships)
      .where(
        and(eq(organizationMemberships.userId, uid), eq(organizationMemberships.role, "admin")),
      );

    for (const { orgId } of adminOrgRows) {
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(eq(auditLog.targetOrganizationId, orgId));
      });
      await db.delete(notifications).where(eq(notifications.userId, uid));
      await db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }

    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
    });
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await adminSdk.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

// Seed a bare organizations row without going through createOrganizationForUser
// (avoids DNI prereq + approval request machinery).
async function seedOrg(creatorUserId: string, opts: { verified?: boolean } = {}): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `V05-TEST-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      displayName: "V05 Test Org",
      legalName: "V05 Test Org S.A.",
      orgType: "shelter",
      email: "v05-org@dim-test.local",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      verified: opts.verified ?? false,
      verifiedAt: opts.verified ? new Date() : null,
      createdByUserId: creatorUserId,
    })
    .returning({ id: organizations.id });

  await db.insert(organizationMemberships).values({
    organizationId: org.id,
    userId: creatorUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  return org.id;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const email of [ADMIN_EMAIL, OWNER_EMAIL, PERSONAL_ADMIN_EMAIL]) {
    await deleteTestUser(email);
  }

  adminUserId = await createUserOrThrow(ADMIN_EMAIL);
  ownerUserId = await createUserOrThrow(OWNER_EMAIL);
  personalAdminUserId = await createUserOrThrow(PERSONAL_ADMIN_EMAIL);

  // Set admin role (institutional)
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));

  // admin role but personal accountType — must be rejected by inner writers (fix #2)
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "personal" })
    .where(eq(profiles.id, personalAdminUserId));
});

afterAll(async () => {
  for (const email of [ADMIN_EMAIL, OWNER_EMAIL, PERSONAL_ADMIN_EMAIL]) {
    await deleteTestUser(email);
  }
});

// ---------------------------------------------------------------------------
// verifyOrgForAuthority
// ---------------------------------------------------------------------------

describe("verifyOrgForAuthority", () => {
  it("admin verifies a pending org — sets verified=true + verifiedAt + verifiedByUserId", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: false });

    const result = await verifyOrgForAuthority(adminUserId, { organizationId: orgId });
    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select({
        verified: organizations.verified,
        verifiedAt: organizations.verifiedAt,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    expect(row.verified).toBe(true);
    expect(row.verifiedAt).not.toBeNull();
    expect(row.verifiedByUserId).toBe(adminUserId);
  });

  // H3 (top-10 review 2026-08-22) — THE MIRROR THE FINDING MISSED.
  //
  // The finding named the three approval-decision writers. This route never
  // touches an approval_request: it flips `verified` straight from the admin
  // console. An admin who founds an organization (creating one needs no role —
  // any live user with a declared DNI can) could therefore verify it here even
  // with the decision writers fixed, reaching the same outcome by a different
  // door. `organizations.verified` gates receiving decomisos, being a rehome
  // destination, and the public directory.
  it("refuses to verify an organization the actor themselves created", async () => {
    const orgId = await seedOrg(adminUserId, { verified: false });

    const result = await verifyOrgForAuthority(adminUserId, { organizationId: orgId });
    expect("error" in result && result.error).toMatch(/creaste vos|otra persona/i);

    // Not just a message — the flag must be untouched.
    const [row] = await db
      .select({
        verified: organizations.verified,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(row.verified).toBe(false);
    expect(row.verifiedByUserId).toBeNull();
  });

  it("admin verify writes an audit_log row with action=org_verified + actor + payload", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: false });

    await verifyOrgForAuthority(adminUserId, { organizationId: orgId });

    const [log] = await db
      .select({
        action: auditLog.action,
        actorUserId: auditLog.actorUserId,
        targetOrganizationId: auditLog.targetOrganizationId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(and(eq(auditLog.action, "org_verified"), eq(auditLog.targetOrganizationId, orgId)))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(log).toBeDefined();
    expect(log.action).toBe("org_verified");
    expect(log.actorUserId).toBe(adminUserId);
    expect(log.targetOrganizationId).toBe(orgId);
    expect((log.payload as { org_id?: string }).org_id).toBe(orgId);
  });

  it("admin verify notifies org admin members", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: false });

    await verifyOrgForAuthority(adminUserId, { organizationId: orgId });

    const [notif] = await db
      .select({ notificationType: notifications.notificationType, userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "org_verification_granted"),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);

    expect(notif).toBeDefined();
    expect(notif.userId).toBe(ownerUserId);
    expect(notif.notificationType).toBe("org_verification_granted");
  });

  it("non-admin (owner) is rejected with CAPABILITY_DENIED", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: false });

    const result = await verifyOrgForAuthority(ownerUserId, { organizationId: orgId });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("CAPABILITY_DENIED");

    // DB unchanged
    const [row] = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(row.verified).toBe(false);
  });

  it("admin with personal accountType (non-institutional) is rejected — fix #2 defense-in-depth", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: false });

    const result = await verifyOrgForAuthority(personalAdminUserId, { organizationId: orgId });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("CAPABILITY_DENIED");

    // DB unchanged
    const [row] = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(row.verified).toBe(false);
  });

  it("re-verifying an already-verified org is idempotent — returns noOp:true", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: true });

    const result = await verifyOrgForAuthority(adminUserId, { organizationId: orgId });
    expect(result).toEqual({ ok: true, noOp: true });
  });

  it("returns error for unknown org", async () => {
    const result = await verifyOrgForAuthority(adminUserId, {
      organizationId: "00000000-0000-0000-0000-000000000000",
    });
    expect("error" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unverifyOrgForAuthority
// ---------------------------------------------------------------------------

describe("unverifyOrgForAuthority", () => {
  it("admin un-verifies a verified org — sets verified=false, preserves verifiedAt/verifiedByUserId", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: true });

    // Capture existing verifiedAt before the unverify
    const [before] = await db
      .select({
        verifiedAt: organizations.verifiedAt,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const result = await unverifyOrgForAuthority(adminUserId, { organizationId: orgId });
    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select({
        verified: organizations.verified,
        verifiedAt: organizations.verifiedAt,
        verifiedByUserId: organizations.verifiedByUserId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    expect(row.verified).toBe(false);
    // Historical record preserved
    expect(row.verifiedAt).toEqual(before.verifiedAt);
    expect(row.verifiedByUserId).toEqual(before.verifiedByUserId);
  });

  it("unverify writes an audit_log row with action=org_unverified", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: true });

    await unverifyOrgForAuthority(adminUserId, {
      organizationId: orgId,
      reason: "Documentación vencida",
    });

    const [log] = await db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.action, "org_unverified"), eq(auditLog.targetOrganizationId, orgId)))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(log).toBeDefined();
    expect(log.action).toBe("org_unverified");
    expect((log.payload as { reason?: string }).reason).toBe("Documentación vencida");
  });

  it("unverify with reason notifies org admin members", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: true });
    const reason = "Documentación incompleta";

    await unverifyOrgForAuthority(adminUserId, { organizationId: orgId, reason });

    const [notif] = await db
      .select({ notificationType: notifications.notificationType, body: notifications.body })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "org_verification_revoked"),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);

    expect(notif).toBeDefined();
    expect(notif.body).toContain(reason);
  });

  it("non-admin (owner) is rejected with CAPABILITY_DENIED", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: true });

    const result = await unverifyOrgForAuthority(ownerUserId, { organizationId: orgId });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("CAPABILITY_DENIED");

    // DB unchanged
    const [row] = await db
      .select({ verified: organizations.verified })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    expect(row.verified).toBe(true);
  });

  it("un-verifying an already-unverified org is idempotent — returns noOp:true", async () => {
    const orgId = await seedOrg(ownerUserId, { verified: false });

    const result = await unverifyOrgForAuthority(adminUserId, { organizationId: orgId });
    expect(result).toEqual({ ok: true, noOp: true });
  });
});

// ---------------------------------------------------------------------------
// verifyOrgAction — public wrapper gate
//
// The wrapper calls requireAdminOrRedirect which throws a NEXT_REDIRECT error
// when called without a valid admin session. In the test environment there is
// no Supabase session → getUser() returns null → redirect("/login") is thrown.
// We assert the throw to cover the wrapper's auth gate.
// ---------------------------------------------------------------------------

describe("verifyOrgAction — wrapper gate", () => {
  it("calling the wrapper without a valid session throws (NEXT_REDIRECT) — gate is exercised", async () => {
    // No active Supabase session in the test environment → requireAdminOrRedirect
    // calls redirect("/login") which Next.js throws as a special NEXT_REDIRECT error.
    await expect(
      verifyOrgAction({ organizationId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow();
  });

  it("exposes NO network-addressable un-verify — that act needs a motivo", async () => {
    // Removed 2026-08-17. `unverifyOrgAction` wrapped a use case whose `reason`
    // is OPTIONAL, so an omitted reason wrote an audit_log payload with no
    // `reason` key. It had no UI — UnverifyOrgButton was deleted as dead code —
    // but every export of a "use server" file is an independently addressable
    // endpoint, so "no UI" was never "unreachable": any admin session could
    // strip an organization's verification and leave a record answering WHO and
    // WHEN but not WHY, while `revokeOrgVerificationForAuthority` demands a
    // 30-character motivo plus evidence for the identical act.
    //
    // Asserted on the MODULE, not by reading the source: re-adding the export
    // is what must fail, whatever it gets named or however it is formatted.
    const actions = await import("@/app/actions/admin-org-verification");
    expect(Object.keys(actions)).not.toContain("unverifyOrgAction");
    // Non-vacuity: the module really did load and really does export actions.
    expect(Object.keys(actions)).toContain("verifyOrgAction");
  });
});
