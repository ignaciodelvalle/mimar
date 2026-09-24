// Use-case: proposeOrgVerificationForOrg
//
// Validates actor authority, requires the org inside a govt actor's mandate,
// checks for pending duplicates, then inside a
// db.transaction: inserts the approval_request and conditionally collects
// a notification for the org's creator.
//
// Post-tx: flushes pendingNotifications (§2.2 — NOT inside the tx).
//
// Returns { ok: true; publicToken: string } on success or { error: string }
// on any failure.

import { and, eq } from "drizzle-orm";

import { approvalRequests, db, notifications, organizations } from "@/db";
import { validateApprovalPayload } from "@/lib/infra/approval-payloads";
import { generateApprovalRequestToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";

import {
  OUT_OF_JURISDICTION_PROPOSAL_ERROR,
  canProposeInJurisdiction,
  loadActorAuthority,
} from "./helpers";
import type { ProposalResult } from "./types";

export async function proposeOrgVerificationForOrg(
  actorUserId: string,
  input: { organizationId: string },
): Promise<ProposalResult> {
  const auth = await loadActorAuthority(actorUserId);
  if ("error" in auth) return { error: auth.error };
  // Admin proposes for any org; a govt only for an org inside its own active
  // assignments — checked below, once the org's jurisdiction is loaded (A10-7).

  const [org] = await db
    .select({
      id: organizations.id,
      verified: organizations.verified,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
      createdByUserId: organizations.createdByUserId,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!org) return { error: "Organización no encontrada." };
  // Scope first, so an out-of-mandate govt learns nothing about the org's
  // state. A govt facing an org with no jurisdiction fails closed here.
  if (!canProposeInJurisdiction(auth, org.jurisdictionProvince, org.jurisdictionLocality)) {
    return { error: OUT_OF_JURISDICTION_PROPOSAL_ERROR };
  }
  if (org.verified) return { error: "Esta organización ya está verificada." };
  if (!org.jurisdictionProvince || !org.jurisdictionLocality) {
    return { error: "La organización no tiene jurisdicción registrada." };
  }

  // Idempotency: one pending org_verification per org.
  const [pending] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.targetOrganizationId, org.id),
        eq(approvalRequests.type, "organization_verification"),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) {
    return { error: "Ya hay una solicitud pendiente de verificación para esta organización." };
  }

  let payload: unknown;
  try {
    payload = validateApprovalPayload("organization_verification", {
      org_type: "other",
      cuit: null,
      personeria_juridica_number: null,
      additional_documents_summary: "Propuesta admin-initiated. Sin documentos adjuntos en v1.",
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Payload inválido." };
  }

  // applicant_user_id: the org's creator if known, fallback to the actor.
  const applicantUserId = org.createdByUserId ?? actorUserId;
  const publicToken = await generateUniqueToken(
    approvalRequests,
    approvalRequests.publicToken,
    generateApprovalRequestToken,
  );
  // The earlier guard rejects null jurisdiction values, but TS doesn't
  // propagate the narrowing through the transaction closure. Pin the
  // values into a const so the insert sees `string`, not `string | null`.
  const province = org.jurisdictionProvince;
  const locality = org.jurisdictionLocality;

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  await db.transaction(async (tx) => {
    await tx.insert(approvalRequests).values({
      publicToken,
      type: "organization_verification",
      status: "pending",
      applicantUserId,
      initiatedBy: "authority",
      initiatedByUserId: actorUserId,
      targetOrganizationId: org.id,
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      payload,
    });
    if (applicantUserId !== actorUserId) {
      pendingNotifications.push({
        userId: applicantUserId,
        notificationType: "approval_request_proposed_authority",
        title: "Verificación propuesta para tu organización",
        body: "Una autoridad inició una solicitud de verificación para tu organización.",
        severity: "info",
        ctaLabel: "Ver panel",
        ctaUrl: "/org",
      });
    }
  });

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true, publicToken };
}
