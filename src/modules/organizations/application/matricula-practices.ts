// A vet's MATRÍCULA-BACKED PRACTICES — the organizations a vet created and that
// are verified only because their matrícula is (W6 review).
//
// Two ends of one lifecycle, kept in one file so they agree on what "the vet's
// own practice" is:
//
//   · endMatriculaPractices — when the matrícula is REVOKED (revoke-vet-role.ts),
//     the practice must not keep writing clinical events, nor keep reading as
//     verified, on its strength:
//       - every ACTIVE membership the vet holds in an org they created with
//         `autoVerifiedViaMatricula` is ended (whatever its role), each with an
//         `org_member_removed` audit row;
//       - every such org that is still verified is un-verified, WHETHER OR NOT
//         it has co-admins, each with an `org_unverified` audit row. The flag is
//         only ever set by the matrícula paths (create-organization.ts solo vet,
//         provisioning here) and never by a formal verification, so an org that
//         carries it has no basis for being verified other than the matrícula
//         just revoked. A co-admin the vet appointed is not independent
//         governance; the way back is a formal organization_verification.
//       The general D4 cascade in revoke-vet-role.ts (sole-admin clinics) is
//       left as it is; this is the stricter rule for the vet's OWN practices.
//     The resolver independently refuses vet_individual's implicit caps to a
//     non-vet (domain/capabilities.ts) — this is the layer that removes the rows.
//
//   · findReusablePractice / reactivatePractice — when the same person is
//     approved again, their old practice is reopened (membership reactivated,
//     org re-verified, both audited) instead of leaving it an orphan and
//     creating a second one.
//
// Everything is recorded in audit_log, like every membership and verification
// change in this module. The reuse lookup READS that record back: the
// `how: "vet_revocation"` removal row is what marks a practice as closed by the
// matrícula (the flag is cleared on revocation, so the org cannot say it).

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { auditLog, type db, organizationMemberships, organizations } from "@/db";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

import { syncEventWriteMirror } from "./set-member-event-write";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MatriculaPracticeMembership = {
  membershipId: string;
  organizationId: string;
  role: string;
};

export type MatriculaPractices = {
  /** The vet's ACTIVE memberships in the orgs they created on the matrícula. */
  memberships: MatriculaPracticeMembership[];
  /** Those orgs (by creator + flag, membership or not) that are still verified. */
  verifiedOrgs: { id: string; displayName: string }[];
};

/**
 * What a revocation of `userId`'s matrícula has to close. Read it BEFORE
 * anything in the same transaction clears `autoVerifiedViaMatricula`
 * (revoke-vet-role's D4 cascade does).
 */
export async function findMatriculaPractices(tx: Tx, userId: string): Promise<MatriculaPractices> {
  const memberships = await tx
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
  // Membership-independent: a practice the vet already stepped out of (a
  // co-admin runs it) is still verified on the vet's matrícula alone.
  const verifiedOrgs = await tx
    .select({ id: organizations.id, displayName: organizations.displayName })
    .from(organizations)
    .where(
      and(
        eq(organizations.createdByUserId, userId),
        eq(organizations.autoVerifiedViaMatricula, true),
        eq(organizations.verified, true),
      ),
    );
  return { memberships, verifiedOrgs };
}

/**
 * End those memberships, un-verify those orgs, and audit every change.
 * `reasonAuditLogId` points at the revocation's own audit row.
 */
export async function endMatriculaPractices(
  tx: Tx,
  practices: MatriculaPractices,
  input: {
    userId: string;
    actorUserId: string;
    how: "vet_revocation";
    reasonAuditLogId: string | null;
  },
): Promise<void> {
  const now = new Date();
  const repo = new OrgRepository();

  for (const p of practices.memberships) {
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

  if (practices.verifiedOrgs.length === 0) return;
  // Idempotent over the D4 cascade, which may already have flipped the
  // sole-admin ones earlier in this transaction; the audit row is written per
  // org read as verified at the start, so each carries exactly one.
  await tx
    .update(organizations)
    .set({
      verified: false,
      verifiedAt: null,
      verifiedByUserId: null,
      autoVerifiedViaMatricula: false,
      updatedAt: now,
    })
    .where(
      inArray(
        organizations.id,
        practices.verifiedOrgs.map((o) => o.id),
      ),
    );
  for (const org of practices.verifiedOrgs) {
    await tx.insert(auditLog).values({
      actorUserId: input.actorUserId,
      action: "org_unverified",
      targetUserId: input.userId,
      targetOrganizationId: org.id,
      payload: {
        org_id: org.id,
        org_display_name: org.displayName,
        reason: "creator_matricula_revoked",
        reason_audit_log_id: input.reasonAuditLogId,
      },
    });
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
        // Drizzle-interpolated columns, not a raw `a.payload` alias: this reads
        // an AUDIT row, and lint:events cannot tell a raw alias of audit_log
        // from a pet_events one (see the surveillance.ts entry in
        // scripts/event-parity-baseline.json). Unaliased on purpose — the
        // outer query has no audit_log in scope, so the reference is not
        // ambiguous.
        sql`(
          select ${auditLog.payload} ->> 'how'
          from ${auditLog}
          where ${auditLog.action} = 'org_member_removed'
            and ${auditLog.targetOrganizationId} = ${organizations.id}
            and ${auditLog.targetUserId} = ${userId}
          order by ${auditLog.performedAt} desc
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

/**
 * Reopen it: the membership back as admin, the org re-verified through the
 * matrícula, each audited.
 *
 * `joined_at` is left as it was: the row's first join is history, and the
 * schema has no reactivation column (adding one would take a migration for a
 * fact the audit trail already holds — the `org_member_removed` row with
 * `how: "vet_revocation"` and the `org_member_added` row with
 * `how: "vet_approval_reactivation"` bracket the gap exactly).
 */
export async function reactivatePractice(
  tx: Tx,
  practice: { organizationId: string; membershipId: string },
  input: { userId: string; actorUserId: string; approvalRequestId: string },
): Promise<void> {
  const now = new Date();
  await tx
    .update(organizationMemberships)
    .set({ leftAt: null, role: "admin" })
    .where(eq(organizationMemberships.id, practice.membershipId));
  await syncEventWriteMirror(new OrgRepository(), practice.membershipId, tx);
  const [org] = await tx
    .update(organizations)
    .set({
      verified: true,
      verifiedAt: now,
      verifiedByUserId: null,
      autoVerifiedViaMatricula: true,
      updatedAt: now,
    })
    .where(eq(organizations.id, practice.organizationId))
    .returning({ displayName: organizations.displayName });
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
  await tx.insert(auditLog).values({
    actorUserId: input.actorUserId,
    action: "org_verified",
    targetUserId: input.userId,
    targetOrganizationId: practice.organizationId,
    approvalRequestId: input.approvalRequestId,
    payload: {
      org_id: practice.organizationId,
      org_display_name: org?.displayName ?? null,
      how: "vet_approval_reactivation",
    },
  });
}
