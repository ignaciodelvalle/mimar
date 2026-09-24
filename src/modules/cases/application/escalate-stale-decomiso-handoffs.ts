// Use-case: escalate custody_episode handoffs pending receiver acceptance >7d.
//
// Migrated from lib/case-closers/escalate-stale-decomiso-handoffs.ts.
// The lib file becomes a thin re-export shim (strangler pattern).
//
// Scan:
//   - caseKind = 'custody_episode'
//   - status = 'open'
//   - opened by an org with org_type = 'sanitary_authority' ← canonical discriminator
//   - receiverOrganizationId IS NOT NULL                    ← a handoff is in flight
//   - MAX(occurred_at) of 'custody_transfer_proposed' events < now - 7d
//
// The 7-day clock keys on the LATEST custody_transfer_proposed event's
// occurred_at so that a reassign (govt sends a new proposal to another
// receiver) resets the window. No new DB column is needed.
//
// Action:
//   Does NOT close the case (DC8 / §13.5: humans resolve).
//   Emits decomiso_handoff_stale notifications to:
//     (a) active members of the opener govt org (roles admin/coordinator)
//     (b) all active institutional admins
//
// Idempotency:
//   Checks whether a 'decomiso_handoff_stale' notification for the same
//   relatedCaseId was already inserted within the last 7 days. If yes,
//   skips — the case is still stale but recipients were already paged in
//   this window. Mirrors the single-threshold guard used by
//   escalate-stale-welfare-cases.ts.

import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { cases, db, notifications, organizationMemberships, organizations } from "@/db";
// The 7-day window is the case DOMAIN's rule, shared with the org landing's
// queue signal — see DECOMISO_HANDOFF_STALE_DAYS' own comment for why it lives
// in the pure module rather than here.
import { writeAuditLog } from "@/lib/infra/audit-log";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";
import { DECOMISO_HANDOFF_STALE_DAYS } from "@/src/modules/cases/domain/case-sla";

export interface EscalateStaleDecomisosOptions {
  now?: Date;
  /** Days a pending handoff may sit before escalation. Default 7 per DC8. */
  staleAfterDays?: number;
  /**
   * Ceiling on the raw scan (review 23 item 13). This finder post-filters in JS
   * (latest-proposal age), so a keyset cursor over the raw rows isn't safe; a
   * plain LIMIT bounds memory instead. Decomiso volume is low and the cron runs
   * once daily via /api/cron/daily (04:00 UTC / 01:00 ART), not every 12h — the
   * 24h accumulation window is what a per-run cap actually has to cover, and
   * decomiso volume stays low enough that 500 (the default) still is.
   */
  maxRawScan?: number;
}

export interface StaleDecomisoCandidateFull {
  id: string;
  publicCode: string;
  primaryPetId: string | null;
  openedByOrganizationId: string | null;
  receiverOrganizationId: string | null;
  govtOrgName: string;
  govtOrgId: string;
  /** ISO string of the latest custody_transfer_proposed event's occurred_at. */
  latestProposalAt: string | null;
  /** Only read when the fan-out reaches nobody — see the trace below. */
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
}

// ---------------------------------------------------------------------------
// findStaleDecomisoCandidates
// ---------------------------------------------------------------------------
// Returns custody_episode cases whose latest proposal event is older than
// staleAfterDays. The correlated sub-select computes MAX(occurred_at) over
// custody_transfer_proposed events for each case; cases with no such event
// return NULL and are excluded in the in-process filter below.
export async function findStaleDecomisoCandidates(
  options?: EscalateStaleDecomisosOptions,
): Promise<StaleDecomisoCandidateFull[]> {
  const now = options?.now ?? new Date();
  const staleAfterMs =
    (options?.staleAfterDays ?? DECOMISO_HANDOFF_STALE_DAYS) * 24 * 60 * 60 * 1000;
  const staleBefore = new Date(now.getTime() - staleAfterMs);

  const rows = await db
    .select({
      id: cases.id,
      publicCode: cases.publicCode,
      primaryPetId: cases.primaryPetId,
      openedByOrganizationId: cases.openedByOrganizationId,
      receiverOrganizationId: cases.receiverOrganizationId,
      govtOrgName: organizations.displayName,
      govtOrgId: organizations.id,
      // Carried for the empty-fan-out trace only, so this escalation's evidence
      // has the same shape as its two siblings and a future digest can group
      // all three by jurisdiction instead of special-casing this one.
      jurisdictionProvince: cases.jurisdictionProvince,
      jurisdictionLocality: cases.jurisdictionLocality,
      latestProposalAt: sql<string | null>`(
        SELECT MAX(pe.occurred_at)::text
        FROM pet_events pe
        WHERE pe.case_id = ${cases.id}
          AND pe.event_type = 'custody_transfer_proposed'
      )`.as("latest_proposal_at"),
    })
    .from(cases)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, cases.openedByOrganizationId),
        eq(organizations.orgType, "sanitary_authority"),
      ),
    )
    .where(
      and(
        eq(cases.caseKind, "custody_episode"),
        eq(cases.status, "open"),
        isNotNull(cases.receiverOrganizationId),
      ),
    )
    .orderBy(asc(cases.id))
    .limit(options?.maxRawScan ?? 500);

  // Filter: keep only rows where the latest proposal predates the stale threshold.
  // Done in JS to avoid a complex HAVING/WHERE on a correlated sub-select column.
  return rows.filter((r): r is StaleDecomisoCandidateFull => {
    if (!r.latestProposalAt) return false;
    return new Date(r.latestProposalAt) < staleBefore;
  });
}

// ---------------------------------------------------------------------------
// escalateStaleDecomiso
// ---------------------------------------------------------------------------
// Emits decomiso_handoff_stale notifications. Idempotent: skips cases that
// were already notified within the last 7 days.
export async function escalateStaleDecomiso(
  candidate: StaleDecomisoCandidateFull,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Idempotency check: a stale notification for this case in the last 7 days.
  const [existingNotif] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.notificationType, "decomiso_handoff_stale"),
        eq(notifications.relatedCaseId, candidate.id),
        gt(notifications.createdAt, sevenDaysAgo),
      ),
    )
    .limit(1);

  if (existingNotif) return; // already notified this window

  // Govt org members (admin + coordinator role, not departed).
  const govtMembers = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, candidate.govtOrgId),
        inArray(organizationMemberships.role, ["admin", "coordinator"]),
        isNull(organizationMemberships.leftAt),
      ),
    );

  // Shared predicate (2026-08-17). The comment this replaces said "same query
  // as escalate-stale-disputes.ts" — and it WAS the same query, including the
  // same missing clause: a service account satisfies every predicate here, so
  // it landed in the recipient list and made it non-empty.
  const adminIds = await activeHumanInstitutionalAdminIds();

  const recipientSet = new Set<string>([...govtMembers.map((m) => m.userId), ...adminIds]);
  const recipients = Array.from(recipientSet);

  if (recipients.length === 0) {
    // Was a bare `return`. Its two siblings (escalate-stale-disputes and
    // escalate-stale-welfare-cases) both write this trace; this one did not, so
    // a decomiso handoff stalled past 7 days could escalate to nobody and leave
    // no record of it in any surface. An escalation nobody heard is not an
    // escalation, and there is no worklist that would surface it later.
    await writeAuditLog(db, {
      action: "notification_fanout_empty",
      actorUserId: null,
      payload: {
        route: "decomiso_handoff_stale",
        province: candidate.jurisdictionProvince ?? "",
        locality: candidate.jurisdictionLocality ?? "",
        reason: "no_govt_no_admin",
        case_id: candidate.id,
        case_public_code: candidate.publicCode,
      },
    });
    return;
  }

  await db.insert(notifications).values(
    recipients.map((userId) => ({
      userId,
      notificationType: "decomiso_handoff_stale" as const,
      severity: "warning" as const,
      title: "Decomiso sin refugio receptor por >7 días",
      body: `La propuesta de handoff del caso ${candidate.publicCode} (${candidate.govtOrgName}) lleva más de 7 días sin respuesta. Reasignar a otro refugio o mantener en custodia oficial.`,
      ctaLabel: "Ver caso",
      ctaUrl: `/casos/${candidate.publicCode}`,
      relatedCaseId: candidate.id,
      relatedPetId: candidate.primaryPetId,
      category: "custody",
    })),
  );
}
