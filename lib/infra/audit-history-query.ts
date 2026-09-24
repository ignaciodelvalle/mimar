// Shared filter/query logic for the audit history surfaces (#26 admin↔gob
// drift unification, D1).
//
// admin/historial and gob/historial both filter audit_log by action / actor /
// date-range + a keyset cursor. The ONLY difference between the two surfaces
// is the SCOPE predicate:
//   - admin: universal — no actor restriction at all.
//   - govt:  bounded to actorUserId IN (jurisdiction-derived actor ids) — see
//     lib/infra/govt-audit-scope.ts for why the scope is actor-derived
//     (audit_log carries no jurisdiction column of its own). An EMPTY actor-id
//     list means "govt with no active assignment" and must resolve to
//     `sql\`false\`` (matches nothing), never "no restriction" — an empty
//     array is not the same as an absent scope.
//
// This module is the single source of the WHERE-clause assembly + the actor
// dropdown resolution, so a filter added to one surface can't silently
// diverge from the other. Row-level RENDERING (grouping, PII masking, target
// links) stays page-local — those are presentation decisions, not scoping
// ones, and admin/historial deliberately does not port them (D1 scope).

import { type SQL, and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { AuditLogAction } from "@/db";
import { auditLog, db, profiles } from "@/db";
import { keysetWhere } from "@/lib/utils/keyset-pagination";

/**
 * `{ kind: "admin" }` = universal scope, no jurisdiction limit.
 * `{ kind: "govt", actorIds }` = restrict actorUserId to this jurisdiction-
 * derived set (possibly empty — callers must NOT treat empty as unscoped).
 */
export type AuditHistoryScope = { kind: "admin" } | { kind: "govt"; actorIds: string[] };

export interface AuditHistoryFilters {
  actionFilters: readonly AuditLogAction[];
  actorFilter: string | null;
  fromDate?: Date;
  toDate?: Date;
  cursor: { ts: string; id: string } | null;
}

/**
 * Builds the audit_log WHERE clause for a history page. SCOPE is applied
 * first (an inArray on actorUserId for govt — `sql\`false\`` when the govt
 * actor has no active assignment; nothing at all for admin, i.e. universal),
 * then the user-facing filters (action / actor / date range), then the
 * keyset cursor. Returns `undefined` when no clause applies (admin, no
 * filters, page 1) — same "no WHERE at all" shape both pages relied on
 * before this extraction.
 */
export function buildAuditHistoryWhere(
  scope: AuditHistoryScope,
  filters: AuditHistoryFilters,
): SQL | undefined {
  const clauses: SQL[] = [];
  if (scope.kind === "govt") {
    clauses.push(
      scope.actorIds.length > 0 ? inArray(auditLog.actorUserId, scope.actorIds) : sql`false`,
    );
  }
  if (filters.actionFilters.length > 0) {
    clauses.push(inArray(auditLog.action, filters.actionFilters as AuditLogAction[]));
  }
  if (filters.actorFilter) clauses.push(eq(auditLog.actorUserId, filters.actorFilter));
  if (filters.fromDate) clauses.push(gte(auditLog.performedAt, filters.fromDate));
  if (filters.toDate) clauses.push(lte(auditLog.performedAt, filters.toDate));
  const cursorClause = keysetWhere(auditLog.performedAt, auditLog.id, filters.cursor);
  if (cursorClause) clauses.push(cursorClause);
  return clauses.length > 0 ? and(...clauses) : undefined;
}

/**
 * Resolves the actor `<select>` options for the history filter form.
 *  - govt (bounded scope): every actor IN the jurisdiction scope, not just
 *    the current page — a govt operator's peer set is small and bounded, so
 *    listing the full scope (not the page) lets the dropdown offer peers who
 *    have no rows on the current page yet.
 *  - admin (universal scope): derived from `pageActorIds` (the current
 *    page's distinct actors) — universal scope is unbounded, so listing
 *    every profile in the system is not a "current filter options" list
 *    (mirrors /admin/auditoria's existing approach).
 * In both branches, a selected `actorFilter` not already in the list is
 * fetched and appended so the dropdown still shows the selected name after
 * pagination narrows the page's own actor set.
 */
export async function resolveAuditHistoryActorOptions(
  scope: AuditHistoryScope,
  pageActorIds: readonly string[],
  namesById: ReadonlyMap<string, string>,
  actorFilter: string | null,
): Promise<{ id: string; name: string }[]> {
  let options: { id: string; name: string }[];
  if (scope.kind === "govt") {
    if (scope.actorIds.length === 0) {
      options = [];
    } else {
      const rows = await db
        .select({ id: profiles.id, displayName: profiles.displayName })
        .from(profiles)
        .where(inArray(profiles.id, scope.actorIds));
      options = rows.map((p) => ({ id: p.id, name: p.displayName }));
    }
  } else {
    options = pageActorIds.map((id) => ({ id, name: namesById.get(id) ?? "Desconocido" }));
  }
  if (actorFilter && !options.find((o) => o.id === actorFilter)) {
    const [extra] = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, actorFilter))
      .limit(1);
    if (extra) options.push({ id: extra.id, name: extra.displayName });
  }
  options.sort((a, b) => a.name.localeCompare(b.name, "es-AR"));
  return options;
}
