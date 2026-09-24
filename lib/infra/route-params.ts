import "server-only";

import { notFound } from "next/navigation";

import { isUuid } from "@/lib/utils/uuid";

/**
 * 404 unless `value` is a uuid.
 *
 * WHY THIS EXISTS
 * ---------------
 * Most `[id]`-shaped route segments in this app are compared against a uuid
 * PRIMARY KEY column. Postgres rejects a non-uuid on that comparison
 * ("invalid input syntax for type uuid"), the query throws, and Next renders
 * the generic error boundary — under HTTP **200**. So a mistyped or stale URL
 * answered "Algo salió mal, código de error …" with a success status.
 *
 * That is wrong three ways: a 200 for a nonexistent resource lies to monitoring
 * and to crawlers; the operator reads a broken system instead of "that record
 * does not exist"; and the product ALREADY ships the right screen ("No
 * encontramos esta página"). QA 2026-08-07 found it on the adoption detail
 * route by guessing sibling URLs; a sweep found the same shape on eight more.
 *
 * NOT EVERY id PARAM BELONGS HERE. Some segments accept a public code as well
 * as a uuid — /gob/maltrato/[id] and /gob/moderacion/[id] take DEN-XXXX-XXXX —
 * and guarding those on uuid alone would 404 every legitimate link. Those use
 * `isResolvableWelfareReportParam` (lib/infra/welfare-inspector-detail.ts).
 * Check what the segment is actually compared against before reaching for this.
 */
export function requireUuidParam(value: string): string {
  if (!isUuid(value)) notFound();
  return value;
}
