// Unit tests for lib/event-idempotency.ts
//
// Tests the idempotency helper without touching the real DB.
// Mock executor pattern mirrors __tests__/unique-token.test.ts.
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 Fase B
// Decision B8: same key + different payload → returns ORIGINAL row (last-stable-wins).

import { describe, expect, it, vi } from "vitest";

import type { NewPetEvent, PetEvent } from "@/db/schema";
import { findExistingByKey, insertEventIdempotent } from "@/lib/events/event-idempotency";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PET_ID = "pet-uuid-0001";
const KEY_A = "11111111-1111-4111-8111-111111111111";
const KEY_B = "22222222-2222-4222-8222-222222222222";

function makeEvent(overrides: Partial<PetEvent> = {}): PetEvent {
  return {
    id: "evt-uuid-0001",
    petId: PET_ID,
    eventType: "weight_recorded",
    occurredAt: new Date("2026-05-22T10:00:00Z"),
    recordedAt: new Date("2026-05-22T10:00:00Z"),
    recordedByUserId: "user-uuid-0001",
    authorRole: "owner",
    authorOrganizationId: null,
    authorVerified: false,
    payload: { kg: "12.50" } as Record<string, unknown>,
    notes: null,
    locationLat: null,
    locationLng: null,
    caseId: null,
    clientIdempotencyKey: KEY_A,
    // SENASA alignment columns (compliance PR 3, migration 0061). Nullable
    // on legacy rows.
    tipoEventoCode: null,
    loteBiologico: null,
    laboratorio: null,
    vencimientoBiologico: null,
    viaAplicacionCode: null,
    vetMatricula: null,
    vetJurisdiccionCode: null,
    establecimientoRenspa: null,
    proximaDosisAt: null,
    firmadoAt: null,
    firmaHash: null,
    createdAt: new Date("2026-05-22T10:00:00Z"),
    ...overrides,
  };
}

// ─── Mock executor builders ───────────────────────────────────────────────────

/**
 * Builds a mock for the SELECT path used by findExistingByKey:
 *   db.select().from().where().limit()
 *
 * `rows` is what the mock SELECT returns.
 */
function makeSelectExecutor(rows: PetEvent[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

/**
 * Builds a mock for the INSERT path used by insertEventIdempotent:
 *   db.insert().values().onConflictDoNothing().returning()
 *
 * `returnedRows` is what the mock INSERT returns (empty = conflict/noop).
 * The mock also supports SELECT for the conflict-fetch path.
 */
function makeInsertExecutor(returnedRows: PetEvent[], existingRows: PetEvent[] = []) {
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returnedRows),
      }),
      // Plain insert (no onConflictDoNothing) used when key is null.
      returning: vi.fn().mockResolvedValue(returnedRows),
    }),
  });

  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(existingRows),
      }),
    }),
  });

  // P4 item 3 (2026-07-08): the keyed path now acquires a transaction-scoped
  // advisory lock (`executor.execute(sql\`select pg_advisory_xact_lock(...)\`)`)
  // before the insert. A no-op stub is enough — these tests assert on the
  // insert/select outcome, not the lock statement itself.
  const execute = vi.fn().mockResolvedValue(undefined);

  return { insert, select, execute };
}

// ─── findExistingByKey ────────────────────────────────────────────────────────

describe("findExistingByKey", () => {
  it("returns the existing row when one is found", async () => {
    const existing = makeEvent();
    const executor = makeSelectExecutor([existing]);
    const result = await findExistingByKey(PET_ID, "weight_recorded", KEY_A, executor as never);
    expect(result).toEqual(existing);
  });

  it("returns null when no matching row exists", async () => {
    const executor = makeSelectExecutor([]);
    const result = await findExistingByKey(PET_ID, "weight_recorded", KEY_A, executor as never);
    expect(result).toBeNull();
  });
});

// ─── insertEventIdempotent ────────────────────────────────────────────────────

describe("insertEventIdempotent", () => {
  const baseValues: NewPetEvent = {
    petId: PET_ID,
    eventType: "weight_recorded",
    occurredAt: new Date("2026-05-22T10:00:00Z"),
    recordedAt: new Date("2026-05-22T10:00:00Z"),
    recordedByUserId: "user-uuid-0001",
    authorRole: "owner",
    payload: { kg: "12.50" } as Record<string, unknown>,
    clientIdempotencyKey: KEY_A,
  };

  // B6 test 1: first insert with key → succeeds, wasNoop=false
  it("first insert with key → returns new event, wasNoop=false", async () => {
    const newEvent = makeEvent();
    const executor = makeInsertExecutor([newEvent]);
    const result = await insertEventIdempotent(baseValues, executor as never);
    expect(result.wasNoop).toBe(false);
    expect(result.event).toEqual(newEvent);
  });

  // B6 test 2: same key + same payload → returns original, wasNoop=true
  it("same key + same payload → returns original event, wasNoop=true", async () => {
    const existing = makeEvent();
    // INSERT returns empty (conflict), SELECT returns existing row.
    const executor = makeInsertExecutor([], [existing]);
    const result = await insertEventIdempotent(baseValues, executor as never);
    expect(result.wasNoop).toBe(true);
    expect(result.event).toEqual(existing);
  });

  // B6 test 3 (B8 decision): same key + different payload → returns ORIGINAL (last-stable-wins)
  it("same key + different payload → returns ORIGINAL event, wasNoop=true (B8 last-stable-wins)", async () => {
    const existing = makeEvent({ payload: { kg: "8.00" } as Record<string, unknown> });
    const differentPayloadValues: NewPetEvent = {
      ...baseValues,
      payload: { kg: "15.00" } as Record<string, unknown>,
    };
    // INSERT returns empty (conflict), SELECT returns the ORIGINAL row.
    const executor = makeInsertExecutor([], [existing]);
    const result = await insertEventIdempotent(differentPayloadValues, executor as never);
    expect(result.wasNoop).toBe(true);
    // Must return the ORIGINAL row, not the one with kg=15.00.
    expect((result.event.payload as Record<string, unknown>).kg).toBe("8.00");
  });

  // B6 test 4: different key → new row, wasNoop=false
  it("different key → new row, wasNoop=false", async () => {
    const newEvent = makeEvent({ id: "evt-uuid-0002", clientIdempotencyKey: KEY_B });
    const executor = makeInsertExecutor([newEvent]);
    const result = await insertEventIdempotent(
      { ...baseValues, clientIdempotencyKey: KEY_B },
      executor as never,
    );
    expect(result.wasNoop).toBe(false);
    expect(result.event.id).toBe("evt-uuid-0002");
  });

  // B6 test 5: null key → plain insert, wasNoop=false
  it("null key → plain insert (no onConflictDoNothing path), wasNoop=false", async () => {
    const newEvent = makeEvent({ clientIdempotencyKey: null });
    const executor = makeInsertExecutor([newEvent]);
    const result = await insertEventIdempotent(
      { ...baseValues, clientIdempotencyKey: null },
      executor as never,
    );
    expect(result.wasNoop).toBe(false);
    expect(result.event).toEqual(newEvent);
  });

  // B6 test 6: admin-tool path (no key, key field absent from values) → plain insert, wasNoop=false
  it("admin-tool path (key undefined) → plain insert, wasNoop=false", async () => {
    const newEvent = makeEvent({ clientIdempotencyKey: null });
    const executor = makeInsertExecutor([newEvent]);
    const { clientIdempotencyKey: _omit, ...valuesNoKey } = baseValues;
    const result = await insertEventIdempotent(valuesNoKey, executor as never);
    expect(result.wasNoop).toBe(false);
    expect(result.event).toEqual(newEvent);
  });

  // P4 item 3 (2026-07-08): advisory lock acquired before the insert on the
  // keyed path, and never acquired on the no-key (plain insert) path.
  describe("advisory lock", () => {
    it("acquires the lock before inserting when a key is present", async () => {
      const newEvent = makeEvent();
      const executor = makeInsertExecutor([newEvent]);
      await insertEventIdempotent(baseValues, executor as never);
      expect(executor.execute).toHaveBeenCalledOnce();
      expect(executor.insert).toHaveBeenCalledOnce();
      // Order matters: lock acquired BEFORE the insert attempt.
      const executeOrder = executor.execute.mock.invocationCallOrder[0];
      const insertOrder = executor.insert.mock.invocationCallOrder[0];
      expect(executeOrder).toBeLessThan(insertOrder);
    });

    it("does NOT acquire the lock on the no-key (plain insert) path", async () => {
      const newEvent = makeEvent({ clientIdempotencyKey: null });
      const executor = makeInsertExecutor([newEvent]);
      await insertEventIdempotent({ ...baseValues, clientIdempotencyKey: null }, executor as never);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });
});
