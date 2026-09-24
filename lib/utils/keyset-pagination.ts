// Keyset (cursor) pagination helpers — shared across all PERF-5 surfaces.
//
// Cursor format: opaque base64url of "<iso-timestamp>|<uuid>" encoding the
// (timestamp, id) pair of the last row on the current page. The client never
// constructs cursors — they are always emitted by the server as ?cursor=<...>
// href values.
//
// Ordering contract: every surface uses DESC order on its primary timestamp
// column. The keyset WHERE for "next page (older)" is therefore:
//
//   (ts, id) < (cursorTs, cursorId)
//
// which in Postgres row-value form is:
//
//   (ts AT TIME ZONE 'UTC', id) < (cursorTs::timestamptz, cursorId)
//
// IMPORTANT: never pass a raw Date object into a sql`` template — postgres.js
// serializes Date as a local-time string which can cause off-by-one errors and
// triggers "cannot determine data type of parameter $N" TypeErrors. Always call
// `.toISOString()` and cast `::timestamptz` explicitly.

import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Cursor encode / decode
// ---------------------------------------------------------------------------

/** Opaque cursor — callers should treat this as a black box string. */
export type KeysetCursor = string;

/**
 * Encode (timestamp, id) pair to an opaque base64url cursor string.
 *
 * @param ts   Timestamp value as returned by Drizzle (Date | string).
 * @param id   UUID string for the row.
 */
export function encodeCursor(ts: Date | string, id: string): KeysetCursor {
  const iso = ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
  // Use base64url (no padding) so the cursor is URL-safe without encoding.
  const payload = `${iso}|${id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decode a cursor string.  Returns null if the cursor is missing, malformed,
 * or tampered with — callers fall back to page 1 on null.
 */
// Strict ISO-8601 datetime: YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// RFC 4122 UUID (lowercase hex, hyphen-separated)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(raw: string | null | undefined): {
  ts: string;
  id: string;
} | null {
  if (!raw) return null;
  try {
    const payload = Buffer.from(raw, "base64url").toString("utf8");
    const pipeIdx = payload.indexOf("|");
    if (pipeIdx === -1) return null;
    const iso = payload.slice(0, pipeIdx);
    const id = payload.slice(pipeIdx + 1);
    // Strict ISO-8601 validation: reject Date.parse-only values like "2026" or "Jan 1 2026"
    // that would later produce a safe-looking timestamptz cast but carry attacker-shaped input.
    if (!ISO_8601_RE.test(iso)) return null;
    // Strict UUID validation: id is cast as ::uuid in keysetWhere — reject anything that is not
    // a well-formed UUID to prevent a Postgres error (→ 500) from attacker-controlled ?cursor=.
    if (!UUID_RE.test(id)) return null;
    return { ts: iso, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keyset WHERE fragment
// ---------------------------------------------------------------------------

/**
 * Returns a Drizzle SQL fragment that pages PAST the cursor for DESC-ordered
 * lists (newest → oldest):
 *
 *   (tsCol, idCol) < (cursorTs::timestamptz, cursorId::uuid)
 *
 * Returns undefined when cursor is null (= first page — no extra predicate).
 *
 * @param tsCol   Drizzle column reference for the timestamp column.
 * @param idCol   Drizzle column reference for the id (uuid) column.
 * @param cursor  Decoded cursor from `decodeCursor`, or null for page 1.
 */
export function keysetWhere(
  tsCol: AnyPgColumn,
  idCol: AnyPgColumn,
  cursor: { ts: string; id: string } | null,
): SQL | undefined {
  if (!cursor) return undefined;
  // Row-value comparison: (ts, id) < (cursorTs, cursorId).
  // Both sides cast explicitly to avoid implicit type ambiguity in postgres.js.
  return sql`(${tsCol}, ${idCol}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the ?cursor=... href for the "older" link.
 *
 * Preserves existing searchParams so filters are not lost when paginating.
 * Replaces any existing `cursor` param.
 *
 * @param baseUrl   Pathname (e.g. "/notificaciones").
 * @param existing  Current URLSearchParams (or plain object).
 * @param lastRow   The last rendered row — { ts, id }.
 */
export function olderHref(
  baseUrl: string,
  existing: URLSearchParams | Record<string, string | undefined>,
  lastRow: { ts: Date | string; id: string },
): string {
  const params =
    existing instanceof URLSearchParams ? new URLSearchParams(existing) : new URLSearchParams();
  if (!(existing instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(existing)) {
      if (v !== undefined) params.set(k, v);
    }
  }
  params.set("cursor", encodeCursor(lastRow.ts, lastRow.id));
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Build the href for the "newer / back to page 1" link.
 *
 * Removes the `cursor` param; keeps all other filters.
 */
export function newerHref(
  baseUrl: string,
  existing: URLSearchParams | Record<string, string | undefined>,
): string {
  const params =
    existing instanceof URLSearchParams ? new URLSearchParams(existing) : new URLSearchParams();
  if (!(existing instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(existing)) {
      if (v !== undefined) params.set(k, v);
    }
  }
  params.delete("cursor");
  const qs = params.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}
