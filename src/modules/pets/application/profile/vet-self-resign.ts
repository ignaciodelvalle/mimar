// Use-case: vetSelfResignForUser (§7.8)
//
// Steps:
//   1. Load profile
//   2. Idempotency: if already owner → noOp
//   3. Capability check: role must be 'vet' AND accountType must be 'personal'
//   4. ONE transaction: UPDATE profiles (role='owner', matriculaVerified=false,
//      anti-race WHERE) + INSERT audit_log action='self_resignation_vet'
//   5. INSERT notification to self (type='self_resignation_confirmed')
//
// Note: matriculaNumber and matriculaJurisdiccion are PRESERVED — they are
// biographical facts, not a live entitlement. Only the verified flag is cleared.
//
// §2.2: The single post-tx notification is wrapped in try/catch so a
// notification insert failure does not roll back the role change.

import { and, eq } from "drizzle-orm";

import { db, notifications, profiles } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";

import type { VetSelfResignResult } from "./types";

export async function vetSelfResignForUser(
  userId: string,
  input?: { reason?: string },
): Promise<VetSelfResignResult> {
  // 1. Load profile
  const [profile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      // Read for the audit row's `before` state. The payload must state what
      // was actually true, not what the demotion assumes was true.
      matriculaVerified: profiles.matriculaVerified,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!profile) return { error: "NOT_FOUND" };

  // 2. Idempotency: already owner → nothing to do
  if (profile.role === "owner") {
    return { ok: true, noOp: true };
  }

  // 3. Capability check
  if (profile.role !== "vet" || profile.accountType !== "personal") {
    return { error: "ROLE_MISMATCH: only a personal vet account can self-resign" };
  }

  // 4+5. UPDATE profiles (anti-race WHERE — only transitions from role='vet')
  // + audit, in ONE transaction (2026-08-16). A role demotion whose audit row
  // was a separate autocommit could commit with no trace of who dropped the
  // vet entitlement or why.
  const demoted = await db.transaction(async (tx) => {
    const updated = await tx
      .update(profiles)
      .set({ role: "owner", matriculaVerified: false, updatedAt: new Date() })
      .where(and(eq(profiles.id, userId), eq(profiles.role, "vet")))
      .returning({ id: profiles.id });

    // Race: another request already changed the role. Nothing happened, so
    // nothing is audited — returning here rolls back an empty transaction.
    if (updated.length < 1) return false;

    await writeAuditLog(tx, {
      action: "self_resignation_vet",
      actorUserId: userId,
      targetUserId: userId,
      payload: { reason: input?.reason ?? null },
      before: { role: profile.role, matricula_verified: profile.matriculaVerified },
      after: { role: "owner", matricula_verified: false },
    });

    return true;
  });

  if (!demoted) return { ok: true, noOp: true };

  // 6. Notification to self — best-effort, must not roll back the role change.
  try {
    await db.insert(notifications).values({
      userId,
      notificationType: "self_resignation_confirmed",
      title: "Renuncia registrada",
      body: "Renunciaste a tu rol de veterinario/a. Volviste a ser dueño/a. Tu matrícula quedó registrada pero sin verificar.",
      severity: "info",
      ctaLabel: "Ver mi cuenta",
      ctaUrl: "/cuenta",
    });
  } catch (e) {
    console.error("notifications insert failed (vetSelfResignForUser did succeed)", e);
  }

  return { ok: true };
}
