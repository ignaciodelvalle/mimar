// The owner pet-list door — the decisions that used to live inside a React
// server component and could only be tested by rendering HTML.
//
// The collaborators are injected, so what is asserted here is the part that is
// actually a DECISION: which pets count as the caller's, how the optional name
// filter is applied, that the COUNT runs under the same predicate as the rows,
// and that the cap is the caller's to override but the default is the door's.
//
// The SQL itself is not re-implemented here — a test that asserted on a drizzle
// AST would pin the query builder's internals rather than the behaviour. What is
// asserted is that both collaborators receive the SAME predicate object, which is
// the property that makes "showing N of M" honest and is exactly what a
// hand-copied second query gets wrong.

import { db, pets } from "@/db";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { OWNER_PET_LIST_LIMIT, type OwnerPetListRow, listOwnerPets } from "./list-owner-pets";

const OWNER = "11111111-1111-4111-8111-111111111111";

/**
 * A predicate as text plus its bound parameters.
 *
 * `JSON.stringify` cannot be used on a drizzle predicate — every column holds a
 * back-reference to its table, so the object is circular. `toSQL()` compiles
 * without touching Postgres and is what the query planner would actually see,
 * which is the thing worth asserting on anyway.
 */
function compile(predicate: SQL | undefined): { sql: string; params: unknown[] } {
  const { sql, params } = db.select().from(pets).where(predicate).toSQL();
  return { sql, params };
}

function fakeRow(name: string): OwnerPetListRow {
  return {
    pet: {
      id: "22222222-2222-4222-8222-222222222222",
      name,
      status: "active",
      species: "dog",
      breed: null,
      sex: "unknown",
      pregnancyStatus: null,
      publicToken: `DIM-${name.toUpperCase().slice(0, 4)}-0001`,
    },
    photo: null,
    ownershipRole: "owner",
  } as OwnerPetListRow;
}

/**
 * Injected collaborators that RECORD what predicate they were handed.
 *
 * The parameters are declared even though the bodies ignore them: a `vi.fn`
 * with no declared signature types `mock.calls` as an empty tuple, so every
 * `calls[0][0]` below would be a compile error rather than the assertion it
 * looks like.
 */
function harness(rows: OwnerPetListRow[], total: number) {
  const fetchRows = vi.fn(async (_where: SQL | undefined, _limit: number) => rows);
  const countRows = vi.fn(async (_where: SQL | undefined) => total);
  return { fetchRows, countRows };
}

describe("listOwnerPets", () => {
  it("returns the rows and the matching total", async () => {
    const deps = harness([fakeRow("Pampa")], 1);

    const result = await listOwnerPets({ ownerUserId: OWNER }, deps);

    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("applies the door's cap when the caller names none", async () => {
    const deps = harness([], 0);
    await listOwnerPets({ ownerUserId: OWNER }, deps);
    expect(deps.fetchRows).toHaveBeenCalledWith(expect.anything(), OWNER_PET_LIST_LIMIT);
  });

  it("lets a caller narrow the cap — the web index passes its own", async () => {
    const deps = harness([], 0);
    await listOwnerPets({ ownerUserId: OWNER, limit: 5 }, deps);
    expect(deps.fetchRows).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it("counts under the SAME predicate the rows were fetched with", async () => {
    // The property that makes the "showing N of M" notice honest. A count over a
    // DIFFERENT predicate is a notice that lies precisely when someone is
    // searching — the moment an owner most needs it to be true.
    const deps = harness([fakeRow("Pampa")], 340);

    await listOwnerPets({ ownerUserId: OWNER, query: "pam" }, deps);

    const rowsPredicate = deps.fetchRows.mock.calls[0][0];
    const countPredicate = deps.countRows.mock.calls[0][0];
    expect(countPredicate).toBe(rowsPredicate);
  });

  it("builds a predicate WITHOUT a name filter when the query is empty", async () => {
    // `and()` drops an undefined, so the unfiltered path must be identical to
    // having no filter at all — not a filter that matches everything, which is a
    // different query plan.
    const withQuery = harness([], 0);
    const withoutQuery = harness([], 0);

    await listOwnerPets({ ownerUserId: OWNER, query: "pam" }, withQuery);
    await listOwnerPets({ ownerUserId: OWNER }, withoutQuery);

    const filtered = compile(withQuery.fetchRows.mock.calls[0][0]);
    const unfiltered = compile(withoutQuery.fetchRows.mock.calls[0][0]);
    expect(filtered.sql).toContain("ILIKE");
    expect(unfiltered.sql).not.toContain("ILIKE");
  });

  it("treats a whitespace-only query as no query", async () => {
    const deps = harness([], 0);
    await listOwnerPets({ ownerUserId: OWNER, query: "   " }, deps);
    expect(compile(deps.fetchRows.mock.calls[0][0]).sql).not.toContain("ILIKE");
  });

  it("escapes LIKE wildcards in the caller's query", async () => {
    // `likeContains` backslash-escapes % and _ and the predicate carries an
    // explicit ESCAPE clause. Without it, an owner searching for "100%" matches
    // every pet they have — and so does an owner searching for "_".
    const deps = harness([], 0);

    await listOwnerPets({ ownerUserId: OWNER, query: "100%" }, deps);

    const compiled = compile(deps.fetchRows.mock.calls[0][0]);
    expect(compiled.sql).toContain("ESCAPE");
    expect(compiled.params).toContain("%100\\%%");
  });

  it("runs the two reads concurrently, not one after the other", async () => {
    // The web index awaits this inside a Promise.all of seven aggregates on the
    // page an owner opens first; serialising the pair here would add a whole
    // round-trip to that page's critical path for no reason.
    const order: string[] = [];
    let releaseRows!: () => void;
    const rowsGate = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });

    const deps = {
      fetchRows: async () => {
        order.push("rows:start");
        await rowsGate;
        order.push("rows:end");
        return [];
      },
      countRows: async () => {
        order.push("count:start");
        releaseRows();
        return 0;
      },
    };

    await listOwnerPets({ ownerUserId: OWNER }, deps);

    // The count STARTED before the rows finished. If they were sequential the
    // rows promise would never be released and this would hang.
    expect(order).toEqual(["rows:start", "count:start", "rows:end"]);
  });
});
