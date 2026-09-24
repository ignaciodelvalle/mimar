// UUID shape check for values read from heterogeneous sources (event
// payloads, query params) before they are compared against uuid columns.
// A bare `uuid = $1` with non-uuid text aborts the whole query (Postgres
// 22P02) — the SQL-side counterpart is safePayloadUuid in
// lib/infra/sql-fragments.ts; this is the TS-side guard for parameterized
// queries built with drizzle's eq().

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
