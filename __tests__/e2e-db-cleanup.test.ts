// Pins e2e/demo/_db-cleanup.ts's target decision — the "LOCAL ONLY" guard that
// decides whether an e2e run may delete rows.
//
// THE DEFECT THIS TEST EXISTS TO PREVENT. The guard used to default an unset
// DATABASE_URL to `postgresql://…@localhost:54322/postgres`, so
// `isLocalDatabase()` answered YES on a machine with no database at all. The
// nightly (dim-interno:.github/workflows/e2e-nightly.yml) drives the deployed staging
// origin and sets no DATABASE_URL: every run since 2026-08-26 tried to connect
// to a Postgres that does not exist on the runner (AggregateError, 24 failures
// a night), and e2e/degraded-states.spec.ts — which skips itself on
// `!isLocalDatabase()` so it never registers a pet only a direct-to-Postgres
// helper could remove — believed it was local and ran against staging.
//
// It lives here, not in e2e/, for the reason _seed-profile's twin states:
// logic inside a Playwright spec is logic nobody can unit-test, and this one
// runs in vitest so the next regression is seconds away, not one nightly.
//
// DB-LESS BY CONSTRUCTION, IN TWO WAYS. Everything above the DELETE-ORDER
// section at the bottom goes through the pure decision or through an entry
// point that returns BEFORE opening a connection. That last section needs the
// happy path — the one that DOES connect — so it substitutes the postgres.js
// driver and records the statements the transaction issues. Still no database,
// and still the real function body: the claim it pins (which child rows are
// deleted, and in what order) is a property of the code, not of a fixture.

import postgres from "postgres";
import { type Mock, afterEach, describe, expect, it, vi } from "vitest";

import {
  deletePetsByNamePrefix,
  deleteTagsByLotePrefix,
  isLocalDatabase,
  resolveCleanupTarget,
} from "@/e2e/demo/_db-cleanup";

// Substituted for the whole file. Every test ABOVE the delete-order section
// returns before constructing a client, so the mock is simply never called
// there; the section at the bottom gives it an implementation of its own.
vi.mock("postgres", () => ({ default: vi.fn() }));

const LOCAL_URL = "postgresql://postgres:postgres@localhost:54322/postgres";
const LOOPBACK_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REMOTE_URL = "postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// FIRST, and deliberately so: the "no target declared" line is announced once
// per worker process (loginAs resets the login rate limits before every real
// sign-in, and one line per login would bury the report). A later test cannot
// observe the first announcement.
describe("an undeclared target refuses to delete, and says so once", () => {
  it("returns 0 without connecting, and prints exactly one line for the process", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Two different entry points, three calls: still one line. Each returns
    // from the target check, before `postgres(url)` is ever constructed, so
    // nothing here depends on a database being up or down.
    expect(await deletePetsByNamePrefix("E2EPet-")).toBe(0);
    expect(await deleteTagsByLotePrefix("TEST-LOTE-")).toBe(0);
    expect(await deletePetsByNamePrefix("ProbeAlta-")).toBe(0);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("DATABASE_URL is not set");
    // The line must be actionable: it names how a local run opts back in.
    expect(line).toContain("supabase status");
  });
});

describe("resolveCleanupTarget", () => {
  it("calls an unset DATABASE_URL undeclared — never localhost", () => {
    // THE REGRESSION PIN. The old code returned the local default here, which
    // is what sent the nightly at a database that does not exist.
    expect(resolveCleanupTarget({})).toEqual({ kind: "undeclared" });
    // Whitespace is not a declaration either.
    expect(resolveCleanupTarget({ DATABASE_URL: "   " })).toEqual({ kind: "undeclared" });
  });

  it("reproduces the nightly's environment exactly, and declines it", () => {
    // Non-vacuity with teeth: this is dim-interno:.github/workflows/e2e-nightly.yml's own
    // env block — a staging origin, Supabase keys, and no DATABASE_URL.
    expect(
      resolveCleanupTarget({
        STAGING_URL: "https://dim-staging.vercel.app",
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      }),
    ).toEqual({ kind: "undeclared" });
  });

  it("recognises a declared local database, by either spelling of this machine", () => {
    expect(resolveCleanupTarget({ DATABASE_URL: LOCAL_URL })).toEqual({
      kind: "local",
      url: LOCAL_URL,
    });
    expect(resolveCleanupTarget({ DATABASE_URL: LOOPBACK_URL })).toEqual({
      kind: "local",
      url: LOOPBACK_URL,
    });
    // Surrounding whitespace survives a hand-edited .env.
    expect(resolveCleanupTarget({ DATABASE_URL: `  ${LOCAL_URL}  ` })).toEqual({
      kind: "local",
      url: LOCAL_URL,
    });
  });

  it("calls a declared remote database remote — the pre-existing guard", () => {
    expect(resolveCleanupTarget({ DATABASE_URL: REMOTE_URL })).toEqual({
      kind: "remote",
      url: REMOTE_URL,
    });
  });
});

describe("isLocalDatabase", () => {
  it("judges an explicit URL on its host alone", () => {
    expect(isLocalDatabase(LOCAL_URL)).toBe(true);
    expect(isLocalDatabase(LOOPBACK_URL)).toBe(true);
    expect(isLocalDatabase(REMOTE_URL)).toBe(false);
    // A remote host that merely CONTAINS the word is not this machine.
    expect(isLocalDatabase("postgresql://u:p@localhost.evil.example.com:5432/db")).toBe(false);
  });

  it("is false with no argument when nothing declared a database", () => {
    // The no-argument form is the ENVIRONMENT gate degraded-states.spec.ts
    // skips on. False here is what stops that spec registering an undeletable
    // pet in a shared registry.
    vi.stubEnv("DATABASE_URL", undefined);
    expect(isLocalDatabase()).toBe(false);
  });

  it("is true with no argument when a local database is declared", () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    expect(isLocalDatabase()).toBe(true);
  });

  it("is false with no argument when the declared database is remote", () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    expect(isLocalDatabase()).toBe(false);
  });
});

describe("a declared remote target refuses to delete", () => {
  it("returns 0 and names the masked host, never the password", async () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await deletePetsByNamePrefix("E2EPet-")).toBe(0);

    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("is not local");
    expect(line).toContain("db.example.supabase.co");
    expect(line).not.toContain("hunter2");
  });
});

// ---------------------------------------------------------------------------
// THE DELETE ORDER
//
// `deletePetsByNamePrefix` promises "every pet whose name starts with prefix,
// plus the rows that hang off it", and one of those rows is load-bearing in a
// way the others are not. Migration 0038 gave every reference to `pets.id`
// `ON DELETE CASCADE`; `pet_tags` landed afterwards (0169:44) as a bare
// `pet_id uuid REFERENCES public.pets(id)` — NO ACTION — and the cleanup did
// not name it. One activated chapa on a doomed pet is therefore a 23503 on
// `DELETE FROM pets`, the transaction rolls back, and NOT ONE pet is removed:
// the whole pile this file's header describes returns, silently.
//
// So the order is behaviour, not formatting, and it is asserted by RUNNING the
// function against a substituted driver rather than by reading its source. A
// text fence over the SQL would grade the file's appearance — it would still
// pass if the DELETE moved outside the transaction, or behind a branch that
// never fires.
// ---------------------------------------------------------------------------

const ACTOR_ID = "11111111-1111-1111-1111-111111111111";
const DOOMED_PET_ID = "22222222-2222-2222-2222-222222222222";
/** The only prefix the substituted driver has a pet for. */
const DOOMED_PREFIX = "E2EPet-";

type FakeRow = Record<string, unknown>;
type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<FakeRow[]>) & {
  begin: (fn: (tx: FakeSql) => Promise<unknown>) => Promise<unknown>;
  end: (options?: unknown) => Promise<void>;
};

/**
 * A stand-in for the postgres.js client: a tagged template that RECORDS each
 * statement and answers the two SELECTs this code path makes. `BEGIN`/`COMMIT`
 * markers go into the same log so the transaction boundary can be asserted —
 * the rollback is the whole reason the order matters.
 */
function fakeSql(recorded: string[]): FakeSql {
  const run = (strings: TemplateStringsArray, ...values: unknown[]): Promise<FakeRow[]> => {
    const text = strings.join(" ? ").replace(/\s+/g, " ").trim();
    recorded.push(text);
    if (text.startsWith("SELECT p.id::text AS id FROM profiles")) {
      return Promise.resolve([{ id: ACTOR_ID }]);
    }
    if (text.startsWith("SELECT id::text AS id FROM pets")) {
      // Answer the LIKE pattern the caller actually passed, so a prefix that
      // matches nothing really does come back empty.
      return Promise.resolve(values[0] === `${DOOMED_PREFIX}%` ? [{ id: DOOMED_PET_ID }] : []);
    }
    return Promise.resolve([]);
  };
  const sql: FakeSql = Object.assign(run, {
    begin: async (fn: (tx: FakeSql) => Promise<unknown>) => {
      recorded.push("BEGIN");
      const result = await fn(sql);
      recorded.push("COMMIT");
      return result;
    },
    end: () => Promise.resolve(),
  });
  return sql;
}

/** The table each recorded `DELETE FROM x …` statement targets, in order. */
function deletedTables(recorded: string[]): string[] {
  const tables: string[] = [];
  for (const statement of recorded) {
    const match = /^DELETE FROM (\w+)/.exec(statement);
    if (match) tables.push(match[1]);
  }
  return tables;
}

describe("deletePetsByNamePrefix deletes every child row before the pet", () => {
  it("names pet_tags and pet_caretaker_grants — the two children a CASCADE read does not catch", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    const recorded: string[] = [];
    (postgres as unknown as Mock).mockImplementation(() => fakeSql(recorded));

    expect(await deletePetsByNamePrefix("E2EPet-")).toBe(1);

    // NON-VACUITY: a driver that recorded nothing would make every ordering
    // claim below trivially true — the failure shape this repo keeps
    // rediscovering in its own fences.
    expect(recorded.length).toBeGreaterThan(0);

    // Pinned as an exact sequence, in both directions. A child that stops being
    // deleted disappears from the left; a new one has to be added here on
    // purpose, which is the review this file exists to force.
    //
    // `pet_caretaker_grants` WAS ADDED 2026-09-07, and this fence is how it got
    // reviewed rather than slipped in — it went red on the first gate after the
    // writer changed, which is the whole point of pinning the sequence.
    //
    // It is FIRST, and the position is the claim. Unlike `pet_tags`, its FK to
    // `pets` IS ON DELETE CASCADE, so a reader auditing the children of `pets`
    // concludes it needs no line at all. The blocker is one statement earlier:
    // `ownership_id` references `ownerships` with ON DELETE SET NULL, and
    // `pet_caretaker_grants_accept_check` forbids an ACCEPTED grant without an
    // ownership — so the `ownerships` delete raises 23514, the transaction
    // rolls back, and NOTHING is removed. Measured on the shared registry the
    // same day, with 12 grants on doomed pets. Anywhere after `ownerships` and
    // the fix does not work.
    expect(deletedTables(recorded)).toEqual([
      "pet_caretaker_grants",
      "pet_events",
      "ownerships",
      "pet_identifications",
      "pet_tags",
      "pets",
    ]);
  });

  it("issues all of them inside ONE transaction — which is why the order decides everything", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    const recorded: string[] = [];
    (postgres as unknown as Mock).mockImplementation(() => fakeSql(recorded));

    await deletePetsByNamePrefix("E2EPet-");

    const begin = recorded.indexOf("BEGIN");
    const commit = recorded.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    for (const [index, statement] of recorded.entries()) {
      if (!statement.startsWith("DELETE FROM")) continue;
      expect(index, `${statement} ran outside the transaction`).toBeGreaterThan(begin);
      expect(index, `${statement} ran after the transaction closed`).toBeLessThan(commit);
    }
    // The spine's escape hatch is set LOCAL inside that same transaction, or
    // the BEFORE DELETE trigger on pet_events refuses the first statement.
    expect(recorded.slice(begin, commit).some((s) => s.includes("app.allow_event_mutation"))).toBe(
      true,
    );
  });

  it("opens no transaction when the prefix matches no pet", async () => {
    // The early return above `sql.begin`. Not decoration: it is what keeps a
    // future edit from sweeping child rows by prefix independently of the pet
    // list — a `DELETE FROM pet_tags` keyed on anything but the doomed ids
    // would take real stock with it.
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    const recorded: string[] = [];
    (postgres as unknown as Mock).mockImplementation(() => fakeSql(recorded));

    expect(await deletePetsByNamePrefix("NoSuchPrefix-")).toBe(0);

    expect(deletedTables(recorded)).toEqual([]);
    expect(recorded).not.toContain("BEGIN");
    // NON-VACUITY: it did reach the database, and asked the question.
    expect(recorded.some((s) => s.startsWith("SELECT id::text AS id FROM pets"))).toBe(true);
  });
});
