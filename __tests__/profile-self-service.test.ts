// Integration tests for Slice 3d: vetSelfResignAction + govtSelfDeactivateAction
// (self-service role transitions from /cuenta/renunciar and /cuenta/desactivar).
//
// Pattern mirrors approval-request-withdraw.test.ts:
//   - beforeAll seeds ephemeral users via supabase admin SDK
//   - afterAll deletes them with app.allow_audit_mutation GUC
//   - Tests call inner writers directly (no Next.js runtime)

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { govtSelfDeactivateForUser } from "@/src/modules/pets/application/profile/govt-self-deactivate";
import { selfDeactivatePersonalAccountForUser } from "@/src/modules/pets/application/profile/self-deactivate-personal-account";
import { selfReactivatePersonalAccountForUser } from "@/src/modules/pets/application/profile/self-reactivate-personal-account";
import { vetSelfResignForUser } from "@/src/modules/pets/application/profile/vet-self-resign";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Email / ID holders
// ---------------------------------------------------------------------------

const VET_EMAIL = "self-service-vet@dim-test.local";
const OWNER_EMAIL = "self-service-owner@dim-test.local";
const GOVT_EMAIL = "self-service-govt@dim-test.local";
const GOVT2_EMAIL = "self-service-govt2@dim-test.local";
const ADMIN_EMAIL = "self-service-admin@dim-test.local";
// A DEDICATED personal account for the deactivate → reactivate round trip, and
// dedicated on purpose: OWNER_EMAIL is the "already owner / wrong role" negative
// fixture for two earlier describes, and leaving it deactivated behind them
// would make this file's result depend on describe ordering.
const PERSONAL_DEACT_EMAIL = "self-service-personal-deact@dim-test.local";

let vetUserId: string;
let ownerUserId: string;
let govtUserId: string;
let govt2UserId: string;
let adminUserId: string;
let personalDeactUserId: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function deleteTestUser(email: string) {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;

  const uid = found.id;

  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
    await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
  });
  await db.delete(notifications).where(eq(notifications.userId, uid));
  await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
  await db.delete(profiles).where(eq(profiles.id, uid));
  await adminSdk.auth.admin.deleteUser(uid);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "SelfService3d_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any leftover state from a previous interrupted run
  for (const email of [
    VET_EMAIL,
    OWNER_EMAIL,
    GOVT_EMAIL,
    GOVT2_EMAIL,
    ADMIN_EMAIL,
    PERSONAL_DEACT_EMAIL,
  ]) {
    await deleteTestUser(email);
  }

  vetUserId = await createUserOrThrow(VET_EMAIL);
  ownerUserId = await createUserOrThrow(OWNER_EMAIL);
  govtUserId = await createUserOrThrow(GOVT_EMAIL);
  govt2UserId = await createUserOrThrow(GOVT2_EMAIL);
  adminUserId = await createUserOrThrow(ADMIN_EMAIL);
  personalDeactUserId = await createUserOrThrow(PERSONAL_DEACT_EMAIL);

  // Elevate roles as needed (handle_new_user trigger creates role='owner')
  await db
    .update(profiles)
    .set({
      role: "vet",
      matriculaNumber: "MN-12345",
      matriculaJurisdiccion: "CABA",
      matriculaVerified: true,
    })
    .where(eq(profiles.id, vetUserId));

  // ownerUserId stays as role='owner'

  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, govtUserId));

  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, govt2UserId));

  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));

  // Assign localities for govtUserId. TWO constraints, both real:
  //
  //   1. They must not collide with seed data — scripts/seed-test-users.ts
  //      assigns the shared `govt-local@dim.test` user to La Plata, Morón,
  //      Quilmes and Tigre, and a collision would make the coverage maths
  //      below depend on seed state.
  //   2. They must RESOLVE against ar_localities. This is what the invented
  //      test-scoped names used to violate: while this file was mid-flight
  //      its fixture rows sat ACTIVE in the shared local database carrying a
  //      locality no catalog could resolve, and
  //      govt-assignments-locality-integrity — which scans the WHOLE table,
  //      from a different vitest worker — failed on them. Intermittently,
  //      depending on which worker won the race, and persistently whenever a
  //      crashed worker skipped the afterAll cleanup and left the rows behind
  //      (blind-QA gate run, 2026-08-19). A suite that flips red on worker
  //      scheduling teaches the team to ignore it.
  //
  // Chivilcoy and Bragado are real Buenos Aires localities that no seed
  // script assigns to anyone, so both constraints hold at full strength.
  //   - Chivilcoy — also covered by govt2UserId (coverage check should PASS)
  //   - Bragado   — only covered by govtUserId (coverage check should BLOCK)
  await db.insert(govtAssignments).values([
    {
      userId: govtUserId,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Chivilcoy",
      grantedByUserId: adminUserId,
    },
    {
      userId: govtUserId,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Bragado",
      grantedByUserId: adminUserId,
    },
  ]);

  // govt2UserId covers Chivilcoy — so govtUserId leaving it is safe
  await db.insert(govtAssignments).values({
    userId: govt2UserId,
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Chivilcoy",
    grantedByUserId: adminUserId,
  });
});

afterAll(async () => {
  for (const email of [
    VET_EMAIL,
    OWNER_EMAIL,
    GOVT_EMAIL,
    GOVT2_EMAIL,
    ADMIN_EMAIL,
    PERSONAL_DEACT_EMAIL,
  ]) {
    await deleteTestUser(email);
  }
});

// ============================================================================
// vetSelfResignForUser
// ============================================================================

describe("vetSelfResignForUser — idempotency: already owner", () => {
  it("returns noOp when caller is already role=owner", async () => {
    const result = await vetSelfResignForUser(ownerUserId);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);
    expect(result.noOp).toBe(true);
  });
});

describe("vetSelfResignForUser — capability rejection: wrong role", () => {
  it("rejects when role is govt", async () => {
    const result = await vetSelfResignForUser(govtUserId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/ROLE_MISMATCH/);
  });

  it("rejects when role is admin", async () => {
    const result = await vetSelfResignForUser(adminUserId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/ROLE_MISMATCH/);
  });
});

describe("vetSelfResignForUser — happy path", () => {
  it("demotes vet to owner, clears matriculaVerified, preserves matricula number, emits audit + notification", async () => {
    // Pre-state: role=vet, matriculaVerified=true, matriculaNumber set
    const [before] = await db
      .select({
        role: profiles.role,
        matriculaVerified: profiles.matriculaVerified,
        matriculaNumber: profiles.matriculaNumber,
        matriculaJurisdiccion: profiles.matriculaJurisdiccion,
      })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);

    expect(before.role).toBe("vet");
    expect(before.matriculaVerified).toBe(true);
    expect(before.matriculaNumber).toBe("MN-12345");

    const result = await vetSelfResignForUser(vetUserId, { reason: "Cambio de carrera" });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);
    expect(result.noOp).toBeUndefined();

    // Profile updated
    const [after] = await db
      .select({
        role: profiles.role,
        matriculaVerified: profiles.matriculaVerified,
        matriculaNumber: profiles.matriculaNumber,
        matriculaJurisdiccion: profiles.matriculaJurisdiccion,
      })
      .from(profiles)
      .where(eq(profiles.id, vetUserId))
      .limit(1);

    expect(after.role).toBe("owner");
    expect(after.matriculaVerified).toBe(false);
    // matriculaNumber and jurisdiccion preserved
    expect(after.matriculaNumber).toBe("MN-12345");
    expect(after.matriculaJurisdiccion).toBe("CABA");

    // Audit log written
    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, vetUserId), eq(auditLog.action, "self_resignation_vet")))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(logRow).toBeDefined();
    const payload = logRow.payload as Record<string, unknown>;
    expect(payload.reason).toBe("Cambio de carrera");

    // Notification to self
    const [notifRow] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, vetUserId),
          eq(notifications.notificationType, "self_resignation_confirmed"),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);

    expect(notifRow).toBeDefined();
    expect(notifRow.severity).toBe("info");
  });

  it("returns noOp on second call (already owner after first call)", async () => {
    // vetUserId was demoted in the test above — calling again should noOp
    const result = await vetSelfResignForUser(vetUserId);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);
    expect(result.noOp).toBe(true);
  });
});

// ============================================================================
// govtSelfDeactivateForUser
// ============================================================================

describe("govtSelfDeactivateForUser — capability rejection: wrong role", () => {
  it("rejects when role is admin (admin has a different deactivation flow per §7.6)", async () => {
    const result = await govtSelfDeactivateForUser(adminUserId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/ROLE_MISMATCH/);
  });

  it("rejects when role is owner (personal account)", async () => {
    const result = await govtSelfDeactivateForUser(ownerUserId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/ROLE_MISMATCH/);
  });
});

describe("govtSelfDeactivateForUser — coverage block", () => {
  it("blocks deactivation when a locality would be left uncovered", async () => {
    // govtUserId covers Bragado alone — deactivation should be blocked
    const result = await govtSelfDeactivateForUser(govtUserId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/LOCALITY_WOULD_BE_UNCOVERED/);

    // Verify no state change
    const [row] = await db
      .select({ deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, govtUserId))
      .limit(1);
    expect(row.deactivatedAt).toBeNull();

    // Assignments still active
    const activeAssignments = await db
      .select({ id: govtAssignments.id })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, govtUserId), isNull(govtAssignments.revokedAt)));
    expect(activeAssignments.length).toBe(2);
  });
});

describe("govtSelfDeactivateForUser — happy path", () => {
  it("deactivates govt when all localities have coverage, revokes assignments, emits audit + notifications", async () => {
    // Add coverage for Bragado by govt2UserId so govtUserId can now safely deactivate
    await db.insert(govtAssignments).values({
      userId: govt2UserId,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Bragado",
      grantedByUserId: adminUserId,
    });

    const result = await govtSelfDeactivateForUser(govtUserId, { reason: "Me retiro del sistema" });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);
    expect(result.noOp).toBeUndefined();

    // deactivated_at stamped
    const [after] = await db
      .select({ deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, govtUserId))
      .limit(1);
    expect(after.deactivatedAt).not.toBeNull();

    // All assignments revoked
    const stillActive = await db
      .select({ id: govtAssignments.id })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, govtUserId), isNull(govtAssignments.revokedAt)));
    expect(stillActive.length).toBe(0);

    // Audit log written
    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorUserId, govtUserId), eq(auditLog.action, "govt_self_deactivated")),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(logRow).toBeDefined();
    const payload = logRow.payload as Record<string, unknown>;
    expect(payload.assignments_revoked_count).toBe(2);
    expect(payload.reason).toBe("Me retiro del sistema");

    // Notification to admin
    const [adminNotif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, adminUserId),
          eq(notifications.notificationType, "govt_self_deactivated_admin_notice"),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(adminNotif).toBeDefined();

    // Cascade notice to govt2 (now sole-covering one or both localities)
    const [cascadeNotif] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, govt2UserId),
          eq(notifications.notificationType, "govt_self_deactivated_cascade_notice"),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(cascadeNotif).toBeDefined();
  });

  it("returns noOp on second call (already deactivated)", async () => {
    const result = await govtSelfDeactivateForUser(govtUserId);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);
    expect(result.noOp).toBe(true);
  });
});

// ============================================================================
// selfReactivatePersonalAccountForUser — the way BACK
// ============================================================================
//
// WHY THIS EXISTS AT ALL. `requireLiveUser` used to read `deactivated_at` for
// INSTITUTIONAL accounts only, so a person who self-deactivated from /cuenta was
// told the action was "irreversible desde el panel" and then charged nothing:
// the column was written and no write boundary ever read it. Enforcing the
// column for every account type closes that, and closing it ALONE would replace
// a lie with a dead end — every write refused, and a support ticket as the only
// route back from a decision the person made themselves.
//
// These tests are DB-backed rather than mocked on purpose: the properties that
// matter here are exactly-once (the anti-race WHERE) and the audit row, and
// neither survives a mocked drizzle chain.

describe("selfReactivatePersonalAccountForUser", () => {
  it("is a no-op on an account that is already active", async () => {
    const result = await selfReactivatePersonalAccountForUser(personalDeactUserId);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.ok).toBe(true);
    expect(result.noOp).toBe(true);
  });

  it("clears deactivated_at and writes an audit row after a self-deactivation", async () => {
    const down = await selfDeactivatePersonalAccountForUser(
      personalDeactUserId,
      "Me tomo unas vacaciones",
    );
    expect(down).not.toHaveProperty("error");

    // THE PRECONDITION THIS TEST RESTS ON — without it the reactivation below
    // would pass vacuously against an account that was never off.
    const [afterDown] = await db
      .select({ deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, personalDeactUserId))
      .limit(1);
    expect(afterDown.deactivatedAt).not.toBeNull();

    const up = await selfReactivatePersonalAccountForUser(personalDeactUserId);
    expect(up).not.toHaveProperty("error");
    if ("error" in up) return;
    expect(up.ok).toBe(true);
    expect(up.noOp).toBeUndefined();

    const [afterUp] = await db
      .select({ deactivatedAt: profiles.deactivatedAt })
      .from(profiles)
      .where(eq(profiles.id, personalDeactUserId))
      .limit(1);
    expect(afterUp.deactivatedAt).toBeNull();

    const [audit] = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, personalDeactUserId),
          eq(auditLog.action, "personal_self_reactivated"),
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(audit).toBeDefined();
  });

  it("returns noOp on a second call — the anti-race WHERE fires exactly once", async () => {
    const result = await selfReactivatePersonalAccountForUser(personalDeactUserId);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.noOp).toBe(true);
  });

  // THE ESCALATION THIS BLOCKS. An institutional deactivation is an operator's
  // act on somebody else's account; letting its subject undo it through the
  // self-service path would be a privilege escalation wearing a self-service
  // affordance. The check is in the DATABASE-read use-case, not in the UI that
  // declines to render the button.
  it("refuses an INSTITUTIONAL account — that deactivation is not the subject's to undo", async () => {
    const result = await selfReactivatePersonalAccountForUser(govtUserId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/ROLE_MISMATCH/);
  });
});
