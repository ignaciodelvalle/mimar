// The booking guard, pinned on the COMPILED predicate — and the refusal table,
// pinned against the writer's own source.
//
// WHY THE PREDICATE IS COMPILED AND NOT GREPPED
// ---------------------------------------------------------------------------
// `search-bookable-slots.test.ts` carries the long version. The short one: a
// source-text `toContain("isNull(pets.deletedAt)")` passes for
// `or(isNull(pets.deletedAt), sql\`true\`)`, which keeps the substring and stops
// filtering, and a stub that discards `.where()` makes every assertion in the
// file assert that the predicate does not matter. Both mistakes have been paid
// for in this repo, one of them on the file next door.
//
// WHY THE SENTENCES ARE PINNED AGAINST `book-slot.ts`
// ---------------------------------------------------------------------------
// `bookSlotWriter` answers es-AR PROSE. `bookSlotRefusalCode` matches it exactly
// once, and its fall-through is `slot_unavailable` — a refusal, so nothing is
// granted by a miss, but a reworded sentence would silently become "the slot is
// gone" for a case that is not that. The last case in this file reads the
// writer's source and asserts that every sentence it can throw has a row here, so
// a rewording is a RED TEST rather than a quiet reclassification. It is the same
// instrument `api-v1-me-appointments-route.test.ts` already uses for the cancel
// table, and the reason that one exists is written in `commands.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";

const control = vi.hoisted(() => ({
  /** What the ownership lookup resolves with. Empty = no row. */
  rows: [] as Array<Record<string, unknown>>,
  /** The predicate the guard handed `.where()`, uncompiled. */
  wherePredicate: null as unknown,
  /** What the inner writer answers. */
  writerResult: { ok: true, appointmentToken: "APT-7K2M-9QX4" } as Record<string, unknown>,
  /** Every call the inner writer received, in order. */
  writerCalls: [] as Array<{ slotId: string; petId: string; userId: string }>,
}));

// The chain ends at `.limit()` — the guard's one query is
// `.select().from().innerJoin().where().limit(1)`. Naming the terminal is what
// makes a change of query shape stop resolving LOUDLY instead of quietly handing
// back the previous rows.
const chain: Record<string, unknown> = vi.hoisted(() => {
  const self: Record<string, unknown> = {};
  self.select = () => self;
  self.from = () => self;
  self.innerJoin = () => self;
  self.where = (predicate: unknown) => {
    control.wherePredicate = predicate;
    return self;
  };
  self.limit = async () => control.rows;
  return self;
});

// A PARTIAL mock: only `db` is replaced, so the real table objects stay in place
// for the query the guard builds out of them.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: chain };
});

vi.mock("@/src/modules/events/application/booking/book-slot", () => ({
  bookSlotWriter: async (slotId: string, petId: string, userId: string) => {
    control.writerCalls.push({ slotId, petId, userId });
    return control.writerResult;
  },
}));

import { readFileSync } from "node:fs";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  BOOK_SLOT_REFUSAL_SENTENCES,
  bookSlotForUser,
  bookSlotRefusalCode,
} from "@/src/modules/events/application/booking/book-slot-for-user";

const dialect = new PgDialect();
const compile = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

const book = () =>
  bookSlotForUser({ slotId: SLOT_ID, petPublicToken: "DIM-PAMP-0001", userId: USER });

beforeEach(() => {
  control.rows = [];
  control.wherePredicate = null;
  control.writerResult = { ok: true, appointmentToken: "APT-7K2M-9QX4" };
  control.writerCalls = [];
});

describe("bookSlotForUser — the guard's predicate", () => {
  it("binds the token, the caller, an ACTIVE ownership and a live record", async () => {
    // THE WHOLE AUTHORIZATION BOUNDARY OF THIS DOOR. `bookSlotWriter` takes a
    // caller-supplied user id and says in its own docblock that verifying the pet
    // belongs to it is the caller's job — this predicate IS that verification,
    // and there is no RLS under it (the read runs on the service-role handle).
    control.rows = [{ petId: PET_ID, status: "active" }];
    await book();

    const query = compile(control.wherePredicate);
    // EQUALITY on the whole compiled string, never `toContain`: `and(…,
    // sql`true`)` and `or(isNull(x), sql`true`)` both survive a containment check.
    expect(query.sql).toBe(
      '("pets"."public_token" = $1 and "ownerships"."owner_user_id" = $2 and "ownerships"."ended_at" is null and "pets"."deleted_at" is null)',
    );
    // The params are the other half: a predicate that reads the right columns in
    // the wrong order, or binds the token where the user id belongs, dies here.
    expect(query.params).toEqual(["DIM-PAMP-0001", USER]);
  });

  it("does NOT constrain the ownership ROLE, because a foster's turno is the foster's", async () => {
    // `bookSlotAction` accepts any active ownership row, and the appointment's
    // `owner_user_id` is whoever booked it. A `role = 'owner'` clause here would
    // refuse the person the whole feature exists for on a fostered animal — and
    // it would be invisible, because the picker would just come back short.
    control.rows = [{ petId: PET_ID, status: "active" }];
    await book();
    expect(compile(control.wherePredicate).sql).not.toContain("role");
  });
});

describe("bookSlotForUser — what it refuses before the writer runs", () => {
  it("answers pet_not_yours for a pet that is not the caller's, and never calls the writer", async () => {
    control.rows = [];
    expect(await book()).toEqual({ ok: false, code: "pet_not_yours" });
    // A refusal that still booked would be a 404 wrapped around a completed write.
    expect(control.writerCalls).toEqual([]);
  });

  it("refuses an ERASED pet in the QUERY, so it folds into the same answer (art. 16)", async () => {
    // There is nothing to assert about the RESULT that the case above does not
    // already assert, and that is the point: the two situations must be
    // indistinguishable or this door is an existence oracle over erased animals.
    // What CAN be asserted is WHERE the refusal happens — in the predicate, so the
    // row never comes back at all, rather than in a branch that could one day
    // answer something else.
    control.rows = [];
    await book();
    expect(compile(control.wherePredicate).sql).toContain('"pets"."deleted_at" is null');
  });

  it("answers pet_deceased for a closed life record, and never calls the writer", async () => {
    control.rows = [{ petId: PET_ID, status: "deceased" }];
    expect(await book()).toEqual({ ok: false, code: "pet_deceased" });
    expect(control.writerCalls).toEqual([]);
    // CHECKED HERE AND NOT ONLY IN THE PICKER. The picker is presentational: a
    // screen opened before the death was recorded reaches this function with an
    // animal it would no longer show. The web makes the same argument in the same
    // place (`app/actions/booking.ts:71-79`).
  });
});

describe("bookSlotForUser — what it hands the writer", () => {
  it("passes the RESOLVED pet id and the SESSION's user id, never anything from the caller", async () => {
    control.rows = [{ petId: PET_ID, status: "active" }];
    const result = await book();

    expect(result).toEqual({ ok: true, appointmentToken: "APT-7K2M-9QX4" });
    expect(control.writerCalls).toEqual([{ slotId: SLOT_ID, petId: PET_ID, userId: USER }]);
  });

  it("translates every refusal sentence the writer can return", async () => {
    control.rows = [{ petId: PET_ID, status: "active" }];

    for (const rule of BOOK_SLOT_REFUSAL_SENTENCES) {
      control.writerResult = { error: rule.sentence };
      expect(await book()).toEqual({ ok: false, code: rule.code });
    }
  });

  it("falls an unrecognised sentence through to a REFUSAL rather than to a success", async () => {
    control.rows = [{ petId: PET_ID, status: "active" }];
    control.writerResult = { error: "Una frase que nadie tradujo." };

    // The safe direction, and the one that matters: an unmapped refusal is still
    // a refusal. The cost is that it is reported as "the slot is gone" when it may
    // be something else, which is why the case below exists.
    expect(await book()).toEqual({ ok: false, code: "slot_unavailable" });
    expect(bookSlotRefusalCode("Una frase que nadie tradujo.")).toBe("slot_unavailable");
  });
});

describe("the refusal table against the writer's own source", () => {
  it("has a row for EVERY sentence `bookSlotWriter` can throw", () => {
    // THE INSTRUMENT, not a restatement of the table. `book-slot.ts` throws its
    // refusals as `new BookingError("…")` and returns three more from its
    // constraint translators; every one of those literals must be in the table, or
    // a rewording silently reclassifies a refusal as "the slot is gone".
    const source = readFileSync("src/modules/events/application/booking/book-slot.ts", "utf8");

    const sentences = new Set<string>();
    for (const match of source.matchAll(/new BookingError\("([^"]+)"\)/g)) {
      sentences.add(match[1]);
    }
    for (const match of source.matchAll(/return \{ error: "([^"]+)" \}/g)) {
      sentences.add(match[1]);
    }
    // T4-M6 (2026-09-22): THE BYPASS THIS SECOND PASS CLOSES. The regex above
    // only sees a STRING LITERAL sitting directly inside `new BookingError(…)`.
    // Measured at the merge review: `const msg = "…"; throw new
    // BookingError(msg);` kept every one of the eight literals in place, so the
    // first pass's set was unchanged, the table still matched it, and this test
    // stayed green over a NINTH, unmapped refusal — the new sentence fell
    // through `bookSlotRefusalCode` to `slot_unavailable` with nothing red
    // anywhere. `new BookingError(IDENTIFIER)` is resolved back to the nearest
    // `const IDENTIFIER = "…"` (or `let`) the writer's own source declares, so
    // an indirection through a local variable is swept the same as a literal.
    for (const match of source.matchAll(/new BookingError\((\w+)\)/g)) {
      const identifier = match[1];
      const declaration = source.match(
        new RegExp(`(?:const|let)\\s+${identifier}\\s*=\\s*"([^"]+)"`),
      );
      if (declaration) sentences.add(declaration[1]);
    }

    // The fence's own smoke test: if the regexes rot, every assertion below passes
    // vacuously over an empty set.
    expect(sentences.size).toBeGreaterThanOrEqual(8);

    const mapped = new Set(BOOK_SLOT_REFUSAL_SENTENCES.map((r) => r.sentence));
    expect([...sentences].filter((s) => !mapped.has(s)).sort()).toEqual([]);
  });

  it("carries no row for a sentence the writer no longer returns", () => {
    // The other direction. A stale row is not a leak, but it is a claim about the
    // writer that stopped being true, and this module's whole job is to be the one
    // place that claim lives.
    const source = readFileSync("src/modules/events/application/booking/book-slot.ts", "utf8");
    const orphaned = BOOK_SLOT_REFUSAL_SENTENCES.map((r) => r.sentence).filter(
      (s) => !source.includes(s),
    );
    expect(orphaned).toEqual([]);
  });
});
