// lib/event-idempotency.ts
//
// Server-side idempotency helpers for pet_events inserts.
//
// Design: ENO Event-Trust Tier 1 Fase B — decisions B1-B8 closed.
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 Fase B
//
// Two exported functions:
//
//   findExistingByKey(petId, eventType, key, executor?)
//     → PetEvent | null
//     Pure lookup — checks whether a row with this (pet_id, event_type,
//     client_idempotency_key) already exists. Injected executor makes it
//     unit-testable without a real DB connection.
//
//   insertEventIdempotent<T extends NewPetEvent>(values, executor?)
//     → { event: PetEvent; wasNoop: boolean }
//     Wraps db.insert(petEvents).values(...).onConflictDoNothing().returning().
//     If clientIdempotencyKey is null/undefined, falls back to a plain insert
//     (no conflict logic — admin-tool path, decision B4).
//     If the INSERT returns empty rows (conflict), fetches the existing row via
//     findExistingByKey and returns it with wasNoop=true (last-stable-wins, B8).
//     BOTH paths validate the payload first (validatedEventValues — finding
//     A08-7): this is the shared insert boundary, so the check lives here and
//     not in each caller's wrapper. Until 2026-09-22 only two repository
//     wrappers called it, and every other caller of this helper (adoption,
//     caretaker alert, the v1 API writers, surveillance) wrote unvalidated.

import "server-only";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import type { NewPetEvent, PetEvent } from "@/db/schema";
import { validatedEventValues } from "@/lib/events/validated-event-values";

// Minimal db-shaped executor interface used for test injection.
// In production, the real `db` instance satisfies this at runtime.
// `execute` is required for the pg_advisory_xact_lock statement below.
type DbExecutor = Pick<typeof db, "select" | "insert" | "execute">;

// ─── findExistingByKey ────────────────────────────────────────────────────────

/**
 * Look up a pet event by its idempotency key.
 *
 * Returns the first matching row or null. Callers pass an optional executor
 * so tests can inject a mock without a real DB.
 */
export async function findExistingByKey(
  petId: string,
  eventType: string,
  key: string,
  executor: DbExecutor = db,
): Promise<PetEvent | null> {
  const [row] = await executor
    .select()
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, eventType),
        eq(petEvents.clientIdempotencyKey, key),
      ),
    )
    .limit(1);

  return row ?? null;
}

// ─── insertEventIdempotent ────────────────────────────────────────────────────

export type IdempotentInsertResult = {
  event: PetEvent;
  /** True when the insert was a no-op and the returned row is the original. */
  wasNoop: boolean;
};

/**
 * Insert a pet event with idempotency-key deduplication.
 *
 * When `values.clientIdempotencyKey` is absent or null, this behaves like a
 * plain insert (admin-tool / legacy path — decision B4).
 *
 * When the key is present:
 *   - Acquires a transaction-scoped advisory lock keyed on the idempotency
 *     key (P4 item 3, 2026-07-08) BEFORE the ON CONFLICT insert below — the
 *     same `pg_advisory_xact_lock(hashtext(key))` pattern already used by
 *     pets-repository.ts findDuplicateRegistration (alta double-submit) and
 *     replace-microchip.ts. For a single-statement INSERT ... ON CONFLICT DO
 *     NOTHING, Postgres already blocks a second concurrent inserter on the
 *     first inserter's uncommitted index entry and correctly resolves to a
 *     conflict once it commits — the lock's payoff is for callers (like
 *     createVaccination/createDeworming) that do MORE than one statement
 *     inside the same transaction keyed off this event (attachment insert,
 *     reminder supersede-and-replace): it gives every writer one consistent,
 *     explicit serialization point up front instead of relying on each
 *     caller's own statement ordering to produce the same effect.
 *   - REQUIRES an active transaction: pg_advisory_xact_lock holds the lock
 *     until COMMIT/ROLLBACK and errors outside a transaction. Every
 *     production call site routes through `db.transaction()` (see
 *     EventsRepository.insertEventIdempotent and sibling *-repository.ts
 *     wrappers) — verified 2026-07-08 across all ~23 writers; the two
 *     exceptions found (report-pet-sighting.ts, update-lost-last-seen-use-case.ts)
 *     were wrapped in their own transaction as part of this change rather
 *     than left un-locked.
 *   - Uses ON CONFLICT DO NOTHING on the partial unique index
 *     `pet_events_idempotency_idx` (pet_id, event_type, key WHERE key IS NOT NULL).
 *   - If the conflict fires (returning is empty), fetches the original row via
 *     findExistingByKey and returns it with wasNoop=true.
 *   - The original row is returned regardless of whether the payload differs —
 *     last-stable-wins semantics (decision B8).
 *
 * Throws when:
 *   - The payload fails its per-type schema (EventPayloadValidationError) —
 *     checked before the lock and before any row is written. The PARSED
 *     payload is what gets stored.
 *   - A key was provided but the conflict-fetch returns null (should never
 *     happen in practice; means the unique index exists but the row is gone).
 */
export async function insertEventIdempotent(
  rawValues: NewPetEvent,
  executor: DbExecutor = db,
): Promise<IdempotentInsertResult> {
  const values = validatedEventValues(rawValues);
  const key = values.clientIdempotencyKey ?? null;

  // No key → plain insert (no conflict-resolution path).
  if (!key) {
    const [event] = await executor.insert(petEvents).values(values).returning();

    if (!event) throw new Error("insertEventIdempotent: insert returned no rows");
    return { event, wasNoop: false };
  }

  // Key present → serialize concurrent writers on this key, then try insert
  // with conflict guard. hashtext() collapses the text key to an int4 (the
  // single-key pg_advisory_xact_lock overload); a hash collision only costs
  // an unrelated key a spurious wait, never a correctness issue.
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

  // The unique index `pet_events_idempotency_idx` is PARTIAL (`WHERE client_idempotency_key
  // IS NOT NULL`). Postgres requires the same WHERE clause in ON CONFLICT to match the
  // partial index — without `targetWhere`, Postgres errors with "no unique or exclusion
  // constraint matching the ON CONFLICT specification".
  const inserted = await executor
    .insert(petEvents)
    .values(values)
    .onConflictDoNothing({
      target: [petEvents.petId, petEvents.eventType, petEvents.clientIdempotencyKey],
      where: sql`client_idempotency_key is not null`,
    })
    .returning();

  if (inserted.length > 0) {
    // New row — success.
    return { event: inserted[0], wasNoop: false };
  }

  // Conflict fired → fetch the original row (last-stable-wins, B8).
  const existing = await findExistingByKey(values.petId, values.eventType, key, executor);

  if (!existing) {
    throw new Error(
      `insertEventIdempotent: conflict detected but original row not found (petId=${values.petId}, eventType=${values.eventType}, key=${key})`,
    );
  }

  return { event: existing, wasNoop: true };
}

// ─── deriveBulkIdempotencyKey ─────────────────────────────────────────────────

/**
 * Derives a deterministic UUID v4-shaped idempotency key from (bulkActionId, petId).
 *
 * Algorithm: SHA-256(`${bulkActionId}:${petId}`), first 32 hex chars with
 * version=4 and variant bits applied per RFC 4122. The result is a valid UUID v4.
 *
 * Reused by all bulk pet-event use-cases so that re-submitting the same bulkActionId
 * for the same pet produces the same key — the DB-level unique constraint on
 * clientIdempotencyKey makes the second insert a no-op (see insertEventIdempotent).
 */
export function deriveBulkIdempotencyKey(bulkActionId: string, petId: string): string {
  const hash = createHash("sha256").update(`${bulkActionId}:${petId}`).digest("hex");
  const variantNibble = (Number.parseInt(hash.charAt(16), 16) & 0x3) | 0x8;
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`, // version 4
    `${variantNibble.toString(16)}${hash.slice(17, 20)}`, // variant bits per RFC 4122
    hash.slice(20, 32),
  ].join("-");
}
