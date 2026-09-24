// Integration tests for verifyDniForUser (dni-verification.ts).
//
// Tests call the pure inner writer directly. Pattern mirrors profile-self-service.test.ts.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, notifications, profiles } from "@/db";
import { verifyDniForUser } from "@/src/modules/auth/application/dni-verification/verify-dni";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL_A = "dni-verify-a@dim-test.local";
const EMAIL_B = "dni-verify-b@dim-test.local";
const PASS = "DniVerify_2026!";

let userIdA: string;
let userIdB: string;

async function deleteTestUser(email: string): Promise<void> {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);

  const displayName = email.split("@")[0];
  const orphanedProfiles = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));

  const idsToClean = [
    ...(found ? [found.id] : []),
    ...orphanedProfiles.map((p) => p.id).filter((id) => id !== found?.id),
  ];

  for (const uid of idsToClean) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
    // audit_log rows are append-only; the GUC bypass is required for cleanup.
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
    });
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await deleteTestUser(EMAIL_A);
  await deleteTestUser(EMAIL_B);

  const rA = await createFreshTestUser(admin, {
    email: EMAIL_A,
    password: PASS,
    email_confirm: true,
  });
  if (rA.error || !rA.data.user) throw new Error(`createUser A: ${rA.error?.message}`);
  userIdA = rA.data.user.id;

  const rB = await createFreshTestUser(admin, {
    email: EMAIL_B,
    password: PASS,
    email_confirm: true,
  });
  if (rB.error || !rB.data.user) throw new Error(`createUser B: ${rB.error?.message}`);
  userIdB = rB.data.user.id;
});

afterAll(async () => {
  await deleteTestUser(EMAIL_A);
  await deleteTestUser(EMAIL_B);
});

describe("verifyDniForUser", () => {
  it("happy path: sets dni_hash + dni_last4 + dni_verified (no plaintext), inserts audit + notification", async () => {
    // Derive a per-user DNI from userId slice to avoid collisions across test runs.
    const dni = userIdA.replace(/\D/g, "").slice(0, 8).padEnd(8, "1");

    const result = await verifyDniForUser(userIdA, dni);
    expect(result.ok).toBe(true);

    const [profile] = await db
      .select({
        dniVerified: profiles.dniVerified,
        dniHash: profiles.dniHash,
        dniLast4: profiles.dniLast4,
      })
      .from(profiles)
      .where(eq(profiles.id, userIdA))
      .limit(1);
    expect(profile.dniVerified).toBe(true);
    // Wave 5 Item 25a: hash matches, plaintext is never stored.
    const { hashDni, dniLast4 } = await import("@/lib/utils/dni-hash");
    expect(profile.dniHash).toBe(hashDni(dni));
    expect(profile.dniLast4).toBe(dniLast4(dni));

    // Audit log row
    const auditRows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, userIdA));
    expect(auditRows.some((r) => r.action === "dni_verified_self")).toBe(true);

    // Self-notification
    const notifs = await db
      .select({ notificationType: notifications.notificationType })
      .from(notifications)
      .where(eq(notifications.userId, userIdA));
    expect(notifs.some((n) => n.notificationType === "profile_self_updated")).toBe(true);
  });

  it("idempotency: second call with already verified profile returns ok without side effects", async () => {
    const dni = userIdA.replace(/\D/g, "").slice(0, 8).padEnd(8, "1");

    // Count audit rows before
    const before = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, userIdA));
    const auditCountBefore = before.filter((r) => r.action === "dni_verified_self").length;

    const result = await verifyDniForUser(userIdA, dni);
    expect(result.ok).toBe(true);

    // No new audit rows inserted (idempotent short-circuit)
    const after = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, userIdA));
    const auditCountAfter = after.filter((r) => r.action === "dni_verified_self").length;
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("format validation: rejects 6-digit DNI", async () => {
    const result = await verifyDniForUser(userIdA, "123456");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/7 u 8 dígitos/);
  });

  it("format validation: rejects DNI with letters", async () => {
    const result = await verifyDniForUser(userIdA, "1234567A");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/7 u 8 dígitos/);
  });

  it("format validation: accepts 7-digit DNI", async () => {
    // userIdB has no DNI yet — use them for the 7-digit test
    const dni7 = userIdB.replace(/\D/g, "").slice(0, 7).padEnd(7, "2");
    const result = await verifyDniForUser(userIdB, dni7);
    expect(result.ok).toBe(true);
  });

  it("unique collision (AU-1 oracle defense): returns the GENERIC message, never a DNI-confirming one", async () => {
    // userIdB already has dni7; try to set the same value on a new user.
    const EMAIL_C = "dni-verify-c@dim-test.local";
    await deleteTestUser(EMAIL_C);
    const rC = await createFreshTestUser(admin, {
      email: EMAIL_C,
      password: PASS,
      email_confirm: true,
    });
    if (rC.error || !rC.data.user) throw new Error(`createUser C: ${rC.error?.message}`);
    const userIdC = rC.data.user.id;

    try {
      const dni7 = userIdB.replace(/\D/g, "").slice(0, 7).padEnd(7, "2");
      const result = await verifyDniForUser(userIdC, dni7);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The collision MUST surface the generic, non-confirming copy — a
        // distinct "ya está registrado" message would confirm the DNI exists.
        expect(result.error).toBe(
          "No pudimos guardar tus datos. Revisá la información e intentá de nuevo.",
        );
        expect(result.error).not.toMatch(/ya está registrado/i);
        expect(result.error).not.toMatch(/DNI/);
      }
    } finally {
      await deleteTestUser(EMAIL_C);
    }
  });
});
