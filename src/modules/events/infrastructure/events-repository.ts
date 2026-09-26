// EventsRepository — thin Drizzle wrapper for events domain writes + reads.
//
// Design decisions (from design artifact):
//   - All write methods accept an optional `executor` param (DbOrTx) to support
//     both top-level calls and participation in a db.transaction().
//   - Exposes BOTH insertEventIdempotent AND insertEvent (plain) — the asymmetry
//     is load-bearing, but WHO takes which is not a property of the kind: it is
//     a property of whether that call was given a key. doseTaken,
//     outbreak_signal and the cascade events are PLAIN because nothing upstream
//     holds a key to pass. The symptom writer (since 2026-06-07) and the
//     dangerous-breed attestation (since 2026-09-08) take one when their caller
//     has one and fall back to the plain insert when it does not — which is what
//     lets `POST /api/v1/pets/{token}/events` require an `Idempotency-Key` and
//     honour it for both.
//   - Projection write-through: updateWeightProjection, updateMicrochipBackfill
//     (only if null), updateStatusProjection, updateDeceased.
//   - Outbox enqueue delegates to lib/event-outbox-enqueue (reuse, not duplicate).
//   - Case ops via injected casesRepo — never import CasesRepository directly here.
//   - No auth logic — auth lives at the action / use-case edge.

import "server-only";

import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne } from "drizzle-orm";

import {
  attachments,
  auditLog,
  db,
  notifications,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  reminders,
} from "@/db";
import type { NewAuditLogRow, NewPetEvent, NewPetIdentification, PetEvent } from "@/db/schema";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { enqueueOutboxForEvent } from "@/lib/events/event-outbox-enqueue";
import { validatedEventValues } from "@/lib/events/validated-event-values";
import { overlayAmendments } from "@/lib/infra/amendment";
import { replayPetWeight } from "@/lib/projections/pet-weight";
import type { ProjectionEvent } from "@/lib/projections/types";
import { AR_TIME_ZONE } from "@/lib/utils/format";

/**
 * Event types replayPetWeight considers weight-bearing. Kept in sync with
 * lib/projections/pet-weight.ts::weightFromEvent — narrowing the read to these
 * three keeps the re-derivation cheap without changing its result, because
 * every other type returns NOT_WEIGHT_BEARING anyway.
 */
const WEIGHT_BEARING_TYPES = ["weight_recorded", "pet_registered", "pet_profile_updated"];

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

export type EventsRepositoryPet = typeof pets.$inferSelect;

export type AttachmentInput = {
  petId: string;
  eventId: string;
  uploadedByUserId: string;
  storagePath: string;
  mimeType: string;
  fileSize: number;
};

export type ReminderInput = typeof reminders.$inferInsert;

// ---------------------------------------------------------------------------
// Same-day duplicate warn (P4 item 4, 2026-07-08)
// ---------------------------------------------------------------------------

/**
 * Returns the [start, end] UTC instants bracketing the Argentina-local
 * calendar day containing `date`. Argentina has used a fixed UTC-3 offset
 * with no DST since 2009 (Ley 26.350), so constructing the boundaries
 * directly from the AR-local Y-M-D parts is safe — no per-date offset table
 * needed.
 */
function arCalendarDayRangeUtc(date: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) {
    throw new Error(
      `arCalendarDayRangeUtc: could not resolve AR-local date parts for ${date.toISOString()}`,
    );
  }
  return {
    start: new Date(`${y}-${m}-${d}T00:00:00-03:00`),
    end: new Date(`${y}-${m}-${d}T23:59:59.999-03:00`),
  };
}

// ---------------------------------------------------------------------------
// EventsRepository
// ---------------------------------------------------------------------------

export class EventsRepository {
  // ===========================================================================
  // Event writes
  // ===========================================================================

  /**
   * Insert an event with idempotency-key deduplication.
   * Returns { event, wasNoop } — callers check wasNoop to skip side-effects.
   *
   * The payload is validated against the per-type Zod schema inside the
   * shared helper (lib/events/event-idempotency.ts — finding A08-7; before
   * that, this wrapper did it and the helper's other callers did not).
   * Use-case-level validateEventPayload calls remain valid: re-parsing an
   * already-parsed payload is a no-op.
   */
  async insertEventIdempotent(
    values: NewPetEvent,
    executor: DbOrTx = db,
  ): Promise<{ event: PetEvent; wasNoop: boolean }> {
    return insertEventIdempotent(values, executor as Parameters<typeof insertEventIdempotent>[1]);
  }

  /**
   * Insert an event without idempotency (plain insert).
   * Used where no key exists to honour: doseTaken, cascade events,
   * outbreak_signal, and the keyless fallback of the symptom writer and the
   * dangerous-breed attestation — both of which reach for the idempotent twin
   * when their caller does hand them a key.
   *
   * The payload is validated against the per-type Zod schema at this boundary
   * — an invalid payload throws EventPayloadValidationError before any row is
   * written (event-sourcing integrity review 2026-07-04 item 2).
   */
  async insertEvent(values: NewPetEvent, executor: DbOrTx = db): Promise<PetEvent> {
    const validated = validatedEventValues(values);
    const [row] = await executor.insert(petEvents).values(validated).returning();
    if (!row) throw new Error("EventsRepository.insertEvent: insert returned no rows");
    return row;
  }

  /**
   * Find an existing event of the same (pet, eventType) whose occurredAt
   * falls on the same Argentina-local calendar day as `occurredAt`. Used by
   * the SUSPICIOUS same-day-duplicate warn (P4 item 4) for
   * vaccination_administered / deworming_administered — a hit means the
   * caller should surface a non-blocking confirm prompt instead of inserting
   * outright. Returns the first match's id only (existence check, not a
   * projection read).
   */
  async findSameDayEventOfType(
    petId: string,
    eventType: string,
    occurredAt: Date,
    executor: DbOrTx = db,
  ): Promise<{ id: string } | null> {
    const { start, end } = arCalendarDayRangeUtc(occurredAt);
    const [row] = await executor
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, eventType),
          gte(petEvents.occurredAt, start),
          lte(petEvents.occurredAt, end),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // ===========================================================================
  // Attachment + reminders
  // ===========================================================================

  /**
   * Insert an event attachment row.
   */
  async insertAttachment(input: AttachmentInput, executor: DbOrTx = db): Promise<void> {
    await executor.insert(attachments).values(input);
  }

  /**
   * Insert a canonical pet_identifications row.
   *
   * Skips the insert if an active row for the same (pet, kind) already exists:
   * callers of this helper are "add identifier to a pet that has none" flows
   * (createMicrochip backfill, set-pet-lost retroactive chip), so an existing
   * active row means a prior partial write — keeping it is the correct re-sync.
   * Replacement flows expire the old row first (see expireActiveIdentification)
   * and use direct inserts.
   *
   * This is a LAST-RESORT re-sync guard, not a conflict check, and callers must
   * not lean on it as one. It compares (pet, kind) and never looks at `code`,
   * so it cannot tell a repeat of the same chip from a different one — and it
   * is reached only after the event has already been written. The
   * `chip_unique` partial index is UNIQUE(code) across ALL active chip rows,
   * so a different code on the same pet would not trip it either: two active
   * chips would simply coexist and `rowsToIdentifications` would pick whichever
   * row the query returned last. Deciding whether a chip may be recorded at all
   * belongs upstream, in checkChipMatchesCanonical, before anything is appended.
   */
  async insertIdentification(values: NewPetIdentification, executor: DbOrTx = db): Promise<void> {
    const [existing] = await executor
      .select({ id: petIdentifications.id })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, values.petId),
          eq(petIdentifications.kind, values.kind),
          eq(petIdentifications.status, "active"),
        ),
      )
      .limit(1);
    if (existing) return;
    await executor.insert(petIdentifications).values(values);
  }

  /**
   * Flip an existing active identification row to status='replaced'.
   * Used by chip-replacement flows before inserting the new active row.
   * Matches by (petId, kind, status='active') — at most one row per chip
   * per the chip_unique partial index.
   */
  async expireActiveIdentification(
    petId: string,
    kind: "microchip_iso" | "tattoo" | "collar_tag" | "photo_biometric",
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(petIdentifications)
      .set({ status: "replaced", updatedAt: new Date() })
      .where(
        and(
          eq(petIdentifications.petId, petId),
          eq(petIdentifications.kind, kind),
          eq(petIdentifications.status, "active"),
        ),
      );
  }

  /**
   * Mark a reminder as completed (source reminder after event recorded).
   */
  async completeReminder(
    reminderId: string,
    petId: string,
    now: Date,
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(reminders)
      .set({ completedAt: now })
      .where(and(eq(reminders.id, reminderId), eq(reminders.petId, petId)));
  }

  /**
   * Insert one or more reminder rows (dose schedule, vaccine next-due, etc.).
   */
  async insertReminders(rows: ReminderInput[], executor: DbOrTx = db): Promise<void> {
    if (rows.length === 0) return;
    await executor.insert(reminders).values(rows);
  }

  /**
   * Find open (incomplete) reminders of a given type for a pet.
   *
   * Used by callers that need to match against existing reminder titles
   * (e.g. the vaccine reminder supersede-on-duplicate check in
   * vaccination-use-case.ts — `reminders.title` is free text, there is no
   * structural vaccine-kind column, so title matching happens caller-side).
   */
  async findOpenReminders(
    petId: string,
    reminderType: (typeof reminders.$inferSelect)["reminderType"],
    executor: DbOrTx = db,
  ): Promise<{ id: string; title: string }[]> {
    return executor
      .select({ id: reminders.id, title: reminders.title })
      .from(reminders)
      .where(
        and(
          eq(reminders.petId, petId),
          eq(reminders.reminderType, reminderType),
          isNull(reminders.completedAt),
        ),
      );
  }

  /**
   * Cancel future incomplete reminders for a source medication event.
   * Past-due reminders are left as-is (they record missed doses).
   */
  async cancelFutureReminders(
    sourceEventId: string,
    now: Date,
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(reminders)
      .set({ completedAt: now })
      .where(
        and(
          eq(reminders.sourceEventId, sourceEventId),
          isNull(reminders.completedAt),
          gt(reminders.dueAt, now),
        ),
      );
  }

  /**
   * Find a specific reminder by ID, verifying it belongs to the given user.
   * Returns null when not found or not owned by the user.
   */
  async findReminderForUser(
    reminderId: string,
    userId: string,
  ): Promise<typeof reminders.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  // ===========================================================================
  // Projection writes
  // ===========================================================================

  /**
   * Update pets.estimatedWeightKg by RE-DERIVING it from the spine.
   *
   * WHY NOT JUST WRITE `kgStr`. It used to. The canonical projection
   * (replayPetWeight, lib/projections/pet-weight.ts) is latest-by-occurredAt,
   * and every derivation path orders that way — rederivePetCache,
   * rebuild-projections, refresh-pet-cache-after-amendment. Writing the
   * incoming value blind only agrees with the projection when the incoming
   * event happens to be the newest by DATE OF THE FACT, and the weight form
   * exposes occurredAt as a free `<input type="date">` whose only guard
   * (checkOccurredAtPlausible) rejects the future and pre-birth dates.
   *
   * So the ordinary act of logging a FORGOTTEN weighing — 9 kg dated three
   * months back, entered today — overwrote the cache with 9 while the spine
   * still said 12. The pet card and the libreta showed a current weight that
   * the weight-history chart (which reads events directly) contradicted, and
   * nothing surfaced the disagreement: detect-pet-cache-drift.ts does flag it,
   * but repair-pet-cache-drift.ts only repairs status/deceasedAt, so it stayed
   * drifted until someone ran rebuild-projections --apply by hand.
   *
   * Invariant #3 tolerates caches; it does not tolerate a cache that
   * contradicts the spine, still less a write path that MANUFACTURES the
   * contradiction during normal use. Re-deriving costs one indexed read per
   * weight write and makes the cache a function of the log rather than of
   * arrival order — so it also self-heals any pet whose cache was already
   * drifted the moment a new weight is recorded.
   *
   * Runs on the caller's executor: inside the use-case transaction the event
   * just inserted is visible, so the replay includes it.
   *
   * Takes no kg argument on purpose — the value is a function of the log, and a
   * parameter here would invite exactly the "write what the caller handed me"
   * behaviour this replaced.
   */
  async updateWeightProjection(
    petId: string,
    now: Date = new Date(),
    executor: DbOrTx = db,
  ): Promise<void> {
    const events = await executor
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        recordedAt: petEvents.recordedAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      // `event_amended` rides along so the overlay below can fold a corrected
      // weight (A08-G1). Without it, recording ANY weight after a weight was
      // amended re-derived the cache from the pre-correction value and silently
      // reverted the correction — no new event, no audit row.
      .where(
        and(
          eq(petEvents.petId, petId),
          inArray(petEvents.eventType, [...WEIGHT_BEARING_TYPES, "event_amended"]),
        ),
      )
      // Same ordering as rederivePetCache — occurredAt first, then recordedAt
      // and id to break ties deterministically.
      .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

    const { estimatedWeightKg } = replayPetWeight(overlayAmendments(events as ProjectionEvent[]));

    await executor
      .update(pets)
      .set({ estimatedWeightKg, updatedAt: now })
      .where(eq(pets.id, petId));
  }

  /**
   * Update pets.status (lost / active projection writes).
   * For deceased use updateDeceased which also sets deceasedAt.
   */
  async updateStatusProjection(
    petId: string,
    status: "lost" | "active" | "deceased",
    now: Date = new Date(),
    executor: DbOrTx = db,
  ): Promise<void> {
    if (status === "deceased") {
      await executor
        .update(pets)
        .set({ status: "deceased", deceasedAt: now, updatedAt: now })
        .where(eq(pets.id, petId));
    } else {
      await executor.update(pets).set({ status, updatedAt: now }).where(eq(pets.id, petId));
    }
  }

  /**
   * Update pets for the full lost-flip: status + 5 disclosure columns + optional identity.
   */
  async updatePetLostProjection(
    petId: string,
    update: {
      status: "lost";
      discloseFirstNameWhenLost: boolean;
      disclosePhoneWhenLost: boolean;
      discloseEmailWhenLost: boolean;
      discloseLastLocationWhenLost: boolean;
      allowFinderFormWhenLost: boolean;
      color?: string | null;
      distinguishingFeatures?: string | null;
    },
    now: Date = new Date(),
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(pets)
      .set({
        status: "lost",
        discloseFirstNameWhenLost: update.discloseFirstNameWhenLost,
        disclosePhoneWhenLost: update.disclosePhoneWhenLost,
        discloseEmailWhenLost: update.discloseEmailWhenLost,
        discloseLastLocationWhenLost: update.discloseLastLocationWhenLost,
        allowFinderFormWhenLost: update.allowFinderFormWhenLost,
        ...(update.color !== undefined ? { color: update.color ?? null } : {}),
        ...(update.distinguishingFeatures !== undefined
          ? { distinguishingFeatures: update.distinguishingFeatures ?? null }
          : {}),
        updatedAt: now,
      })
      .where(eq(pets.id, petId));
  }

  // ===========================================================================
  // Notification writes
  // ===========================================================================

  /**
   * Mark a ppp_registration_reminder notification as read for the given user+pet.
   */
  async markPppReminderRead(
    userId: string,
    petId: string,
    now: Date = new Date(),
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "ppp_registration_reminder"),
          isNull(notifications.readAt),
        ),
      );
  }

  // ===========================================================================
  // Outbox enqueue
  // ===========================================================================

  /**
   * Enqueue zero or more outbox rows for the given event inside the same tx.
   * Delegates to lib/event-outbox-enqueue — no duplication.
   */
  async enqueueOutbox(
    executor: DbOrTx,
    event: {
      id: string;
      petId: string;
      eventType: string;
      payload: Record<string, unknown>;
      /** When it happened — the legal clock starts here (PO S5). */
      occurredAt?: Date | null;
    },
    pet: {
      jurisdictionProvince?: string | null;
      jurisdictionLocality?: string | null;
      // localidades-por-id D3: the snapshot's catalogue row (see PetInput).
      localityId?: string | null;
      placeMethod?: string | null;
    },
    now?: Date,
  ): Promise<void> {
    await enqueueOutboxForEvent(
      executor as Parameters<typeof enqueueOutboxForEvent>[0],
      event,
      pet,
      now,
    );
  }

  // ===========================================================================
  // Audit log
  // ===========================================================================

  /**
   * Insert an audit_log row (best-effort — callers swallow errors on failure).
   * Used by record-disease-diagnosis to record ENO trigger failures without
   * rolling back the committed diagnosis event.
   */
  async insertAuditLog(
    values: Omit<NewAuditLogRow, "id" | "createdAt">,
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor.insert(auditLog).values(values as NewAuditLogRow);
  }

  // ===========================================================================
  // Pet reads
  // ===========================================================================

  // ===========================================================================
  // Bulk reads
  // ===========================================================================

  /**
   * Batch ownership query for bulk event writes.
   *
   * Returns only the pets that are currently under active shelter_custody of
   * the given org and are NOT deceased (mirrors requireAlivePetAccess scope
   * used in the single-pet path). Tokens absent from the result are ineligible.
   */
  async findBatchShelterPets(
    tokens: string[],
    orgId: string,
  ): Promise<Array<{ petId: string; publicToken: string; petName: string }>> {
    if (tokens.length === 0) return [];
    const rows = await db
      .select({ petId: pets.id, publicToken: pets.publicToken, petName: pets.name })
      .from(pets)
      .innerJoin(ownerships, eq(ownerships.petId, pets.id))
      .where(
        and(
          inArray(pets.publicToken, tokens),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
          ne(pets.status, "deceased"),
        ),
      );
    return rows;
  }

  /**
   * Return the minimal alive-state snapshot for a pet.
   * Returns null when the pet does not exist.
   */
  async findPetAliveState(
    petId: string,
    executor: DbOrTx = db,
  ): Promise<{ id: string; status: string; rabiesObservationStatus: string | null } | null> {
    const [row] = await executor
      .select({
        id: pets.id,
        status: pets.status,
        rabiesObservationStatus: pets.rabiesObservationStatus,
      })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find the medication_started event for a given pet + eventId.
   * Used by createMedicationEnd to verify the FK guard.
   */
  async findSourceMedicationEvent(
    petId: string,
    eventId: string,
    executor: DbOrTx = db,
  ): Promise<{ id: string; eventType: string } | null> {
    const [row] = await executor
      .select({ id: petEvents.id, eventType: petEvents.eventType })
      .from(petEvents)
      .where(and(eq(petEvents.id, eventId), eq(petEvents.petId, petId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find the most recent rabies_observation_started event for a pet.
   * Used by death-record cascade C.
   */
  async findLatestRabiesObservationStarted(
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
   * Find a pet by reminder ownership: verifies that the reminder's pet is owned
   * by the given user (active ownership, no endedAt) and returns minimal pet info.
   * Used exclusively by markMedicationDoseTaken (reminder-keyed auth).
   * Returns null when not found or not owned by the user.
   */
  async findOwnedAlivePetByReminder(
    petId: string,
    userId: string,
    executor: DbOrTx = db,
  ): Promise<{ id: string; publicToken: string; status: string } | null> {
    const [row] = await executor
      .select({ id: pets.id, publicToken: pets.publicToken, status: pets.status })
      .from(pets)
      .innerJoin(ownerships, eq(ownerships.petId, pets.id))
      .where(
        and(eq(pets.id, petId), eq(ownerships.ownerUserId, userId), isNull(ownerships.endedAt)),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Find active foster ownerships for a pet.
   * Used by death-record cascade A.
   */
  async findActiveFosters(
    petId: string,
    executor: DbOrTx = db,
  ): Promise<Array<{ id: string; ownerUserId: string | null }>> {
    return executor
      .select({ id: ownerships.id, ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "foster"), isNull(ownerships.endedAt)),
      );
  }

  /**
   * End a foster ownership row (set endedAt).
   */
  async endFoster(ownershipId: string, now: Date, executor: DbOrTx = db): Promise<void> {
    await executor.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, ownershipId));
  }

  /**
   * Update pets for the deceased status: set status=deceased, deceasedAt=occurredAt.
   * Separate from updateStatusProjection so callers pass the actual death date (occurredAt),
   * not the wall-clock time of the write.
   */
  async updateDeceased(
    petId: string,
    occurredAt: Date,
    now: Date = new Date(),
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(pets)
      .set({ status: "deceased", deceasedAt: occurredAt, updatedAt: now })
      .where(eq(pets.id, petId));
  }

  /**
   * Update pets.rabiesObservationStatus.
   * Used by CASCADE C of death-record to flip to "completed_dead" when the
   * pet dies during an active 10-day observation.
   */
  async updateRabiesObservationStatus(
    petId: string,
    status: string,
    now: Date = new Date(),
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(pets)
      .set({
        rabiesObservationStatus: status as
          | "in_progress"
          | "completed_clear"
          | "completed_dead"
          | null,
        updatedAt: now,
      })
      .where(eq(pets.id, petId));
  }
}
