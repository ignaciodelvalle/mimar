// EL-F1 (tier-3 event-sourcing critique): amendEvent used a raw tx.insert with
// no idempotency, so a double-click on "Corregir" appended TWO event_amended
// rows (+ 2 audit_log + 2 notifications) — log pollution on an append-only log.
// The fix routes the append through insertEventIdempotent with a server-derived
// key from (targetEventId, actorId, hash(changes)). These tests simulate the
// unique-index dedupe with an in-memory store and assert a duplicate submit
// appends only one row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TARGET_ID = "a0000000-0000-4000-8000-000000000001";
const ACTOR_ID = "a0000000-0000-4000-8000-000000000002";

// Hoisted so the vi.mock factory (also hoisted) can reference the same stub +
// in-memory idempotency store the tests inspect and reset.
const { insertEventIdempotentMock, state } = vi.hoisted(() => {
  const st = { created: 0, store: new Map<string, { id: string }>() };
  const fn = vi.fn(async (values: { clientIdempotencyKey?: string | null }) => {
    const key = values.clientIdempotencyKey ?? null;
    if (key && st.store.has(key)) {
      return { event: st.store.get(key), wasNoop: true };
    }
    st.created += 1;
    const event = { ...values, id: `evt-${st.created}` };
    if (key) st.store.set(key, event);
    return { event, wasNoop: false };
  });
  return { insertEventIdempotentMock: fn, state: st };
});

vi.mock("@/db", () => {
  const table = (name: string) => ({ __table: name });
  const petEvents = table("pet_events");
  const profiles = table("profiles");
  return {
    petEvents,
    profiles,
    auditLog: table("audit_log"),
    notifications: table("notifications"),
    ownerships: table("ownerships"),
    db: {
      select: vi.fn(() => {
        let from: { __table: string } | undefined;
        const builder = {
          from: (t: { __table: string }) => {
            from = t;
            return builder;
          },
          where: () => builder,
          // The authorship gate's correction-chain read awaits the builder
          // without a limit: no prior corrections on this record.
          // biome-ignore lint/suspicious/noThenProperty: a drizzle builder is thenable
          then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
          limit: () => {
            if (from?.__table === "pet_events") {
              return Promise.resolve([
                {
                  id: TARGET_ID,
                  eventType: "vaccination_administered",
                  payload: { vaccine_name: "A" },
                  // The actor's own record, so the authorship gate passes.
                  authorRole: "owner",
                  recordedByUserId: ACTOR_ID,
                },
              ]);
            }
            if (from?.__table === "profiles") return Promise.resolve([{ role: "owner" }]);
            return Promise.resolve([]);
          },
        };
        return builder;
      }),
      // The tx handle can lock (the per-record advisory lock is a no-op here)
      // and read like `db` — the authorship recheck runs on it.
      transaction(this: { select: unknown }, cb: (tx: unknown) => Promise<unknown>) {
        return cb({ __tx: true, execute: async () => [], select: this.select });
      },
      insert: () => ({ values: () => ({ returning: async () => [{ id: "x" }] }) }),
    },
  };
});

// Keep the real deriveBulkIdempotencyKey (pure hash) so the derived key is a
// genuine server-side value; swap only insertEventIdempotent for the dedupe stub.
vi.mock("@/lib/events/event-idempotency", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, insertEventIdempotent: insertEventIdempotentMock };
});

vi.mock("./refresh-pet-cache-after-amendment", () => ({
  refreshPetCacheAfterAmendment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { amendEvent, deriveAmendmentIdempotencyKey } from "./amend-event";

const USER = { id: ACTOR_ID };
const PET = { id: "pet-1", name: "Firulais", publicToken: "tok-1" };
const AUTHORSHIP = {
  authorRole: "owner",
  authorOrganizationId: null,
  authorVerified: false,
} as const;

function amendInput(changes: Array<{ field: string; old: unknown; new: unknown }>) {
  return { publicToken: "tok-1", targetEventId: TARGET_ID, reason: null, changes };
}

beforeEach(() => {
  state.created = 0;
  state.store = new Map();
  insertEventIdempotentMock.mockClear();
});

describe("amendEvent — idempotency (EL-F1)", () => {
  it("appends only one event_amended for two identical submissions", async () => {
    const input = amendInput([{ field: "vaccine_name", old: "A", new: "B" }]);

    const r1 = await amendEvent(USER, PET, AUTHORSHIP, input);
    const r2 = await amendEvent(USER, PET, AUTHORSHIP, input);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Only ONE row was actually appended (the second submit deduped).
    expect(state.created).toBe(1);
    // Both submissions carried the SAME server-derived idempotency key.
    const keys = insertEventIdempotentMock.mock.calls.map(
      (c) => (c[0] as { clientIdempotencyKey: string }).clientIdempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    // Both resolve to the same amendment id.
    if (r1.ok && r2.ok) expect(r1.amendmentEventId).toBe(r2.amendmentEventId);
  });

  it("appends separate rows for DISTINCT corrections (keyed on changes)", async () => {
    await amendEvent(
      USER,
      PET,
      AUTHORSHIP,
      amendInput([{ field: "vaccine_name", old: "A", new: "B" }]),
    );
    await amendEvent(
      USER,
      PET,
      AUTHORSHIP,
      amendInput([{ field: "vaccine_name", old: "A", new: "C" }]),
    );
    expect(state.created).toBe(2);
  });
});

describe("deriveAmendmentIdempotencyKey — deterministic, changes-sensitive", () => {
  const changes = [{ field: "vaccine_name", old: "A", new: "B" }];

  it("is stable for identical (target, actor, changes)", () => {
    expect(deriveAmendmentIdempotencyKey(TARGET_ID, ACTOR_ID, changes)).toBe(
      deriveAmendmentIdempotencyKey(TARGET_ID, ACTOR_ID, changes),
    );
  });

  it("differs when the changes differ", () => {
    expect(deriveAmendmentIdempotencyKey(TARGET_ID, ACTOR_ID, changes)).not.toBe(
      deriveAmendmentIdempotencyKey(TARGET_ID, ACTOR_ID, [
        { field: "vaccine_name", old: "A", new: "C" },
      ]),
    );
  });

  it("differs when the actor differs", () => {
    expect(deriveAmendmentIdempotencyKey(TARGET_ID, ACTOR_ID, changes)).not.toBe(
      deriveAmendmentIdempotencyKey(TARGET_ID, "b0000000-0000-4000-8000-000000000009", changes),
    );
  });
});
