// Use-case: logRequestViewedForAuthority
//
// Records that the actor opened the review page for this request. Fires
// once per render (acceptable noise for an admin tool); the audit_log row
// captures the page-view via spec §7.4.

import { eq } from "drizzle-orm";

import { approvalRequests, auditLog, db } from "@/db";

export async function logRequestViewedForAuthority(
  actorUserId: string,
  publicToken: string,
): Promise<void> {
  const [request] = await db
    .select({
      id: approvalRequests.id,
      targetUserId: approvalRequests.targetUserId,
      targetOrganizationId: approvalRequests.targetOrganizationId,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.publicToken, publicToken))
    .limit(1);
  if (!request) return;
  await db.insert(auditLog).values({
    actorUserId,
    action: "request_viewed",
    approvalRequestId: request.id,
    targetUserId: request.targetUserId,
    targetOrganizationId: request.targetOrganizationId,
    payload: {},
  });
}
