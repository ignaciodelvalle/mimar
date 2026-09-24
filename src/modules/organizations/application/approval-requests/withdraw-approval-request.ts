// Use-case: withdrawApprovalRequestForUser — strangler migration 49/61.
//
// Pure writer: receives userId + requestId, runs the DB operations,
// and returns the result. No Next.js request context.
//
// The outer shim (app/actions/approval-requests.ts) gates via requireUserOrRedirect.
// Tests call withdrawApprovalRequestForUser directly with a known userId.

import { and, eq } from "drizzle-orm";

import { approvalRequests, db } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";

import type { WithdrawApprovalRequestResult } from "./types";

export async function withdrawApprovalRequestForUser(
  userId: string,
  requestId: string,
): Promise<WithdrawApprovalRequestResult> {
  // 1. Load the request
  const [request] = await db
    .select({
      id: approvalRequests.id,
      applicantUserId: approvalRequests.applicantUserId,
      status: approvalRequests.status,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId))
    .limit(1);

  if (!request) return { error: "NOT_FOUND" };

  // 2. Capability check — only the applicant can withdraw their own request
  if (request.applicantUserId !== userId) return { error: "FORBIDDEN" };

  // 3. Validation — only pending requests can be withdrawn
  if (request.status !== "pending") {
    return { error: `NOT_PENDING: current status is '${request.status}'` };
  }

  // 4+5. Transition to withdrawn + audit — ONE transaction (2026-08-16).
  //
  // DB constraint approval_decision_consistent requires:
  //   withdrawn → decided_at IS NULL AND decided_by_user_id IS NULL
  // The self-withdrawal timestamp lives in withdrawn_at instead.
  //
  // The status change and its accountability record are one fact: separate
  // autocommits meant a crash in between left a withdrawn request whose
  // withdrawal nobody could prove happened.
  await db.transaction(async (tx) => {
    await tx
      .update(approvalRequests)
      .set({
        status: "withdrawn",
        withdrawnAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.status, "pending")));

    await writeAuditLog(tx, {
      action: "approval_request_withdrawn_by_applicant",
      actorUserId: userId,
      approvalRequestId: requestId,
      targetUserId: userId,
      payload: { request_id: requestId },
      before: { status: request.status },
      after: { status: "withdrawn" },
    });
  });

  return { ok: true };
}
