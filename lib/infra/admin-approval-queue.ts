// Admin approval-queue read model (C1).
//
// /admin/cola is the single universal approval queue across every jurisdiction
// — the queue most prone to unbounded growth. It previously selected ALL
// `status='pending'` rows with no LIMIT and rendered them in a bulk-select
// list. This module bounds the fetch with keyset pagination and derives the
// total from a SEPARATE count(*), mirroring `listOpenCasesForAdminPreview`
// (lib/case-queries.ts) which separates the aggregate from the row fetch.

import { and, desc, eq, sql } from "drizzle-orm";

import { type ApprovalRequestType, approvalRequests, db } from "@/db";
import { type KeysetCursor, decodeCursor, keysetWhere } from "@/lib/utils/keyset-pagination";

export const ADMIN_QUEUE_PAGE_LIMIT = 50;

export interface PendingApprovalRow {
  id: string;
  publicToken: string;
  type: ApprovalRequestType;
  applicantUserId: string;
  jurisdictionProvince: string;
  jurisdictionLocality: string;
  createdAt: Date;
}

export interface PendingApprovalsPage {
  items: PendingApprovalRow[];
  total: number;
  hasMore: boolean;
}

/**
 * One keyset page of pending approval requests plus the global total.
 *
 * @param type    Optional approval-request type filter, pushed into SQL so the
 *                LIMIT applies AFTER narrowing (no silent truncation).
 * @param cursor  Opaque keyset cursor from a previous page; omit for page 1.
 * @param limit   Page size (default {@link ADMIN_QUEUE_PAGE_LIMIT}).
 */
export async function fetchPendingApprovalsPage({
  type,
  cursor,
  limit = ADMIN_QUEUE_PAGE_LIMIT,
}: {
  type?: ApprovalRequestType | null;
  cursor?: KeysetCursor | null;
  limit?: number;
}): Promise<PendingApprovalsPage> {
  const statusClause = eq(approvalRequests.status, "pending");
  const typeClause = type ? eq(approvalRequests.type, type) : undefined;
  // Total ignores the cursor — it is the size of the whole filtered queue.
  const totalWhere = typeClause ? and(statusClause, typeClause) : statusClause;

  const cursorClause = keysetWhere(
    approvalRequests.createdAt,
    approvalRequests.id,
    decodeCursor(cursor ?? null),
  );
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous Drizzle SQL expression union
  const pageConditions: any[] = [statusClause];
  if (typeClause) pageConditions.push(typeClause);
  if (cursorClause) pageConditions.push(cursorClause);

  const [rawRows, total] = await Promise.all([
    db
      .select({
        id: approvalRequests.id,
        publicToken: approvalRequests.publicToken,
        type: approvalRequests.type,
        applicantUserId: approvalRequests.applicantUserId,
        jurisdictionProvince: approvalRequests.jurisdictionProvince,
        jurisdictionLocality: approvalRequests.jurisdictionLocality,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .where(and(...pageConditions))
      // Fetch limit+1 to detect hasMore without a second round-trip (PERF-5).
      .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(totalWhere)
      .then((rows) => rows[0]?.count ?? 0),
  ]);

  const hasMore = rawRows.length > limit;
  const items = hasMore ? rawRows.slice(0, limit) : rawRows;

  return { items, total, hasMore };
}
