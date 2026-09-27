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

import { type SQL, and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import type { AuditLogAction } from "@/db";
import { auditLog, db, profiles } from "@/db";
import { keysetWhere } from "@/lib/utils/keyset-pagination";

/**
 * `{ kind: "admin" }` = universal scope, no jurisdiction limit.
 * `{ kind: "govt", actorIds }` = restrict actorUserId to this jurisdiction-
 * derived set (possibly empty — callers must NOT treat empty as unscoped).
 *
 * jurisdiction-admin Phase 5 adds two optional fields to the govt kind:
 *   - `viewerId`: whose history this is. A row the viewer did NOT act is read
 *     through the redaction (auditHistoryRowColumns); without a viewer, EVERY
 *     row is — the absent field fails closed, never open.
 *   - `provinceCode`: set only for a live JURISDICTION ADMIN. Their scope is
 *     the peers above PLUS every row that happened in their province (the
 *     stamp, else the single province the row itself names — the database's
 *     own audit_place_province), which survives a funcionario's deactivation or
 *     transfer. Someone else's row reaches them WHAT and WHEN only, and a
 *     person on it only when that person is a funcionario (PO decision M1).
 */
export type AuditHistoryScope =
  | { kind: "admin" }
  | { kind: "govt"; actorIds: string[]; viewerId?: string; provinceCode?: string | null };

/**
 * The rows that happened in `provinceCode`: the stamp, else (a row written
 * before migration 0269) the single province the row itself names. Same
 * predicate as public.jurisdiction_admin_audit_trail.
 */
export function auditRowsInProvince(provinceCode: string): SQL {
  return sql`(${auditLog.provinceCode} = ${provinceCode} or (${auditLog.provinceCode} is null and public.audit_place_province(null, ${auditLog.payload}, ${auditLog.targetGovtAssignmentId}) = ${provinceCode}))`;
}

/**
 * The person/payload columns a history page selects, projected for the
 * viewer (jurisdiction-admin Phase 5, PO decision M1).
 *
 *  - admin: the raw columns — the platform admin keeps full detail.
 *  - govt: a row the viewer acted is theirs, raw. Anyone else's row carries
 *    its payload through public.audit_payload_redacted — an allow-list per
 *    action, fail-closed, the SAME function the appointee's PostgREST read
 *    uses. For a jurisdiction admin (provinceCode set) the actor and target
 *    are additionally shown only when they are funcionarios
 *    (public.audit_institutional_or_null); `personHidden` says a person was
 *    there and is not shown, so the page does not call them "deleted".
 *    And the approval request a row names is returned on the viewer's OWN
 *    rows only (final review LOW-2, migration 0272): the id is a citizen's
 *    application, and the page turns it into that request's public token.
 *    A request the appointee may decide is reached from their queue, whose
 *    scope check is the one that answers; the trail only says it happened.
 *
 * The redaction runs IN SQL: third-party data never reaches the server
 * component, so no render branch can leak it.
 */
export function auditHistoryRowColumns(scope: AuditHistoryScope): {
  actorUserId: SQL<string | null>;
  targetUserId: SQL<string | null>;
  approvalRequestId: SQL<string | null>;
  payload: SQL<unknown>;
  actorHidden: SQL<boolean>;
  targetHidden: SQL<boolean>;
} {
  if (scope.kind === "admin") {
    return {
      actorUserId: sql<string | null>`${auditLog.actorUserId}`,
      targetUserId: sql<string | null>`${auditLog.targetUserId}`,
      approvalRequestId: sql<string | null>`${auditLog.approvalRequestId}`,
      payload: sql<unknown>`${auditLog.payload}`,
      actorHidden: sql<boolean>`false`,
      targetHidden: sql<boolean>`false`,
    };
  }
  const own = scope.viewerId
    ? sql`(${auditLog.actorUserId} is not null and ${auditLog.actorUserId} = ${scope.viewerId})`
    : sql`false`;
  const payload = sql<unknown>`(case when ${own} then ${auditLog.payload} else public.audit_payload_redacted(${auditLog.action}, ${auditLog.payload}) end)`;
  if (!scope.provinceCode) {
    return {
      actorUserId: sql<string | null>`${auditLog.actorUserId}`,
      targetUserId: sql<string | null>`${auditLog.targetUserId}`,
      approvalRequestId: sql<string | null>`${auditLog.approvalRequestId}`,
      payload,
      actorHidden: sql<boolean>`false`,
      targetHidden: sql<boolean>`false`,
    };
  }
  const person = (column: typeof auditLog.actorUserId | typeof auditLog.targetUserId) =>
    sql`(case when ${own} then ${column} else public.audit_institutional_or_null(${column}) end)`;
  return {
    actorUserId: sql<string | null>`${person(auditLog.actorUserId)}::text`,
    targetUserId: sql<string | null>`${person(auditLog.targetUserId)}::text`,
    // Same rule as the trail (0272): a NULL, never the id, on anyone else's row.
    approvalRequestId: sql<
      string | null
    >`(case when ${own} then ${auditLog.approvalRequestId} end)::text`,
    payload,
    actorHidden: sql<boolean>`(${auditLog.actorUserId} is not null and ${person(auditLog.actorUserId)} is null)`,
    targetHidden: sql<boolean>`(${auditLog.targetUserId} is not null and ${person(auditLog.targetUserId)} is null)`,
  };
}

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
    const peers =
      scope.actorIds.length > 0 ? inArray(auditLog.actorUserId, scope.actorIds) : sql`false`;
    // A jurisdiction admin: the peers, or anything that happened in their
    // province (Phase 5). The OR is grouped by `or()` itself.
    clauses.push(
      scope.provinceCode ? (or(peers, auditRowsInProvince(scope.provinceCode)) as SQL) : peers,
    );
  }
  if (filters.actionFilters.length > 0) {
    clauses.push(inArray(auditLog.action, filters.actionFilters as AuditLogAction[]));
  }
  if (filters.actorFilter) {
    clauses.push(eq(auditLog.actorUserId, filters.actorFilter));
    // A jurisdiction admin filters only by a person they may SEE: a citizen's
    // id in the URL must not answer "did this person act in my province".
    if (scope.kind === "govt" && scope.provinceCode) {
      const own = scope.viewerId ? sql`${auditLog.actorUserId} = ${scope.viewerId} or ` : sql``;
      clauses.push(
        sql`(${own}public.audit_institutional_or_null(${auditLog.actorUserId}) is not null)`,
      );
    }
  }
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
 *
 * A govt viewer (final review LOW-3) gets that extra name only when the id
 * is their own or names a funcionario (public.audit_institutional_or_null,
 * the same test the rows and the ?actor= filter apply): the URL is theirs to
 * write, and an arbitrary citizen's id must not come back as a name. Any
 * other id stays out of the list — the filter itself already answers nothing
 * for it.
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
    const visible =
      scope.kind === "govt"
        ? and(
            eq(profiles.id, actorFilter),
            or(
              ...(scope.viewerId ? [eq(profiles.id, scope.viewerId)] : []),
              sql`public.audit_institutional_or_null(${profiles.id}) is not null`,
            ),
          )
        : eq(profiles.id, actorFilter);
    const [extra] = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(visible)
      .limit(1);
    if (extra) options.push({ id: extra.id, name: extra.displayName });
  }
  options.sort((a, b) => a.name.localeCompare(b.name, "es-AR"));
  return options;
}
