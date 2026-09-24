// Centralized notification helpers. Today this hosts the vaccine_due
// scheduled-scan logic (AGENTS.md → Notifications, third creation source).
// The plan is to migrate the existing notification factories (welcome via
// handle_new_user trigger; ppp_registration_reminder from updatePetAction /
// createPetAction) through this module too, so every notification has one
// authoritative shape. v1 ships only the vaccine_due path.

import {
  db as defaultDb,
  notifications,
  organizationMemberships,
  organizations,
  petEvents,
  pets,
  reminders,
} from "@/db";
import { getReminderVariant, isVaccineReportable } from "@/lib/domain/vaccine-reminder-state";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { createNotification } from "@/lib/infra/notification-service";
import { buildReminderVaccineUrl } from "@/lib/ui/reminder-urls";
import { formatDiasAgo } from "@/lib/utils/format";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";

type DB = typeof defaultDb;

export type VaccineDueScanResult = {
  scannedAt: Date;
  insertedCount: number;
  insertedNotificationIds: string[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Days ahead window: include all reminders due within N days (upcoming
// variant, default 14). There is no backward limit — indefinitely overdue
// reminders are included (overdue / overdue_critical variants). Default
// tier of the `reminder_windows` business rule (admin-rules-console, design
// ADR-4 item 3) — this cron sweep scans ALL reminders globally with no
// per-pet jurisdiction context, so it resolves the window ONCE at sweep
// start, country-level only (resolveBusinessRule below), instead of once
// per reminder row (would be N DB round-trips in a hot cron — rejected on
// cost, per ADR-4). Kept as a fallback constant for callers/tests that
// don't go through the resolver path.
const WINDOW_AHEAD_DAYS = 14;

// Keyset page size + wall-clock budget for the reminder sweep (review 23 item
// 11). Bounds memory (never loads the whole global reminder set) and time
// (stays within Vercel's 60s function budget).
const VACCINE_SCAN_BATCH_SIZE = 500;
const VACCINE_SCAN_MAX_DURATION_MS = 45_000;

// Mismos límites para el barrido de check-ins post-adopción. Su fase 2 cargaba
// TODOS los candidatos vencidos sin limit, sin cursor y sin deadline, y hacía 3
// queries secuenciales por candidato — o sea la forma exacta del hermano de
// arriba antes de que lo endurecieran, y del bug que se arregló en b3d152a3:
// correcto por ítem, ruinoso por barrido.
//
// El contexto es lo que lo vuelve serio: los 22 crons corren en UNA función de
// Vercel (maxDuration 60s) vía el dispatcher `daily`, que chequea presupuesto
// ANTES de cada job pero no interrumpe uno en curso. Este es el puesto 5 de 22;
// detrás vienen los drains de entrega y la purga TTL de la Ley 25.326. Que este
// barrido se coma la función no lo rompe solo a él: se lleva puestos los 17
// jobs que siguen ese día.
const POST_ADOPTION_SCAN_BATCH_SIZE = 500;
const POST_ADOPTION_SCAN_MAX_DURATION_MS = 45_000;

/**
 * Scan for vaccine reminders and emit per-variant throttled `vaccine_due`
 * notifications. Replaces the old single-dedup approach with per-variant
 * cadence rules (Chunk C C2).
 *
 * Throttle rules per variant:
 *   upcoming        — once every 7 days.
 *   due_soon        — daily for the first 3 days since first notif, then every 3 days.
 *   overdue         — daily for the first 14 days since first notif, then weekly.
 *   overdue_critical — daily indefinitely.
 *
 * Dedupe key: `notifications.relatedReminderId = reminders.id` AND
 * `notifications.notificationType LIKE 'vaccine_%'` — archived rows COUNT
 * (archiving dismisses from the inbox; it doesn't reset the cadence).
 *
 * relatedEventId is NEVER set on these inserts: migration 0088's unique
 * index exempts cron notifications via related_event_id IS NULL so the
 * escalating cadence can emit repeatedly for the same source event
 * (projection-cron audit 2026-07-03 C1).
 *
 * Backward compat: pre-C2 notifications only have relatedEventId, so the new
 * throttle query (by relatedReminderId) sees notif_count=0 for existing
 * reminders on the first post-C2 run. This produces one extra notification
 * per active reminder — a one-time acceptable cost.
 *
 * Snoozed reminders (snoozedUntil > now) are excluded for the whole run.
 * Completed reminders (completedAt IS NOT NULL) are excluded.
 */
export async function runVaccineDueScan(
  dbInstance: DB = defaultDb,
  options?: { now?: Date; maxDurationMs?: number },
): Promise<VaccineDueScanResult> {
  const now = options?.now ?? new Date();
  // Country-level only — see the WINDOW_AHEAD_DAYS comment above (ADR-4 item 3).
  // Resolved against the caller's dbInstance so tests that inject a
  // transaction-scoped db see their own fixture rows, not the shared pool.
  const reminderWindowRule = await resolveBusinessRule(
    "reminder_windows",
    { country: "AR" },
    dbInstance,
  );
  const windowAheadDays = reminderWindowRule.payload.aheadDays;
  const windowEnd = new Date(now.getTime() + windowAheadDays * MS_PER_DAY);

  // RN #9 (2026-08-22): min(own ceiling, the share the daily dispatcher
  // handed the route). 45 s is safe for a route running ALONE; inside the
  // dispatcher the whole fleet shares one 60 s function under a 55 s budget
  // whose check only fires BETWEEN jobs, so a backlogged sweep here used to
  // take the function past its hard kill and every job behind it with it.
  const vaccineScanBudgetMs = Math.min(
    VACCINE_SCAN_MAX_DURATION_MS,
    options?.maxDurationMs ?? VACCINE_SCAN_MAX_DURATION_MS,
  );

  const insertedNotificationIds: string[] = [];

  // Keyset-batched sweep (review 23 item 11): the reminder scan used to load
  // the ENTIRE global vaccine-reminder set in one query and then run a per-row
  // history SELECT (N+1). Now paged over reminders.id with a wall-clock budget,
  // and the throttle history is fetched ONCE per batch (single grouped query).
  const start = Date.now();
  let cursor: string | null = null;

  for (;;) {
    if (Date.now() - start >= vaccineScanBudgetMs) break;

    // Fetch a page of active, non-snoozed vaccine reminders within the window.
    // No backward limit — overdue reminders are included indefinitely.
    const candidates = await dbInstance
      .select({
        reminderId: reminders.id,
        userId: reminders.userId,
        petId: reminders.petId,
        sourceEventId: reminders.sourceEventId,
        dueAt: reminders.dueAt,
        title: reminders.title,
        description: reminders.description,
        petName: pets.name,
        petSpecies: pets.species,
        petJurisdictionLocality: pets.jurisdictionLocality,
        publicToken: pets.publicToken,
      })
      .from(reminders)
      .innerJoin(pets, eq(pets.id, reminders.petId))
      .where(
        and(
          eq(reminders.reminderType, "vaccine"),
          isNull(reminders.completedAt),
          // snoozed_until IS NULL OR snoozed_until <= now
          sql`(${reminders.snoozedUntil} IS NULL OR ${reminders.snoozedUntil} <= ${sql.param(now.toISOString())}::timestamptz)`,
          lte(reminders.dueAt, windowEnd),
          ...(cursor ? [gt(reminders.id, cursor)] : []),
        ),
      )
      .orderBy(asc(reminders.id))
      .limit(VACCINE_SCAN_BATCH_SIZE);

    if (candidates.length === 0) break;

    // Batched throttle-history fetch (fixes the N+1): one grouped query for the
    // whole page instead of one SELECT per reminder. Archived rows COUNT toward
    // the throttle — archiving dismisses from the inbox, it does not consent to
    // being re-notified at full frequency (projection-cron audit C2).
    const reminderIds = candidates.map((c) => c.reminderId);
    const historyRows = await dbInstance
      .select({
        reminderId: notifications.relatedReminderId,
        firstAt: sql<Date | null>`MIN(${notifications.createdAt})`,
        lastAt: sql<Date | null>`MAX(${notifications.createdAt})`,
        notifCount: sql<string>`COUNT(*)::text`,
        // Prior PUSH-ELIGIBLE (urgent) notifications for this reminder. The
        // push suppression keys on THIS, not notifCount: notifCount counts all
        // variants (upcoming/due_soon included), so a vaccine that reached
        // overdue via the normal due_soon path would have notifCount>0 and its
        // FIRST overdue push — the meaningful escalation — would be wrongly
        // suppressed. urgentCount=0 means no urgent has fired yet → push.
        urgentCount: sql<string>`COUNT(*) FILTER (WHERE ${notifications.severity} = 'urgent')::text`,
      })
      .from(notifications)
      .where(
        and(
          inArray(notifications.relatedReminderId, reminderIds),
          sql`${notifications.notificationType} LIKE 'vaccine_%'`,
        ),
      )
      .groupBy(notifications.relatedReminderId);

    const historyMap = new Map(historyRows.map((h) => [h.reminderId, h]));

    for (const row of candidates) {
      cursor = row.reminderId;

      const dueMs = new Date(row.dueAt).getTime() - now.getTime();
      // daysUntilDue: positive = future, negative = past
      const daysUntilDue = Math.round(dueMs / MS_PER_DAY);

      const isReportable = isVaccineReportable(
        row.title,
        row.petSpecies ?? "",
        row.petJurisdictionLocality ?? "",
      );
      const variant = getReminderVariant(daysUntilDue, isReportable);

      const history = historyMap.get(row.reminderId);
      const notifCount = history ? Number.parseInt(history.notifCount ?? "0", 10) : 0;
      const urgentCount = history ? Number.parseInt(history.urgentCount ?? "0", 10) : 0;
      const firstAt = history?.firstAt ? new Date(history.firstAt) : null;
      const lastAt = history?.lastAt ? new Date(history.lastAt) : null;

      // Evaluate per-variant throttle gate.
      const shouldEmit = checkThrottle({ variant, notifCount, firstAt, lastAt, now });
      if (!shouldEmit) continue;

      // Build notification body per variant.
      const body = buildBody(variant, row.petName, Math.abs(daysUntilDue), daysUntilDue);

      // Severity per variant.
      const severity =
        variant === "upcoming"
          ? ("info" as const)
          : variant === "due_soon"
            ? ("warning" as const)
            : ("urgent" as const); // overdue + overdue_critical

      // Route through the canonical write path. The dedupe key is scoped to the
      // reminder + the scan's day bucket: it does NOT suppress the legitimate
      // escalating cadence (a scan on a LATER day gets a new bucket → new key →
      // emits), but it DOES collapse two concurrent runs on the same day for the
      // same reminder into one row — closing the check-then-act throttle race
      // (review B.2) that the per-reminder history read + separate INSERT left
      // open. relatedEventId stays NULL (migration 0088 exemption still applies).
      const dayBucket = now.toISOString().slice(0, 10);
      const result = await createNotification(
        {
          userId: row.userId,
          notificationType: "vaccine_due",
          category: "health",
          title: row.title,
          body,
          severity,
          relatedPetId: row.petId,
          // relatedReminderId drives the throttle read above.
          relatedReminderId: row.reminderId,
          // 14.2 notice→action contract: deep-link directly to the vaccination
          // form so the owner can act in one tap. Canonical reminder-linked
          // target (flow audit 2026-07-03): the FULL form with reminderId, so
          // the vaccine name pre-fills and the reminder closes on submit.
          ctaLabel: "Registrar vacuna",
          ctaUrl: buildReminderVaccineUrl(row.publicToken, row.reminderId),
          dedupeKey: `vaccine:${row.reminderId}:${dayBucket}`,
          // Push the FIRST time this reminder reaches a push-eligible (urgent)
          // state — that escalation is news. Suppress every later urgent
          // re-emit, notably overdue_critical, which re-fires daily and would
          // otherwise push at 01:00 ART (native-readiness RN-3 F5). Keyed on
          // urgentCount (prior URGENT notifications), NOT notifCount: a vaccine
          // that reached overdue via due_soon already has notifCount>0, so
          // keying on that would wrongly suppress its first overdue push.
          // Non-urgent variants never push regardless, so this value only
          // matters when the current variant is urgent.
          suppressPush: urgentCount > 0,
        },
        dbInstance,
      );
      if (result.status === "inserted" && result.id) insertedNotificationIds.push(result.id);
    }

    if (candidates.length < VACCINE_SCAN_BATCH_SIZE) break; // drained
  }

  return {
    scannedAt: now,
    insertedCount: insertedNotificationIds.length,
    insertedNotificationIds,
  };
}

// ---------------------------------------------------------------------------
// Throttle helpers
// ---------------------------------------------------------------------------

type ThrottleInput = {
  variant: ReturnType<typeof getReminderVariant>;
  notifCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
  now: Date;
};

/**
 * Returns true when the throttle gate allows a new notification.
 *
 * Per-variant rules:
 *   upcoming        — emit if notifCount=0 OR lastAt < now - 7d.
 *   due_soon        — emit if notifCount=0.
 *                     Else if first notif < 3d ago  → require lastAt < now - 1d.
 *                     Else                          → require lastAt < now - 3d.
 *   overdue         — emit if notifCount=0.
 *                     Else if first notif < 14d ago → require lastAt < now - 1d.
 *                     Else                          → require lastAt < now - 7d.
 *   overdue_critical — emit if notifCount=0 OR lastAt < now - 1d.
 */
function checkThrottle({ variant, notifCount, firstAt, lastAt, now }: ThrottleInput): boolean {
  if (notifCount === 0) return true; // always emit on first notification

  // lastAt must be non-null when notifCount > 0, but guard defensively.
  if (!lastAt) return true;

  const msSinceLast = now.getTime() - lastAt.getTime();

  if (variant === "upcoming") {
    return msSinceLast >= 7 * MS_PER_DAY;
  }

  if (variant === "overdue_critical") {
    return msSinceLast >= MS_PER_DAY;
  }

  if (variant === "due_soon") {
    const msSinceFirst = firstAt ? now.getTime() - firstAt.getTime() : Number.POSITIVE_INFINITY;
    const minInterval = msSinceFirst < 3 * MS_PER_DAY ? MS_PER_DAY : 3 * MS_PER_DAY;
    return msSinceLast >= minInterval;
  }

  if (variant === "overdue") {
    const msSinceFirst = firstAt ? now.getTime() - firstAt.getTime() : Number.POSITIVE_INFINITY;
    const minInterval = msSinceFirst < 14 * MS_PER_DAY ? MS_PER_DAY : 7 * MS_PER_DAY;
    return msSinceLast >= minInterval;
  }

  // success variant — should never reach here (completedAt filters them out)
  return false;
}

// ---------------------------------------------------------------------------
// Body copy per variant
// ---------------------------------------------------------------------------

function buildBody(
  variant: ReturnType<typeof getReminderVariant>,
  petName: string,
  absDays: number,
  daysUntilDue: number,
): string {
  if (variant === "upcoming" || variant === "due_soon") {
    if (daysUntilDue <= 0) return `${petName} tiene una vacuna programada para hoy.`;
    if (daysUntilDue === 1) return `${petName} tiene una vacuna programada para mañana.`;
    return `${petName} tiene una vacuna programada en ${daysUntilDue} días.`;
  }
  if (variant === "overdue_critical") {
    if (absDays === 0) return `${petName} tiene una vacuna obligatoria programada para hoy.`;
    return `${petName} tiene una vacuna obligatoria vencida ${formatDiasAgo(absDays)}.`;
  }
  // overdue
  if (absDays === 0) return `${petName} tiene una vacuna programada para hoy.`;
  return `${petName} tiene una vacuna vencida ${formatDiasAgo(absDays)}.`;
}

// ---------------------------------------------------------------------------
// Post-adoption check-in scan
// ---------------------------------------------------------------------------

// Grace period after dueAt before phase 2 (missed-window fanout to refugio)
// fires. Gives the adopter a window to act between the proactive reminder
// (phase 1) and the refugio being told they ghosted. AGENTS.md
// → Custody & adoption requires both notifications; the grace keeps them
// from racing each other on the same calendar day the reminder is due.
const POST_ADOPTION_MISSED_GRACE_DAYS = 14;

export type PostAdoptionCheckinScanResult = {
  scannedAt: Date;
  proactiveInsertedIds: string[];
  missedInsertedIds: string[];
};

/**
 * Two-phase scan for post-adoption check-in reminders. Inverse of the vaccine
 * pattern: instead of firing when an event IS due, this fires when the
 * adopter's self-reported `post_adoption_checkin` event is MISSING by the
 * reminder's dueAt + grace.
 *
 * Phase 1 (proactive): reminders coming due in the next 7d (with 1d backward
 * grace) → notify the adopter. Dedupe per-reminder via
 * `notifications.relatedReminderId`.
 *
 * Phase 2 (missed-window fanout): reminders past dueAt + grace, still open,
 * with no `post_adoption_checkin` event recorded on the pet since the
 * adoption_finalized event → fan out to refugio admins of the originating
 * org. Dedupe per-reminder via `notifications.relatedReminderId`.
 */
export async function runPostAdoptionCheckinScan(
  dbInstance: DB = defaultDb,
  options?: { now?: Date; maxDurationMs?: number },
): Promise<PostAdoptionCheckinScanResult> {
  const now = options?.now ?? new Date();
  const proactiveWindowEnd = new Date(now.getTime() + 7 * MS_PER_DAY);
  const proactiveWindowStart = new Date(now.getTime() - MS_PER_DAY);
  const missedThreshold = new Date(now.getTime() - POST_ADOPTION_MISSED_GRACE_DAYS * MS_PER_DAY);

  // --- Phase 1: proactive reminders to adopters ---
  const proactiveCandidates = await dbInstance
    .select({
      reminderId: reminders.id,
      userId: reminders.userId,
      petId: reminders.petId,
      dueAt: reminders.dueAt,
      title: reminders.title,
      petName: pets.name,
      publicToken: pets.publicToken,
    })
    .from(reminders)
    .innerJoin(pets, eq(pets.id, reminders.petId))
    .where(
      and(
        eq(reminders.reminderType, "post_adoption_checkin"),
        isNull(reminders.completedAt),
        gte(reminders.dueAt, proactiveWindowStart),
        lte(reminders.dueAt, proactiveWindowEnd),
        sql`NOT EXISTS (
          SELECT 1 FROM ${notifications} n
          WHERE n.related_reminder_id = ${reminders.id}
            AND n.notification_type = 'post_adoption_checkin_due'
        )`,
      ),
    );

  const proactiveInsertedIds: string[] = [];
  for (const row of proactiveCandidates) {
    const dueMs = new Date(row.dueAt).getTime() - now.getTime();
    const daysAhead = Math.round(dueMs / MS_PER_DAY);
    const body =
      daysAhead <= 0
        ? `Toca registrar el check-in post-adopción de ${row.petName}.`
        : daysAhead === 1
          ? `Mañana toca el check-in post-adopción de ${row.petName}.`
          : `En ${daysAhead} días toca el check-in post-adopción de ${row.petName}.`;
    // Canonical write path. dedupeKey is per-reminder (one proactive due
    // notification per reminder, ever) — matches the NOT EXISTS guard above and
    // adds dead-letter durability.
    const result = await createNotification(
      {
        userId: row.userId,
        notificationType: "post_adoption_checkin_due",
        title: row.title,
        body,
        severity: "info",
        relatedPetId: row.petId,
        relatedReminderId: row.reminderId,
        ctaLabel: "Hacer check-in",
        ctaUrl: `/mis-mascotas/${row.publicToken}/eventos/nuevo/checkin`,
        dedupeKey: `post-adoption-due:${row.reminderId}`,
      },
      dbInstance,
    );
    if (result.status === "inserted" && result.id) proactiveInsertedIds.push(result.id);
  }

  // --- Phase 2: missed-window fanout to refugio admins ---
  // A reminder is "missed" when:
  //   (a) dueAt < now - grace, AND
  //   (b) it is not completed (adopter never marked it done), AND
  //   (c) no post_adoption_checkin event has been recorded on the pet AFTER
  //       the reminder was created (the absence is the signal).
  //
  // The condition on petEvents looks across ALL post_adoption_checkin events
  // for the pet, not just by adopter — extending later to second-adopter
  // edge cases (re-adoption) would be a separate slice. (c) uses
  // reminders.created_at as the "since" anchor, not dueAt, so a check-in
  // that arrived a few days before the dueAt still counts as fulfilling
  // the obligation.
  const missedInsertedIds: string[] = [];
  const missedStart = Date.now();
  // RN #9 (2026-08-22): min(own ceiling, the share the daily dispatcher
  // handed the route). 45 s is safe for a route running ALONE; inside the
  // dispatcher the whole fleet shares one 60 s function under a 55 s budget
  // whose check only fires BETWEEN jobs, so a backlogged sweep here used to
  // take the function past its hard kill and every job behind it with it.
  const postAdoptionScanBudgetMs = Math.min(
    POST_ADOPTION_SCAN_MAX_DURATION_MS,
    options?.maxDurationMs ?? POST_ADOPTION_SCAN_MAX_DURATION_MS,
  );
  let missedCursor: string | null = null;

  for (;;) {
    if (Date.now() - missedStart >= postAdoptionScanBudgetMs) break;

    // El JOIN a petEvents reemplaza la primera de las tres queries por
    // candidato Y además saca del barrido, en el propio WHERE, a los que no
    // tienen organización de origen en el payload. Esos nunca insertaban nada,
    // así que el guard NOT EXISTS nunca los excluía: se re-escaneaban todos los
    // días para siempre. Filtrarlos acá los elimina del conjunto, no sólo del
    // trabajo.
    const missedCandidates = await dbInstance
      .select({
        reminderId: reminders.id,
        petId: reminders.petId,
        title: reminders.title,
        petName: pets.name,
        publicToken: pets.publicToken,
        orgId: sql<string>`(${petEvents.payload}->>'previous_owner_organization_id')`,
      })
      .from(reminders)
      .innerJoin(pets, eq(pets.id, reminders.petId))
      .innerJoin(petEvents, eq(petEvents.id, reminders.sourceEventId))
      .where(
        and(
          eq(reminders.reminderType, "post_adoption_checkin"),
          isNull(reminders.completedAt),
          isNotNull(reminders.sourceEventId),
          lt(reminders.dueAt, missedThreshold),
          sql`(${petEvents.payload}->>'previous_owner_organization_id') IS NOT NULL`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${petEvents} e
            WHERE e.pet_id = ${reminders.petId}
              AND e.event_type = 'post_adoption_checkin'
              AND e.recorded_at > ${reminders.createdAt}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${notifications} n
            WHERE n.related_reminder_id = ${reminders.id}
              AND n.notification_type = 'post_adoption_checkin_missed'
          )`,
          ...(missedCursor ? [gt(reminders.id, missedCursor)] : []),
        ),
      )
      .orderBy(asc(reminders.id))
      .limit(POST_ADOPTION_SCAN_BATCH_SIZE);

    if (missedCandidates.length === 0) break;

    // Los otros dos lookups, una vez por PÁGINA en vez de una vez por fila.
    const pageOrgIds = [...new Set(missedCandidates.map((r) => r.orgId))];

    const adminRows = await dbInstance
      .select({
        organizationId: organizationMemberships.organizationId,
        userId: organizationMemberships.userId,
      })
      .from(organizationMemberships)
      .where(
        and(
          inArray(organizationMemberships.organizationId, pageOrgIds),
          eq(organizationMemberships.role, "admin"),
          isNull(organizationMemberships.leftAt),
        ),
      );
    const adminsByOrg = new Map<string, string[]>();
    for (const a of adminRows) {
      const list = adminsByOrg.get(a.organizationId) ?? [];
      list.push(a.userId);
      adminsByOrg.set(a.organizationId, list);
    }

    const orgRows = await dbInstance
      .select({ id: organizations.id, publicToken: organizations.publicToken })
      .from(organizations)
      .where(inArray(organizations.id, pageOrgIds));
    const tokenByOrg = new Map(orgRows.map((o) => [o.id, o.publicToken]));

    for (const row of missedCandidates) {
      const admins = adminsByOrg.get(row.orgId) ?? [];
      // Una org sin admin activo se vuelve a escanear mañana, y eso es
      // DELIBERADO: si mañana suma un admin, queremos avisarle. Es trabajo
      // repetido acotado por el keyset, no un conjunto atascado que crece.
      if (admins.length === 0) continue;

      const publicToken = tokenByOrg.get(row.orgId);

      // Canonical write path, one row per refugio admin. dedupeKey is
      // per-(reminder, admin) — matches the NOT EXISTS guard above and makes a
      // re-run idempotent. Low fan-out (org admins), so per-row is fine here.
      for (const userId of admins) {
        const result = await createNotification(
          {
            userId,
            notificationType: "post_adoption_checkin_missed",
            title: `Check-in pendiente: ${row.petName}`,
            body: `El adoptante de ${row.petName} no envió el seguimiento esperado. Considerá ponerte en contacto.`,
            severity: "warning",
            relatedPetId: row.petId,
            relatedReminderId: row.reminderId,
            ctaLabel: "Ver mascota",
            ctaUrl: publicToken ? `/org/${publicToken}/mascotas` : "/org",
            dedupeKey: `post-adoption-missed:${row.reminderId}:${userId}`,
          },
          dbInstance,
        );
        if (result.status === "inserted" && result.id) missedInsertedIds.push(result.id);
      }
    }

    missedCursor = missedCandidates[missedCandidates.length - 1].reminderId;
    if (missedCandidates.length < POST_ADOPTION_SCAN_BATCH_SIZE) break; // drained
  }

  return {
    scannedAt: now,
    proactiveInsertedIds,
    missedInsertedIds,
  };
}
