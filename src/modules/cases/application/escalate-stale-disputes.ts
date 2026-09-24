// Use-case: escalate custody_dispute cases open for >365 days.
//
// Migrated from lib/case-closers/escalate-stale-disputes.ts.
// The lib file becomes a thin re-export shim (strangler pattern).
//
// Scan: custody_dispute cases with status='open', opened_at < now-365d.
// Process: resolve recipients = findAuthoritiesForJurisdiction(prov, loc)
// ∪ institutional admins (role=admin, accountType=institutional);
// in ONE tx — UPDATE status='escalated' (guarded AND status='open');
// if 0 rows → return (anti-race); if recipients > 0 → insert notifications,
// else write the notification_fanout_empty trace (an escalation nobody heard is
// not an escalation, and `escalated` has no worklist of its own).
//
// Does NOT close the case (legal disputes can run for years).
// Auth: none (system-initiated cron). No user authz inside.

import { and, asc, eq, gt, lt } from "drizzle-orm";

import { cases, db, notifications } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";

export interface EscalateStaleDisputesOptions {
  now?: Date;
  /** Days a dispute must be open before escalating. Default 365. */
  staleAfterDays?: number;
  /** Keyset cursor: only return cases whose id sorts after this value. */
  afterId?: string | null;
  /** Max rows to return (keyset page size). Omit for no limit. */
  limit?: number;
}

export interface StaleDisputeCandidate {
  id: string;
  publicCode: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
}

export async function findStaleDisputes(
  options?: EscalateStaleDisputesOptions,
): Promise<StaleDisputeCandidate[]> {
  const now = options?.now ?? new Date();
  const staleAfterMs = (options?.staleAfterDays ?? 365) * 24 * 60 * 60 * 1000;
  const openedBefore = new Date(now.getTime() - staleAfterMs);

  const base = db
    .select({
      id: cases.id,
      publicCode: cases.publicCode,
      jurisdictionProvince: cases.jurisdictionProvince,
      jurisdictionLocality: cases.jurisdictionLocality,
    })
    .from(cases)
    .where(
      and(
        eq(cases.caseKind, "custody_dispute"),
        eq(cases.status, "open"),
        lt(cases.openedAt, openedBefore),
        ...(options?.afterId ? [gt(cases.id, options.afterId)] : []),
      ),
    )
    .orderBy(asc(cases.id));

  const rows = options?.limit ? await base.limit(options.limit) : await base;

  return rows;
}

export async function escalateStaleDispute(
  candidate: StaleDisputeCandidate,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  // Null jurisdiction is coerced, not skipped (2026-08-17) — the guard this
  // replaces never called the resolver, so its admin fallback never ran.
  const govtAuthorities = await findAuthoritiesForJurisdiction(
    {
      province: candidate.jurisdictionProvince ?? "",
      locality: candidate.jurisdictionLocality ?? "",
    },
    { route: "custody_dispute_stale" },
  );

  // Shared predicate (2026-08-17). This was a hand-rolled copy that filtered
  // role and accountType ONLY — it counted DEACTIVATED administrators and
  // SERVICE ACCOUNTS as people who had been told. Either one makes the
  // recipient set non-empty, which silently skips the empty-fan-out trace
  // below: a 365-day-stale custody dispute could escalate to nobody and leave
  // no evidence anywhere that it had.
  const adminIds = await activeHumanInstitutionalAdminIds();

  const recipientSet = new Set<string>([...govtAuthorities, ...adminIds]);
  const recipients = Array.from(recipientSet);

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(cases)
      .set({ status: "escalated", updatedAt: now })
      .where(and(eq(cases.id, candidate.id), eq(cases.status, "open")))
      .returning({ id: cases.id });
    if (updated.length === 0) return;

    if (recipients.length === 0) {
      // The dispute IS now `escalated` and nobody was told. This recipient set is
      // assembled here (govt ∪ every institutional admin), not by the resolver,
      // so the resolver's own trace does not cover it — write our own.
      await writeAuditLog(tx, {
        action: "notification_fanout_empty",
        actorUserId: null,
        payload: {
          route: "custody_dispute_stale",
          province: candidate.jurisdictionProvince ?? "",
          locality: candidate.jurisdictionLocality ?? "",
          reason: "no_govt_no_admin",
          case_id: candidate.id,
          case_public_code: candidate.publicCode,
        },
      });
      return;
    }

    await tx.insert(notifications).values(
      recipients.map((userId) => ({
        userId,
        notificationType: "custody_dispute_stale" as const,
        severity: "warning" as const,
        title: "Disputa de custodia >1 año",
        body: `La disputa ${candidate.publicCode} lleva más de 365 días abierta. Considerar follow-up con la autoridad legal interviniente.`,
        ctaLabel: "Ver caso",
        ctaUrl: `/casos/${candidate.publicCode}`,
        relatedCaseId: candidate.id,
      })),
    );
  });
}
