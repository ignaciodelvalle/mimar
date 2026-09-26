// SurveillanceRepository — thin Drizzle wrapper for surveillance domain writes + reads.
//
// Design decisions:
//   - All write methods accept an optional `executor` param (DbOrTx) to
//     support both top-level calls and participation in a db.transaction().
//   - Reuses insertEventIdempotent from lib/event-idempotency for owner-bite path.
//   - autoExpireBiteCase uses a DIRECT cases UPDATE (closed_reason='auto_expired'),
//     NOT closeCase('resolved') — this is the load-bearing parity quirk (spec §E).
//   - ENO queue onConflictDoNothing on pet_event_id — returns null on no-op.
//   - ENO retry: markEnoFailed increments retryCount; sets status='failed' at >=2.
//   - Case ops (openCase, closeCase, escalateCase) route through CasesRepository
//     injected by the caller or use-case layer.
//   - No auth logic — auth lives at the action / use-case edge.
//   - Returns Drizzle row shapes ($inferSelect) — callers type them directly.

import "server-only";

import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";

import {
  cases,
  db,
  enoProcessingQueue,
  govtAssignments,
  notifications,
  ownerships,
  petEvents,
  pets,
} from "@/db";
import type { NewPetEvent, PetEvent } from "@/db/schema";
import type { CoverageArea } from "@/lib/domain/org-coverage";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { enqueueOutboxForEvent } from "@/lib/events/event-outbox-enqueue";
import { overlayAmendments } from "@/lib/infra/amendment";
import { type AuditLogEntry, writeAuditLog } from "@/lib/infra/audit-log";
import { coverageDecisionMode, loadOrgCoverageAreas } from "@/lib/place/coverage";
import { OPEN_OBSERVATION_STATUSES, isRabiesVaccineName } from "../domain/rabies-observation";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

// Narrow projection shape for surveillance pet reads.
// Contains only the columns that surveillance use-cases actually consume:
//   id + publicToken — event/notification FK and logging
//   status — deceased guard in bite-report action
//   species — notification body text (report-bite / report-bite-from-org)
//   rabiesObservationStatus — in-progress guard, professional-close guard
//   jurisdictionProvince/Locality — scope check, authority notification fan-out
//   name — notification body text
export type SurveillancePet = {
  id: string;
  publicToken: string;
  name: string;
  species: string;
  status: string;
  rabiesObservationStatus: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

// Shape returned by ENO queue finds.
export type EnoQueueRow = typeof enoProcessingQueue.$inferSelect;

// ---------------------------------------------------------------------------
// SurveillanceRepository
// ---------------------------------------------------------------------------

export class SurveillanceRepository {
  // ===========================================================================
  // Pet reads
  // ===========================================================================

  /**
   * Find a pet by its publicToken. Returns a narrow surveillance projection when found, null otherwise.
   */
  async findPetByToken(publicToken: string): Promise<SurveillancePet | null> {
    const [row] = await db
      .select({
        id: pets.id,
        publicToken: pets.publicToken,
        name: pets.name,
        species: pets.species,
        status: pets.status,
        rabiesObservationStatus: pets.rabiesObservationStatus,
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
      })
      .from(pets)
      .where(eq(pets.publicToken, publicToken))
      .limit(1);
    return row ?? null;
  }

  // ===========================================================================
  // Rabies vaccine reads
  // ===========================================================================

  /**
   * Find the most recent vaccination_administered event for the given pet
   * whose CORRECTED vaccine_name names a rabies vaccine.
   *
   * Returns { occurredAt, payload } so the caller can pass it to the pure domain
   * predicate isRabiesVaccineValid without pulling the full event shape. The
   * payload is the corrected one: the answer is snapshotted into the
   * NON-amendable incident_reported payload (rabies_vaccine_valid_at_incident)
   * and into the authority's alert, so it has to read what the libreta shows.
   * Filtering by name in SQL read the RAW name: a dose corrected TO
   * "Antirrábica" was missed, one corrected AWAY from it still matched, and a
   * corrected next_due_at never reached the vigencia check. So the pet's
   * vaccinations and its event_amended rows are fetched together, overlaid,
   * and only then filtered — a pet's vaccination history is small.
   */
  async findLatestRabiesVaccineEvent(
    petId: string,
    executor: DbOrTx = db,
  ): Promise<{ id: string; occurredAt: Date; payload: Record<string, unknown> } | null> {
    const rows = await executor
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        recordedAt: petEvents.recordedAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          inArray(petEvents.eventType, ["vaccination_administered", "event_amended"]),
        ),
      )
      .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

    const overlaid = overlayAmendments(rows);
    let row: (typeof overlaid)[number] | undefined;
    for (let i = overlaid.length - 1; i >= 0; i--) {
      const e = overlaid[i];
      if (e.eventType !== "vaccination_administered") continue;
      if (isRabiesVaccineName((e.payload as Record<string, unknown>).vaccine_name)) {
        row = e;
        break;
      }
    }

    if (!row) return null;
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      payload: row.payload as Record<string, unknown>,
    };
  }

  // ===========================================================================
  // Rabies observation reads
  // ===========================================================================

  /**
   * Find the most recent rabies_observation_started event for the pet.
   * Returns the full event row (needed by use-cases to read observation_until
   * and bite_event_id from the payload).
   */
  async findLatestObservationStarted(
    petId: string,
    executor: DbOrTx = db,
  ): Promise<PetEvent | null> {
    const [row] = await executor
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "rabies_observation_started")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Check for any symptom_observed event during the observation period whose
   * payload.alerted_disease_codes @> '"rabies_suspected"'::jsonb.
   * Returns the first matching event (truthy) or null (none found).
   */
  async findEscalatingSymptom(
    petId: string,
    since: Date,
    executor: DbOrTx = db,
  ): Promise<{ id: string } | null> {
    const [row] = await executor
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "symptom_observed"),
          gte(petEvents.occurredAt, since),
          sql`(${petEvents.payload}->'alerted_disease_codes') @> '"rabies_suspected"'::jsonb`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Find the open bite_incident case for the pet. Returns { id } when found,
   * null when no open case exists (e.g. pre-cases-system rows).
   */
  async findOpenBiteCase(petId: string, executor: DbOrTx = db): Promise<{ id: string } | null> {
    const [row] = await executor
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "bite_incident"),
          eq(cases.status, "open"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Find pets currently in rabies observation (status='in_progress').
   * Used by the cron closer to iterate eligible candidates.
   *
   * Keyset-paginated (review 23 fleet extension): the previous unordered
   * `.limit(500)` returned the SAME 500 rows every run, so on a registry with
   * more than 500 concurrent observations any pet beyond the first page — whose
   * legal 10-day window had elapsed — could NEVER be auto-closed. Callers now
   * pass `afterId` (the last id from the prior page) and persist it across runs,
   * so the whole in_progress set is swept in id order across successive runs and
   * wraps around when drained. Ordered by id so the cursor is stable.
   */
  async findPetsInProgress(opts?: {
    afterId?: string | null;
    limit?: number;
  }): Promise<SurveillancePet[]> {
    const limit = opts?.limit ?? 500;
    const afterId = opts?.afterId ?? null;
    return db
      .select({
        id: pets.id,
        publicToken: pets.publicToken,
        name: pets.name,
        species: pets.species,
        status: pets.status,
        rabiesObservationStatus: pets.rabiesObservationStatus,
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
      })
      .from(pets)
      .where(
        afterId
          ? and(eq(pets.rabiesObservationStatus, "in_progress"), gt(pets.id, afterId))
          : eq(pets.rabiesObservationStatus, "in_progress"),
      )
      .orderBy(asc(pets.id))
      .limit(limit);
  }

  /**
   * Find the active owner of a pet (endedAt IS NULL, role='owner').
   * Returns { ownerUserId } when found, null otherwise.
   */
  async findActiveOwnership(
    petId: string,
    executor: DbOrTx = db,
  ): Promise<{ ownerUserId: string } | null> {
    const [row] = await executor
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      )
      .limit(1);
    if (!row || !row.ownerUserId) return null;
    return { ownerUserId: row.ownerUserId };
  }

  /**
   * Every ACTIVE human owner and co-owner of a pet, deduplicated.
   *
   * The State's close of a rabies observation tells the owner the result. It
   * used `findActiveOwnership` above — one `role = 'owner'` row, `limit(1)` —
   * so a co-owner never learned that a legal observation on their animal had
   * closed, positive included. Same predicate as the walk-in notifier
   * (lib/infra/notify-owners-of-clinical-event.ts), so both doors of the close
   * reach the same people.
   */
  async findActiveOwnerUserIds(petId: string, executor: DbOrTx = db): Promise<string[]> {
    const rows = await executor
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          inArray(ownerships.role, ["owner", "co_owner"]),
          isNull(ownerships.endedAt),
        ),
      );
    const ids = rows
      .map((r) => r.ownerUserId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return [...new Set(ids)];
  }

  // ===========================================================================
  // Rabies event writes
  // ===========================================================================

  /**
   * Insert an incident_reported event using idempotency key deduplication
   * (owner-bite path only — org-bite uses insertIncidentEvent plain insert).
   */
  async insertIncidentEventIdempotent(
    values: NewPetEvent,
    executor: DbOrTx = db,
  ): Promise<{ event: PetEvent; wasNoop: boolean }> {
    return insertEventIdempotent(values, executor as Parameters<typeof insertEventIdempotent>[1]);
  }

  /**
   * Insert an incident_reported event without idempotency (org-bite path).
   * Returns the inserted row. This is the asymmetric parity path — preserve it.
   *
   * This and the two rabies writers below go through the shared helper
   * (finding A08-7): they used to insert raw, the only pet_events writes in
   * this repository with no payload check. With no clientIdempotencyKey the
   * helper is a plain insert, so the parity path is unchanged — only the
   * payload is now validated before it reaches the append-only table.
   */
  async insertIncidentEvent(values: NewPetEvent, executor: DbOrTx = db): Promise<PetEvent> {
    const { event } = await insertEventIdempotent(
      values,
      executor as Parameters<typeof insertEventIdempotent>[1],
    );
    return event;
  }

  /**
   * Insert a rabies_observation_started event.
   */
  async insertObservationStarted(values: NewPetEvent, executor: DbOrTx = db): Promise<PetEvent> {
    const { event } = await insertEventIdempotent(
      values,
      executor as Parameters<typeof insertEventIdempotent>[1],
    );
    return event;
  }

  /**
   * Insert a rabies_observation_ended event. Returns its id: the veterinary
   * close hands it to the walk-in completion, which links the owner's notice
   * to the act and keys that notice's idempotency on it.
   */
  //
  // THE ENO RECORD RIDES ON THIS WRITE (PO decision 1A). A positive close is a
  // notifiable rabies case, so the Cola ENO row (event_notification_outbox,
  // rule in lib/events/event-outbox-rules.ts) is enqueued HERE, in the same
  // transaction as the event: a rollback takes both, a commit can never leave
  // the case without its legal-queue row. Here and not in the use case so that
  // no writer of this event can forget it; for any other outcome the rule
  // declines and nothing is written.
  //
  // Idempotency: the outbox has no unique key of its own, so it is enforced by
  // construction — the enqueue runs only when the event row was NEWLY inserted.
  // A retried write that lands on the same idempotency key (`wasNoop`) reuses
  // the original event and enqueues nothing; a second close never gets here
  // with a new event, because closeObservationIfOpen aborts its transaction.
  //
  // Only the outbox, not eno_processing_queue: that queue's worker fans out
  // in-app notices to the authorities and the owner, which the close already
  // sends itself (rabies_observation_positive_authority + the owner notice).
  // Enqueueing there would page the same people twice.
  async insertObservationEnded(
    values: NewPetEvent,
    executor: DbOrTx = db,
  ): Promise<{ id: string }> {
    // Top-level call: open a transaction so event + ENO row stay atomic.
    if (executor === db) {
      return db.transaction((tx) => this.insertObservationEnded(values, tx));
    }
    const { event, wasNoop } = await insertEventIdempotent(
      values,
      executor as Parameters<typeof insertEventIdempotent>[1],
    );
    if (!wasNoop) {
      const [pet] = await executor
        .select({
          jurisdictionProvince: pets.jurisdictionProvince,
          jurisdictionLocality: pets.jurisdictionLocality,
        })
        .from(pets)
        .where(eq(pets.id, event.petId));
      await enqueueOutboxForEvent(
        executor as Parameters<typeof enqueueOutboxForEvent>[0],
        {
          id: event.id,
          petId: event.petId,
          eventType: event.eventType,
          payload: event.payload as Record<string, unknown>,
        },
        pet ?? {},
        // The SLA runs from the moment the close was recorded, not from
        // whenever this line happens to execute.
        event.recordedAt,
      );
    }
    return { id: event.id };
  }

  /**
   * Update the pets.rabiesObservationStatus column.
   */
  async setObservationStatus(
    petId: string,
    status: string,
    now: Date,
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(pets)
      .set({ rabiesObservationStatus: status, updatedAt: now })
      .where(eq(pets.id, petId));
  }

  /**
   * CIERRE de una observación, con la guarda de estado adentro del propio
   * UPDATE. Devuelve `true` si esta llamada fue la que la cerró.
   *
   * POR QUÉ NO ALCANZA `setObservationStatus` PARA CERRAR.
   * Quien cierra lee `isObservationOpen(pet.rabiesObservationStatus)` antes de
   * abrir la transacción, y ese chequeo no dice nada sobre lo que pasó mientras
   * tanto. Dos cierres casi simultáneos —dos veterinarios, o un veterinario
   * contra el cron de expiración— pasaban los dos y escribían los dos. El
   * evento `rabies_observation_ended` se inserta ANTES de tocar el estado, así
   * que el perdedor ya había dejado en el espinazo un resultado clínico
   * contradictorio con el del ganador: uno "negativo" y otro "positive_rabies"
   * sobre el mismo animal, append-only, imposibles de corregir. Y el dueño
   * recibía dos notificaciones que se contradicen.
   *
   * Con la condición adentro del WHERE, el perdedor actualiza cero filas y su
   * llamador aborta la transacción, con lo cual el evento que ya había
   * insertado se revierte. El estado final es el del ganador, y en el registro
   * queda un solo resultado.
   *
   * Mismo patrón que cases-repository.ts::closeCase y que la guarda de las
   * decisiones de autoridad (approve/reject-request.ts).
   */
  async closeObservationIfOpen(
    petId: string,
    status: string,
    now: Date,
    executor: DbOrTx = db,
  ): Promise<boolean> {
    const rows = await executor
      .update(pets)
      .set({ rabiesObservationStatus: status, updatedAt: now })
      .where(
        and(
          eq(pets.id, petId),
          inArray(pets.rabiesObservationStatus, [...OPEN_OBSERVATION_STATUSES]),
        ),
      )
      .returning({ id: pets.id });
    return rows.length > 0;
  }

  /**
   * Auto-expire close: direct UPDATE on cases with closedReason='auto_expired'.
   * Guard: WHERE status='open' (idempotent — already-closed rows are skipped).
   *
   * IMPORTANT: This must NOT route through closeCase('resolved') — the
   * closed_reason='auto_expired' is load-bearing parity (spec §E parity quirk).
   */
  async autoExpireBiteCase(caseId: string, now: Date, executor: DbOrTx = db): Promise<void> {
    await executor
      .update(cases)
      .set({
        status: "closed",
        closedReason: "auto_expired",
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(cases.id, caseId), eq(cases.status, "open")));
  }

  // ===========================================================================
  // Notification writes (best-effort callers must catch)
  // ===========================================================================

  /**
   * Insert notification rows. Uses the top-level db (not a tx) because
   * notifications are best-effort post-tx.
   *
   * Idempotency (P1-4): inserts with ON CONFLICT DO NOTHING on the event
   * natural key (user_id, related_event_id, notification_type) so re-processing
   * the same ENO queue row — or two overlapping cron runs — never duplicates a
   * legal govt/owner notification. The conflict target is the partial unique
   * index notifications_event_natural_key_unique (migration 0088), which only
   * covers rows where related_event_id IS NOT NULL; free-standing notifications
   * (related_event_id IS NULL) are unaffected and still insert normally.
   */
  async insertNotifications(rows: (typeof notifications.$inferInsert)[]): Promise<void> {
    if (rows.length === 0) return;
    await db
      .insert(notifications)
      .values(rows)
      .onConflictDoNothing({
        target: [
          notifications.userId,
          notifications.relatedEventId,
          notifications.notificationType,
        ],
        // Conflict-target predicate must match the partial unique index
        // notifications_event_natural_key_unique (WHERE related_event_id IS NOT NULL).
        where: sql`${notifications.relatedEventId} IS NOT NULL`,
      });
  }

  // ===========================================================================
  // Govt assignment reads (for fan-out targeting)
  // ===========================================================================

  /**
   * Return the userId of every active (non-revoked) govt assignment for the
   * given province+locality pair.
   */
  async findGovtTargetsForJurisdiction(
    province: string,
    locality: string,
  ): Promise<{ userId: string }[]> {
    return db
      .select({ userId: govtAssignments.userId })
      .from(govtAssignments)
      .where(
        and(
          eq(govtAssignments.jurisdictionProvince, province),
          eq(govtAssignments.jurisdictionLocality, locality),
          isNull(govtAssignments.revokedAt),
        ),
      );
  }

  /**
   * Return all active (non-revoked) govt jurisdiction rows for a given user.
   * Used by professional-close and outbreak use-cases for scope checking.
   */
  async findGovtScopeForUser(
    userId: string,
  ): Promise<Array<{ province: string; locality: string }>> {
    const rows = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
    return rows;
  }

  // ===========================================================================
  // ENO queue reads + writes (WU-2 §2.2)
  // ===========================================================================

  /**
   * Enqueue a pet event for ENO processing.
   *
   * Accepts an optional `executor` so the enqueue can participate in the SAME
   * transaction as the source disease_diagnosis event insert (P1-3 durability:
   * the govt-fanout queue row is now atomic with the event — it can never be
   * lost on a crash between COMMIT and a post-commit best-effort enqueue).
   *
   * Returns the inserted row, or null if a row with this pet_event_id already
   * exists (onConflictDoNothing idempotency — unique index on pet_event_id).
   * The conflict guard means re-inserting the same event (e.g. a retried write)
   * never creates a second queue row, which is what makes the in-tx move safe.
   */
  async insertEnoQueueRow(petEventId: string, executor: DbOrTx = db): Promise<EnoQueueRow | null> {
    const rows = await executor
      .insert(enoProcessingQueue)
      .values({ petEventId })
      .onConflictDoNothing({
        target: enoProcessingQueue.petEventId,
      })
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Atomically claim the oldest BATCH_SIZE claimable rows and return them.
   *
   * Pooler-safe overlap guard (migration 0089): a single UPDATE ... WHERE id IN
   * (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING * claims rows and advances
   * their status to 'processing' in one statement. Two concurrent cron runs
   * therefore claim DISJOINT sets — SKIP LOCKED inside the subquery skips rows
   * already locked by the concurrent UPDATE, and status='processing' prevents
   * re-claim after the lock releases. No session-level advisory lock is needed
   * (and none is acquired — those are pooler-unsafe on pgBouncer
   * transaction-mode connections).
   *
   * Stale-claim recovery: rows whose claimed_at is older than 10 minutes are
   * re-eligible so a crashed run never strands rows in 'processing' forever.
   */
  async pickPendingBatch(batchSize: number): Promise<EnoQueueRow[]> {
    const staleThreshold = sql`now() - interval '10 minutes'`;
    return db
      .update(enoProcessingQueue)
      .set({ status: "processing", claimedAt: sql`now()` })
      .where(
        sql`${enoProcessingQueue.id} IN (
          SELECT id FROM ${enoProcessingQueue}
          WHERE (
            ${enoProcessingQueue.status} = 'pending'
            OR (
              ${enoProcessingQueue.status} = 'processing'
              AND ${enoProcessingQueue.claimedAt} < ${staleThreshold}
            )
          )
          ORDER BY ${enoProcessingQueue.queuedAt} ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning();
  }

  /**
   * Mark a queue row as processed (status='processed', processedAt=now).
   */
  async markEnoProcessed(queueRowId: string): Promise<void> {
    await db
      .update(enoProcessingQueue)
      .set({ status: "processed", processedAt: new Date() })
      .where(eq(enoProcessingQueue.id, queueRowId));
  }

  /**
   * Mark a queue row as failed or increment retryCount.
   * If retryCount reaches 2, status becomes 'failed'. Otherwise stays 'pending'.
   * Retry ≤ 2 semantics match the spec (retry count: 0, 1 → retry; 2 → failed).
   *
   * Atomicity (P2-11): a single UPDATE does `retry_count = retry_count + 1` and
   * derives status with a CASE on the incremented value, instead of the old
   * read-modify-write (SELECT then UPDATE). The read-modify-write lost
   * increments under concurrency — two failures racing both read the same
   * retry_count and each wrote +1, so a row could be retried more than twice.
   * One statement makes the increment race-free.
   */
  async markEnoFailed(queueRowId: string, error: string): Promise<void> {
    await db
      .update(enoProcessingQueue)
      .set({
        retryCount: sql`${enoProcessingQueue.retryCount} + 1`,
        status: sql`CASE WHEN ${enoProcessingQueue.retryCount} + 1 >= 2 THEN 'failed' ELSE 'pending' END`,
        lastError: error,
      })
      .where(eq(enoProcessingQueue.id, queueRowId));
  }

  /**
   * Find the pet_event row for a given queue entry.
   * Returns null when the pet event no longer exists.
   */
  async findEnoEventRow(petEventId: string): Promise<PetEvent | null> {
    const [row] = await db.select().from(petEvents).where(eq(petEvents.id, petEventId)).limit(1);
    return row ?? null;
  }

  // ===========================================================================
  // Outbreak investigation reads + writes (WU-2 §2.3)
  // ===========================================================================

  /**
   * Find open or escalated outbreak_investigation cases for a disease in a
   * jurisdiction. Used for dedupe check before opening a new investigation.
   *
   * openedReason prefix: 'manual [code]:' (spec H).
   */
  async findOpenInvestigationsForDisease(
    diseaseCode: string,
    province: string | null,
    locality: string | null,
  ): Promise<{ id: string; publicCode: string; openedReason: string | null }[]> {
    const conditions = [
      eq(cases.caseKind, "outbreak_investigation"),
      sql`${cases.status} IN ('open', 'escalated')`,
      sql`${cases.openedReason} LIKE ${`manual [${diseaseCode}]:%`}`,
    ];

    if (province !== null) {
      conditions.push(eq(cases.jurisdictionProvince, province));
    } else {
      conditions.push(isNull(cases.jurisdictionProvince));
    }

    if (locality !== null) {
      conditions.push(eq(cases.jurisdictionLocality, locality));
    }

    return db
      .select({ id: cases.id, publicCode: cases.publicCode, openedReason: cases.openedReason })
      .from(cases)
      .where(and(...conditions));
  }

  /**
   * Find a case by its public code. Used by outbreak action to load the
   * full investigation before applying scope checks.
   */
  async findInvestigationByCode(publicCode: string): Promise<typeof cases.$inferSelect | null> {
    const [row] = await db.select().from(cases).where(eq(cases.publicCode, publicCode)).limit(1);
    return row ?? null;
  }

  /**
   * Find the most recent case_event of type 'final_report' for a case.
   */
  async findFinalReport(caseId: string): Promise<{ id: string } | null> {
    // Import caseEvents inline to avoid a circular dep risk at module load time
    const { caseEvents } = await import("@/db/schema");
    const [row] = await db
      .select({ id: caseEvents.id })
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.entryType, "final_report")))
      .orderBy(desc(caseEvents.occurredAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Insert a case_event row (for outbreak investigation timeline entries:
   * case_opened, case_escalated, case_closed, final_report, signal_link).
   */
  async insertCaseEvent(
    values: {
      caseId: string;
      entryType: string;
      payload: Record<string, unknown>;
      notes?: string | null;
      recordedByUserId?: string | null;
      occurredAt?: Date;
    },
    executor: DbOrTx = db,
  ): Promise<{ id: string }> {
    const { caseEvents } = await import("@/db/schema");
    const [row] = await executor
      .insert(caseEvents)
      .values({
        caseId: values.caseId,
        entryType: values.entryType,
        payload: values.payload,
        notes: values.notes ?? null,
        recordedByUserId: values.recordedByUserId ?? null,
        occurredAt: values.occurredAt ?? new Date(),
      })
      .returning({ id: caseEvents.id });
    if (!row) throw new Error("SurveillanceRepository.insertCaseEvent: insert returned no rows");
    return row;
  }

  /**
   * Insert an outbreak_investigation audit_log row.
   * All 4 outbreak actions write their specific audit action inside the tx.
   */
  async insertOutbreakAuditLog(
    values: {
      actorUserId: string;
      action: string;
      payload: Record<string, unknown>;
    },
    executor: DbOrTx = db,
  ): Promise<void> {
    const { auditLog } = await import("@/db/schema");
    // The action column is typed as AuditLogAction — cast through unknown since
    // callers pass validated action strings (outbreak_investigation_*) that are
    // in the union but TypeScript can't narrow a plain string to it.
    await executor.insert(auditLog).values({
      actorUserId: values.actorUserId,
      action: values.action as (typeof auditLog.$inferInsert)["action"],
      payload: values.payload,
    });
  }

  /**
   * Insert the `rabies_observation_closed_professional` audit_log row through
   * the shared writeAuditLog helper (before/after contract), inside the caller's
   * transaction. Kept as a repository method rather than a direct import in the
   * use-case so the application layer stays free of `@/db` (lint:deps).
   */
  async insertObservationCloseAuditLog(entry: AuditLogEntry, executor: DbOrTx = db): Promise<void> {
    await this.insertAuditLog(entry, executor);
  }

  /**
   * The general form of the method above — one audit row through the shared
   * writer, inside the caller's transaction. Same reason it is a repository
   * method: the application layer must stay free of `@/db` (lint:deps).
   */
  async insertAuditLog(entry: AuditLogEntry, executor: DbOrTx = db): Promise<void> {
    await writeAuditLog(executor as Parameters<typeof writeAuditLog>[0], entry);
  }

  /**
   * H1 — the two facts the org bite gate needs. ONE round trip each, both
   * EXISTS-shaped so a clinic with 20.000 events pays for one index probe.
   *
   * `hasPetRelation` is deliberately HISTORICAL (no `ended_at IS NULL`, no date
   * window): the clinic that treated this dog last year is exactly the reporter
   * the gate must keep, and a shelter that returned the animal to its owner
   * last month is still the institution that knows it bit somebody.
   *
   * The two arms of the OR are the two ways an organization touches an animal
   * in this system — it held it (`ownerships.owner_organization_id`) or it
   * wrote on its record (`pet_events.author_organization_id`).
   */
  async loadOrgPetAuthority(
    organizationId: string,
    petId: string,
  ): Promise<{
    hasPetRelation: boolean;
    coverageAreas: CoverageArea[];
    coverageMode: "name" | "id";
  }> {
    const [heldRows, authoredRows, coverageAreas] = await Promise.all([
      db
        .select({ id: ownerships.id })
        .from(ownerships)
        .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerOrganizationId, organizationId)))
        .limit(1),
      db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(and(eq(petEvents.petId, petId), eq(petEvents.authorOrganizationId, organizationId)))
        .limit(1),
      // Id-aware rows (localidades-por-id D5).
      loadOrgCoverageAreas(organizationId),
    ]);

    return {
      hasPetRelation: heldRows.length > 0 || authoredRows.length > 0,
      coverageAreas,
      coverageMode: await coverageDecisionMode(),
    };
  }
}
