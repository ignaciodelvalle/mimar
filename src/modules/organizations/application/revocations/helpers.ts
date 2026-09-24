// Shared DB helpers for admin-revocations use-cases.
//
// claimAttachmentsForAudit was originally in app/actions/admin-revocations.ts
// and re-used by admin-institutional use-cases. After the strangler migration
// (8/61) it lives here — importers updated to point at this module path.
//
// ADR-5: export rather than duplicate — identical contract, identical error semantics.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { attachments, db, govtAssignments, profiles } from "@/db";

// ---------------------------------------------------------------------------
// loadActorAuthority
// ---------------------------------------------------------------------------

type AuthorityLoad =
  | {
      ok: true;
      profile: { id: string; role: "admin" | "govt" };
      jurisdictions: { province: string; locality: string }[];
    }
  | { ok: false; error: string };

export async function loadActorAuthority(actorUserId: string): Promise<AuthorityLoad> {
  const [profile] = await db
    .select({ id: profiles.id, role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);
  if (!profile || (profile.role !== "admin" && profile.role !== "govt")) {
    return { ok: false, error: "Solo govt o admin pueden revocar." };
  }
  let jurisdictions: { province: string; locality: string }[] = [];
  if (profile.role === "govt") {
    jurisdictions = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, profile.id), isNull(govtAssignments.revokedAt)));
  }
  return { ok: true, profile: { id: profile.id, role: profile.role }, jurisdictions };
}

// ---------------------------------------------------------------------------
// claimAttachmentsForAudit
// ---------------------------------------------------------------------------
//
// Claims `attachmentIds` for `auditLogId` inside a transaction.
// The WHERE clause enforces that:
//   - audit_log_id is still NULL (not yet claimed by another revocation)
//   - uploaded_by_user_id === actor (defense against passing foreign attachment IDs)
// Throws if the number of rows updated != attachmentIds.length — triggers tx rollback.
//
// Used by: admin-revocations use-cases, admin-institutional/deactivate-admin,
// admin-institutional/deactivate-govt.

export async function claimAttachmentsForAudit(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  auditLogId: string,
  attachmentIds: string[],
  actorUserId: string,
): Promise<void> {
  const updatedRows = await tx
    .update(attachments)
    .set({ auditLogId })
    .where(
      and(
        inArray(attachments.id, attachmentIds),
        isNull(attachments.auditLogId),
        eq(attachments.uploadedByUserId, actorUserId),
      ),
    )
    .returning({ id: attachments.id });
  if (updatedRows.length !== attachmentIds.length) {
    throw new Error(
      `ATTACHMENT_CLAIM_FAILED: expected ${attachmentIds.length} rows updated, got ${updatedRows.length}. Attachment IDs may not belong to actor or are already claimed.`,
    );
  }
}
