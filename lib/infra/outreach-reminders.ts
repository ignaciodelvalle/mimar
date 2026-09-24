// Outreach "Enviar recordatorio(s)" — PO-approved, privacy-by-design write
// action for the overdue-antirrábica pipeline on /gob/operativos?vista=alcance
// (sweep-fixes-2 2026-07-23).
//
// DESIGN
// ------
// The government/admin operator NEVER sees owner contact data — this module
// resolves the pet's current owner(s) internally and routes through the SAME
// notification machinery the vaccine_due cron uses (lib/infra/notifications.ts
// runVaccineDueScan), so the owner receives the SAME kind of reminder they
// would from the automated sweep, not a new notification class:
//   - notificationType: "vaccine_due" (so it buckets under the "Salud" tab and
//     the notification history like every other vaccine reminder)
//   - category: "health", severity: "urgent" (these are, by definition,
//     already overdue)
//
// The cron's own throttle (checkThrottle in notifications.ts) is keyed by
// relatedReminderId and has per-variant escalating windows — it does not
// apply here because this pipeline's overdue list is derived directly from
// pet_events (fetchOverdueRabiesVaccine), not from the `reminders` table: many
// of these pets have no reminder row to key off at all. Anti-spam instead
// uses a flat OUTREACH_REMINDER_THROTTLE_DAYS window read from
// notifications history (notificationType LIKE 'vaccine_%', same pet+owner) —
// 14 days, matching the existing 14-day precedent already established in this
// codebase for a very similar "don't re-notify too soon" gate
// (POST_ADOPTION_MISSED_GRACE_DAYS in lib/infra/notifications.ts) and inside
// the cron's own overdue-variant escalation (its "first 14 days" threshold).
//
// AUTHZ: every petId the caller passes is RE-VALIDATED against the operator's
// jurisdiction scope AND the overdue criterion via fetchOverdueRabiesVaccine's
// petIdsFilter — never trust the client's list. A petId that falls outside
// scope (or is no longer actually overdue) is reported back as "out of scope"
// and never notified.
//
// AUDIT: one audit_log row per invocation (single "Recordar" or bulk "Enviar
// recordatorios (N)") via logOutreachReminderSent — (actor, pipeline, counts),
// mirroring logOutreachPiiQuery's read-path row.

import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { db, notifications, ownerships } from "@/db";
import { createNotification } from "@/lib/infra/notification-service";
import { fetchOverdueRabiesVaccine, logOutreachReminderSent } from "@/lib/infra/outreach-pipelines";
import type { ProjectionContext } from "@/lib/metrics";
import { formatDiasAgo } from "@/lib/utils/format";

/**
 * Anti-spam window: an owner who already received a vaccine reminder
 * (notificationType LIKE 'vaccine_%') for THIS pet within the last N days is
 * skipped — "ya avisado esta quincena" — rather than re-notified. See the
 * module docblock for why 14 was chosen (reused convention, not arbitrary).
 */
export const OUTREACH_REMINDER_THROTTLE_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `delivery_failed` exists because folding it into `already_notified` told the
 * operator the calmest possible thing about the worst possible outcome.
 *
 * createNotification has three results: inserted, duplicate, dead_lettered. This
 * pipeline used to treat only `inserted` as delivery and bucket the other two
 * together as "Ya avisado esta quincena". But the 14-day throttle above has
 * already excluded every pet that genuinely was notified recently, and the
 * dedupe key is day-bucketed per owner, so by the time the insert runs
 * `duplicate` is all but unreachable: in practice the only way to miss
 * `inserted` is that the write threw and the payload went to the dead-letter
 * queue. The operator saw muted grey, moved on, and the audit row recorded the
 * citizen as already reminded when no notification ever existed. For an overdue
 * rabies campaign that is a compliance record asserting something that did not
 * happen.
 *
 * The house already has the honest pattern: deliver-decomiso-notifications.ts
 * tells the operator "no se pudieron entregar ... Avisá por otra vía". Outreach
 * was the outlier.
 */
export type OutreachReminderOutcome =
  | "sent"
  | "already_notified"
  | "delivery_failed"
  | "no_owner"
  | "out_of_scope";

export type OutreachReminderPetResult = {
  petId: string;
  outcome: OutreachReminderOutcome;
};

export type OutreachReminderBulkResult = {
  results: OutreachReminderPetResult[];
  sentCount: number;
  alreadyNotifiedCount: number;
  deliveryFailedCount: number;
  noOwnerCount: number;
  outOfScopeCount: number;
};

function overdueRabiesReminderBody(petName: string, lastVaccineAt: Date, now: Date): string {
  if (lastVaccineAt.getTime() === 0) {
    return `${petName} nunca tiene registrada la vacuna antirrábica obligatoria.`;
  }
  const daysSince = Math.round((now.getTime() - lastVaccineAt.getTime()) / MS_PER_DAY);
  return `${petName} tiene la vacuna antirrábica obligatoria vencida ${formatDiasAgo(daysSince)}.`;
}

/**
 * Send (or honestly skip) a system-mediated vaccine_due reminder for each
 * requested pet, on behalf of an operator viewing the overdue-antirrábica
 * outreach pipeline. Used for BOTH the per-row "Recordar" action (a single
 * petId) and the bulk "Enviar recordatorios (N)" action (the visible list) —
 * same function, same audit convention, so the two surfaces can never drift.
 *
 * Never throws for a bad/out-of-scope petId — it reports "out_of_scope" and
 * continues with the rest of the batch (same partial-success posture as
 * createNotificationsBulk).
 */
export async function sendOverdueRabiesReminders(
  actorUserId: string,
  ctx: ProjectionContext,
  requestedPetIds: string[],
): Promise<OutreachReminderBulkResult> {
  const dedupedIds = [...new Set(requestedPetIds)];
  const results: OutreachReminderPetResult[] = [];

  if (dedupedIds.length === 0) {
    return {
      results: [],
      sentCount: 0,
      alreadyNotifiedCount: 0,
      deliveryFailedCount: 0,
      noOwnerCount: 0,
      outOfScopeCount: 0,
    };
  }

  // Server-side re-derivation (AUTHZ): re-run the SAME scope+overdue query the
  // list itself uses, filtered to exactly the requested ids. Anything that
  // doesn't come back is either out of the operator's jurisdiction or no
  // longer actually overdue — either way, not this operator's to notify.
  const { pets: validPets } = await fetchOverdueRabiesVaccine(ctx, dedupedIds);
  const validById = new Map(validPets.map((p) => [p.petId, p]));

  const now = new Date();
  const throttleSince = new Date(now.getTime() - OUTREACH_REMINDER_THROTTLE_DAYS * MS_PER_DAY);
  const dayBucket = now.toISOString().slice(0, 10);

  for (const petId of dedupedIds) {
    const pet = validById.get(petId);
    if (!pet) {
      results.push({ petId, outcome: "out_of_scope" });
      continue;
    }

    // Resolve current PERSONAL owner(s) internally — the operator never sees
    // this. Matches the same ownership scope every other reminder read uses
    // (role='owner', ended_at IS NULL, ownerUserId IS NOT NULL — organization-
    // held custody is out of scope for a personal vaccine reminder).
    const owners = await db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "owner"),
          isNull(ownerships.endedAt),
          sql`${ownerships.ownerUserId} IS NOT NULL`,
        ),
      );

    if (owners.length === 0) {
      results.push({ petId, outcome: "no_owner" });
      continue;
    }

    // Pet-level throttle: if ANY current owner already got a vaccine reminder
    // for this pet within the window, the whole pet is reported as "already
    // notified" — a second co-owner getting a fresh notice while the first
    // was just pinged would defeat the anti-spam intent.
    const recentNotif = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.relatedPetId, petId),
          sql`${notifications.notificationType} LIKE 'vaccine_%'`,
          gte(notifications.createdAt, throttleSince),
        ),
      )
      .limit(1);

    if (recentNotif.length > 0) {
      results.push({ petId, outcome: "already_notified" });
      continue;
    }

    const body = overdueRabiesReminderBody(pet.petName, pet.lastVaccineAt, now);
    let deliveredAny = false;
    for (const owner of owners) {
      if (!owner.ownerUserId) continue;
      const res = await createNotification({
        userId: owner.ownerUserId,
        notificationType: "vaccine_due",
        category: "health",
        severity: "urgent",
        title: "Vacuna antirrábica vencida",
        body,
        relatedPetId: petId,
        ctaLabel: "Registrar vacuna",
        ctaUrl: `/mis-mascotas/${pet.publicToken}/eventos/nuevo/vacuna`,
        dedupeKey: `outreach-vaccine-due:${petId}:${owner.ownerUserId}:${dayBucket}`,
      });
      if (res.status === "inserted") deliveredAny = true;
    }
    // Reaching here without an insert means the write failed, not that somebody
    // was already told: the throttle above (`already_notified`, its own branch)
    // owns that case. Naming it `already_notified` here is what let a
    // dead-lettered reminder be reported as done.
    results.push({ petId, outcome: deliveredAny ? "sent" : "delivery_failed" });
  }

  const bulkResult: OutreachReminderBulkResult = {
    results,
    sentCount: results.filter((r) => r.outcome === "sent").length,
    alreadyNotifiedCount: results.filter((r) => r.outcome === "already_notified").length,
    deliveryFailedCount: results.filter((r) => r.outcome === "delivery_failed").length,
    noOwnerCount: results.filter((r) => r.outcome === "no_owner").length,
    outOfScopeCount: results.filter((r) => r.outcome === "out_of_scope").length,
  };

  await logOutreachReminderSent(actorUserId, "overdue_rabies", {
    requested: dedupedIds.length,
    sent: bulkResult.sentCount,
    alreadyNotified: bulkResult.alreadyNotifiedCount,
    deliveryFailed: bulkResult.deliveryFailedCount,
    noOwner: bulkResult.noOwnerCount,
    outOfScope: bulkResult.outOfScopeCount,
  });

  return bulkResult;
}
