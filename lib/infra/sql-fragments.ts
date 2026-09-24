// Shared SQL fragment builders for raw drizzle queries.

import { type SQL, sql } from "drizzle-orm";

const UUID_REGEX = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * Cast a JSONB-extracted text expression to uuid without ever throwing.
 *
 * Projections read an append-only event log whose historic payloads may not
 * match the current Zod schema (schemas evolve; seeded or upcasted rows stay
 * forever). A bare uuid cast of `payload->>'key'` turns one malformed row
 * into a page-level crash (Postgres 22P02). CASE guarantees the regex guard is
 * evaluated before the cast, and keeps the comparison uuid = uuid so index
 * lookups on the joined column still apply. Non-uuid values yield NULL,
 * which joins/filters treat as "no match".
 */
export function safePayloadUuid(expr: SQL): SQL {
  return sql`(CASE WHEN ${expr} ~ ${UUID_REGEX} THEN (${expr})::uuid END)`;
}
