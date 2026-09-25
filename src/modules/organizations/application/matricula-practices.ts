// A vet's MATRÍCULA-BACKED PRACTICES — the organizations a vet created and that
// are verified only because their matrícula is (W6 review).
//
// Two ends of one lifecycle, kept in one file so they agree on what "the vet's
// own practice" is:
//
//   · endMatriculaPractices — when the matrícula is REVOKED (revoke-vet-role.ts),
//     the practice must not keep writing clinical events on its strength. Every
//     ACTIVE membership the vet holds in an org they created with
//     `autoVerifiedViaMatricula` is ended (whatever its role), each with an
//     `org_member_removed` audit row, and the org is un-verified. The resolver
//     independently refuses vet_individual's implicit caps to a non-vet
//     (domain/capabilities.ts) — this is the layer that removes the row itself.
//
//   · findReusablePractice / reactivatePractice — when the same person is
//     approved again, their old practice is reopened (membership reactivated,
//     org re-verified, audited) instead of leaving it an orphan and creating a
//     second one.
//
// Both write only to audit_log for their record, like every membership change
// in this module (remove-member.ts, leave-organization.ts). The reuse lookup
// READS that record back: the `how: "vet_revocation"` removal row is what marks
// a practice as closed by the matrícula (the D4 cascade clears
// autoVerifiedViaMatricula, so the org's own flag cannot say it afterwards).

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { auditLog, type db, organizationMemberships, organizations } from "@/db";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

import { syncEventWriteMirror } from "./set-member-event-write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MatriculaPracticeMembership = {
  membershipId: string;
  organizationId: string;
  role: string;
};

/**
 * The vet's ACTIVE memberships in orgs they created that are verified through
 * the matrícula. Read it BEFORE anything in the same transaction clears
 * `autoVerifiedViaMatricula` (revoke-vet-role's sole-admin cascade does).
 */
export async function findMatriculaPracticeMemberships(
  tx: Tx,
  userId: string,
): Promise<MatriculaPracticeMembership[]> {
  return tx
    .select({
      membershipId: organizationMemberships.id,
      organizationId: organizationMemberships.organizationId,
      role: organizationMemberships.role,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.leftAt),
        eq(organizations.createdByUserId, userId),
        eq(organizations.autoVerifiedViaMatricula, true),
      ),
    );
}

/**
 * End those memberships, un-verify their orgs, and audit each removal.
 * `reason` names what caused it; `reasonAuditLogId` points at the revocation's
 * own audit row when there is one.
 */
export async function endMatriculaPractices(
  tx: Tx,
  practices: readonly MatriculaPracticeMembership[],
  input: {
    userId: string;
    actorUserId: string;
    how: "vet_revocation";
    reasonAuditLogId: string | null;
  },
): Promise<void> {
  if (practices.length === 0) return;
  const now = new Date();
  const repo = new OrgRepository();

  for (const p of practices) {
    await tx
      .update(organizationMemberships)
      .set({ leftAt: now })
      .where(
        and(eq(organizationMemberships.id, p.membershipId), isNull(organizationMemberships.leftAt)),
      );
    // An ended membership writes nothing, but its mirror should not claim it can.
    await syncEventWriteMirror(repo, p.membershipId, tx);
    await tx.insert(auditLog).values({
      actorUserId: input.actorUserId,
      action: "org_member_removed",
      targetUserId: input.userId,
      targetOrganizationId: p.organizationId,
      payload: {
        org_id: p.organizationId,
        member_user_id: input.userId,
        role: p.role,
        how: input.how,
        reason_audit_log_id: input.reasonAuditLogId,
      },
    });
  }

  // Un-verify the practices left with NO active admin. One that still has a
  // co-admin keeps its verification — the same governance rule as the D4
  // cascade in revoke-vet-role.ts, which runs first and handles the sole-admin
  // case; this covers the rest (e.g. a practice whose only member held the
  // vet_individual role).
  for (const orgId of new Set(practices.map((p) => p.organizationId))) {
    const [admin] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, orgId),
          eq(organizationMemberships.role, "admin"),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    if (admin) continue;
    await tx
      .update(organizations)
      .set({
        verified: false,
        verifiedAt: null,
        verifiedByUserId: null,
        autoVerifiedViaMatricula: false,
        updatedAt: now,
      })
      .where(eq(organizations.id, orgId));
  }
}

/**
 * The vet's own previous practice, if there is one to reopen: a clinic they
 * created, still active as an org, with NO active admin (nobody else took it
 * over), in which they held a membership that has ended. Most recent first.
 *
 * Only a practice the MATRÍCULA REVOCATION closed qualifies: the last
 * `org_member_removed` row for that vet in that org must carry
 * `how: "vet_revocation"` (a vet who left or was removed is not pulled back
 * in), and no authority may have revoked the org's own verification
 * (`revocation_org_verified`) — re-approving a person does not re-verify an
 * organization an authority un-verified on its own merits.
 */
export async function findReusablePractice(
  tx: Tx,
  userId: string,
): Promise<{ organizationId: string; membershipId: string } | null> {
  const candidates = await tx
    .select({
      organizationId: organizations.id,
      membershipId: organizationMemberships.id,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        isNotNull(organizationMemberships.leftAt),
        eq(organizations.createdByUserId, userId),
        eq(organizations.orgType, "clinic"),
        eq(organizations.status, "active"),
        sql`(
          select a.payload ->> 'how'
          from ${auditLog} a
          where a.action = 'org_member_removed'
            and a.target_organization_id = ${organizations.id}
            and a.target_user_id = ${userId}
          order by a.performed_at desc
          limit 1
        ) = 'vet_revocation'`,
        sql`not exists (
          select 1 from ${auditLog} r
          where r.action = 'revocation_org_verified'
            and r.target_organization_id = ${organizations.id}
        )`,
      ),
    )
    .orderBy(desc(organizations.createdAt), desc(organizationMemberships.leftAt));

  for (const c of candidates) {
    const [activeAdmin] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, c.organizationId),
          eq(organizationMemberships.role, "admin"),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    if (!activeAdmin) return c;
  }
  return null;
}

/** Reopen it: the membership back as admin, the org re-verified through the matrícula. */
export async function reactivatePractice(
  tx: Tx,
  practice: { organizationId: string; membershipId: string },
  input: { userId: string; actorUserId: string; approvalRequestId: string },
): Promise<void> {
  const now = new Date();
  await tx
    .update(organizationMemberships)
    .set({ leftAt: null, role: "admin", joinedAt: now })
    .where(eq(organizationMemberships.id, practice.membershipId));
  await syncEventWriteMirror(new OrgRepository(), practice.membershipId, tx);
  await tx
    .update(organizations)
    .set({
      verified: true,
      verifiedAt: now,
      verifiedByUserId: null,
      autoVerifiedViaMatricula: true,
      updatedAt: now,
    })
    .where(eq(organizations.id, practice.organizationId));
  await tx.insert(auditLog).values({
    actorUserId: input.actorUserId,
    action: "org_member_added",
    targetUserId: input.userId,
    targetOrganizationId: practice.organizationId,
    payload: {
      org_id: practice.organizationId,
      member_user_id: input.userId,
      role: "admin",
      how: "vet_approval_reactivation",
      approval_request_id: input.approvalRequestId,
    },
  });
}
