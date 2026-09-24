// /admin/auditoria data loader (platform-budget T3.3).
//
// Extracted from page.tsx so the page can (a) bound the WHOLE fetch group with
// loadWithTimeout (the page had zero protection — ~20 s first loads observed)
// and (b) the two independent profiles lookups (actor names + target names),
// which used to run SERIALLY after the entries query, now run in ONE
// Promise.all together with the optional "selected actor not on this page"
// lookup. Entries must still resolve first (both lookups key off its rows) —
// the parallelism is across the three follow-up queries, not the whole group.

import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";

import { auditLog, db, profiles } from "@/db";
import type { parseAuditActions } from "@/lib/ui/audit-filters";
import { buildTargetLinkInfo } from "@/lib/ui/audit-target-link";
import { keysetWhere } from "@/lib/utils/keyset-pagination";

export const AUDITORIA_PAGE_LIMIT = 200;

export type AuditFilters = {
  /** Validated audit action enum codes (possibly empty = all actions). */
  actionFilters: ReturnType<typeof parseAuditActions>;
  /** Exact actor UUID, or null = all actors. */
  actorFilter: string | null;
  /** Inclusive lower bound on performed_at, or null. */
  since: Date | null;
  /** Exclusive upper bound on performed_at, or null. */
  until: Date | null;
  /** Decoded keyset cursor, or null for page 1. */
  cursor: { ts: string; id: string } | null;
};

export type AuditEntry = {
  id: string;
  actorUserId: string | null;
  action: string;
  approvalRequestId: string | null;
  targetUserId: string | null;
  performedAt: Date;
  payload: unknown;
};

export type AuditData = {
  entries: AuditEntry[];
  hasMore: boolean;
  /** actor id → display name (page batch). */
  namesById: Map<string, string>;
  /** target id → display name + drill href (C12). */
  targetsById: Map<string, { displayName: string; href: string | null }>;
  /** Sorted dropdown options: page actors + the selected off-page actor (C30). */
  actorOptions: { id: string; name: string }[];
};

export async function loadAuditData(filters: AuditFilters): Promise<AuditData> {
  const { actionFilters, actorFilter, since, until, cursor } = filters;

  // Build WHERE clause — push every filter into SQL so the LIMIT is
  // applied after filtering (JS-side filtering would silently miss rows
  // beyond the cap). action uses IN over the validated enum codes; actor uses
  // exact UUID equality; the date range is a half-open [since, until) interval.
  // Keyset predicate is AND-composed last.
  const filterClauses = [];
  if (actionFilters.length > 0) filterClauses.push(inArray(auditLog.action, actionFilters));
  if (actorFilter) filterClauses.push(eq(auditLog.actorUserId, actorFilter));
  if (since) filterClauses.push(gte(auditLog.performedAt, since));
  if (until) filterClauses.push(lt(auditLog.performedAt, until));
  const cursorClause = keysetWhere(auditLog.performedAt, auditLog.id, cursor);
  if (cursorClause) filterClauses.push(cursorClause);
  const whereClause = filterClauses.length > 0 ? and(...filterClauses) : undefined;

  // Fetch limit+1 to detect hasMore.
  const rawEntries = await db
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      approvalRequestId: auditLog.approvalRequestId,
      targetUserId: auditLog.targetUserId,
      performedAt: auditLog.performedAt,
      payload: auditLog.payload,
    })
    .from(auditLog)
    .where(whereClause)
    .orderBy(desc(auditLog.performedAt), desc(auditLog.id))
    .limit(AUDITORIA_PAGE_LIMIT + 1);

  const hasMore = rawEntries.length > AUDITORIA_PAGE_LIMIT;
  const entries = hasMore ? rawEntries.slice(0, AUDITORIA_PAGE_LIMIT) : rawEntries;

  // Actor names batch. actorUserId is nullable (ARCH-H, migration 0080): rows
  // whose actor was hard-deleted have NULL actor_user_id.
  const actorIds = Array.from(
    new Set(entries.map((e) => e.actorUserId).filter((id): id is string => id !== null)),
  );
  // Target display names + roles batch (C12) — only resolve when present.
  const targetIds = Array.from(
    new Set(entries.map((e) => e.targetUserId).filter((id): id is string => id !== null)),
  );
  // The selected actor may not be on this page (pagination) — the dropdown must
  // still show the selected name (C30). Membership is knowable from actorIds
  // alone, so this lookup can join the same parallel batch.
  const needSelectedActor = actorFilter !== null && !actorIds.includes(actorFilter);

  // T3.3: the three follow-up lookups are mutually independent — one round-trip
  // wave instead of the previous serial actor→target→extra sequence.
  const [actorRows, targetRows, selectedActorRows] = await Promise.all([
    actorIds.length > 0
      ? db
          .select({ id: profiles.id, displayName: profiles.displayName })
          .from(profiles)
          .where(inArray(profiles.id, actorIds))
      : Promise.resolve([]),
    targetIds.length > 0
      ? db
          .select({ id: profiles.id, displayName: profiles.displayName, role: profiles.role })
          .from(profiles)
          .where(inArray(profiles.id, targetIds))
      : Promise.resolve([]),
    needSelectedActor && actorFilter !== null
      ? db
          .select({ id: profiles.id, displayName: profiles.displayName })
          .from(profiles)
          .where(eq(profiles.id, actorFilter))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const namesById = new Map<string, string>();
  for (const r of actorRows) namesById.set(r.id, r.displayName);

  const targetsById = new Map<string, { displayName: string; href: string | null }>();
  for (const r of targetRows) {
    const info = buildTargetLinkInfo({ id: r.id, displayName: r.displayName, role: r.role });
    targetsById.set(r.id, { displayName: info.displayName, href: info.href });
  }

  const actorOptions: { id: string; name: string }[] = actorIds.map((id) => ({
    id,
    name: namesById.get(id) ?? "Desconocido",
  }));
  const [selectedActor] = selectedActorRows;
  if (selectedActor) {
    actorOptions.push({ id: selectedActor.id, name: selectedActor.displayName });
  }
  actorOptions.sort((a, b) => a.name.localeCompare(b.name, "es-AR"));

  return { entries, hasMore, namesById, targetsById, actorOptions };
}
