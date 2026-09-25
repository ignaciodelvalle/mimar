// provisionVetPractice — a freshly approved vet gets somewhere to attend
// (W6 · PO decision 15, option A · finding F-9).
//
// THE DEFECT. Approving a `role_upgrade_vet` request set `profiles.role='vet'`
// and `matriculaVerified` and nothing else. Every clinical write is org-
// mediated (`requireCapabilityForOrgToken("event.write", …)`, the atender
// context, the v1 event writers), so a vet whose only membership was, say, a
// tránsito in a shelter was — correctly — refused. In the TN-10 rehearsal the
// newly approved vet could not close a rabies observation and another vet had
// to be used.
//
// THE RULE, decided inside the approval's own transaction:
//   · the vet already holds an ACTIVE membership, in an active org, where
//     `event.write` is effective (admin, vet_individual, or an approved grant)
//     → nothing is created. That covers a vet already attached to a clinic, and
//     it is what makes a second approval a no-op instead of a second practice;
//   · the vet had a practice of their own that a revocation closed → it is
//     REOPENED (matricula-practices.ts reactivatePractice), never duplicated;
//   · otherwise → an individual-practice organization (org_type `clinic`,
//     auto-verified through the matrícula exactly like the solo-vet path of
//     `upgrade/create-organization.ts`) with the vet as its ADMIN — the same
//     role that path gives, so they can set the practice's name and contact in
//     Configuración and the revocation cascade covers it like any solo clinic.
//
// WHAT IT DELIBERATELY DOES NOT DO: grant `event.write` inside an organization
// the vet merely belongs to (a shelter where they foster, a clinic where they
// are a plain member). That permission is that org's admin's to give — it
// passes the rank rule and the four-eyes rule in grant-capability.ts — and an
// approving AUTHORITY is not that org's admin. The vet gets their own place
// instead, and the org can still grant them the capability through its own
// members page.
//
// THE SPINE. Organizations have no event table of their own; the append-only
// record of org creation in this codebase is what create-organization.ts
// writes, and this writes the same three things: the `org_member_added`
// audit_log row, the (auto-approved) `organization_verification` approval
// request that says why the org is verified, and the membership itself. The
// audit row carries `how: "vet_approval_provisioning"` and the approval
// request id, so the practice traces back to the authority's decision; the
// approval's own `request_approved` row records the outcome in its summary.
//
// CONCURRENCY. The caller has already UPDATEd this vet's profile row in the
// same transaction, which holds its row lock until commit; a second approval
// for the same person blocks on that UPDATE and, under READ COMMITTED, its
// membership read below sees the committed practice and returns "existing".

import { and, eq, isNull } from "drizzle-orm";

import {
  type ApprovalRequest,
  approvalRequests,
  auditLog,
  type db,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { validateApprovalPayload } from "@/lib/infra/approval-payloads";
import {
  findReusablePractice,
  reactivatePractice,
} from "@/src/modules/organizations/application/matricula-practices";
import { syncEventWriteMirror } from "@/src/modules/organizations/application/set-member-event-write";
import { resolveGrantedCaps } from "@/src/modules/organizations/domain/capabilities";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type VetPracticeTokens = {
  /** A fresh organizations.public_token, minted before the transaction. */
  orgPublicToken: string;
  /** A fresh approval_requests.public_token for the org-verification record. */
  verificationPublicToken: string;
};

export type VetPracticeOutcome =
  | { kind: "existing"; organization_id: string; membership_id: string }
  | { kind: "reactivated"; organization_id: string; membership_id: string }
  | { kind: "provisioned"; organization_id: string; membership_id: string };

export async function provisionVetPractice(
  tx: Tx,
  input: {
    vetUserId: string;
    actorUserId: string;
    request: Pick<ApprovalRequest, "id" | "jurisdictionProvince" | "jurisdictionLocality">;
    tokens: VetPracticeTokens;
  },
): Promise<VetPracticeOutcome> {
  const repo = new OrgRepository();

  // 1. Somewhere to write already? Active membership, active org, effective
  //    event.write — the same resolveGrantedCaps the resolver enforces with.
  const memberships = await tx
    .select({
      id: organizationMemberships.id,
      organizationId: organizationMemberships.organizationId,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, input.vetUserId),
        isNull(organizationMemberships.leftAt),
        eq(organizations.status, "active"),
      ),
    );
  for (const m of memberships) {
    const state = await repo.readEventWriteState(m.id, tx);
    if (
      state &&
      resolveGrantedCaps(state.role, state.approvedCapabilities, {
        vetCredentialValid: state.vetCredentialValid,
      }).has("event.write")
    ) {
      // Make the legacy column say what is true on the membership we rely on
      // (it may predate the single writer). Derived, so it can only correct.
      await syncEventWriteMirror(repo, m.id, tx);
      return { kind: "existing", organization_id: m.organizationId, membership_id: m.id };
    }
  }

  // 2. Their own earlier practice, closed by a revocation? Reopen it.
  const reusable = await findReusablePractice(tx, input.vetUserId);
  if (reusable) {
    await reactivatePractice(tx, reusable, {
      userId: input.vetUserId,
      actorUserId: input.actorUserId,
      approvalRequestId: input.request.id,
    });
    return {
      kind: "reactivated",
      organization_id: reusable.organizationId,
      membership_id: reusable.membershipId,
    };
  }

  // 3. Provision the individual practice.
  const [vet] = await tx
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, input.vetUserId))
    .limit(1);
  const name = `Consultorio de ${vet?.displayName?.trim() || "veterinaria"}`.slice(0, 100);
  const now = new Date();

  const [practice] = await tx
    .insert(organizations)
    .values({
      publicToken: input.tokens.orgPublicToken,
      displayName: name,
      legalName: name,
      orgType: "clinic",
      // Left empty on purpose: the vet's login address is not published as a
      // practice contact without them choosing to. They set it in Configuración.
      email: "",
      jurisdictionProvince: input.request.jurisdictionProvince,
      jurisdictionLocality: input.request.jurisdictionLocality,
      // Same as the solo-vet clinic: verified through the matrícula the
      // authority just verified; verifiedByUserId null = a system decision.
      verified: true,
      verifiedAt: now,
      verifiedByUserId: null,
      autoVerifiedViaMatricula: true,
      createdByUserId: input.vetUserId,
    })
    .returning({ id: organizations.id });

  const [membership] = await tx
    .insert(organizationMemberships)
    .values({ organizationId: practice.id, userId: input.vetUserId, role: "admin" })
    .returning({ id: organizationMemberships.id });

  // Legacy column through its single writer: admin → true.
  await syncEventWriteMirror(repo, membership.id, tx);

  await tx.insert(auditLog).values({
    actorUserId: input.actorUserId,
    action: "org_member_added",
    targetUserId: input.vetUserId,
    targetOrganizationId: practice.id,
    payload: {
      org_id: practice.id,
      member_user_id: input.vetUserId,
      role: "admin",
      how: "vet_approval_provisioning",
      approval_request_id: input.request.id,
    },
  });

  await tx.insert(approvalRequests).values({
    publicToken: input.tokens.verificationPublicToken,
    type: "organization_verification",
    status: "approved",
    applicantUserId: input.vetUserId,
    initiatedBy: "self",
    targetOrganizationId: practice.id,
    jurisdictionProvince: input.request.jurisdictionProvince,
    jurisdictionLocality: input.request.jurisdictionLocality,
    // Through the registered schema, like every other approval payload.
    payload: validateApprovalPayload("organization_verification", {
      org_type: "clinic",
      cuit: null,
      personeria_juridica_number: null,
      additional_documents_summary: null,
    }),
    decidedAt: now,
    decidedByUserId: null,
    decisionNotes:
      "Auto-verified via verified matrícula — individual practice provisioned on matrícula approval",
  });

  return { kind: "provisioned", organization_id: practice.id, membership_id: membership.id };
}
