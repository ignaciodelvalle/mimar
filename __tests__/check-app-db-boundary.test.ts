/**
 * Unit tests for scripts/check-app-db-boundary.ts — the `app/` → database
 * boundary fence (canon decision B02, PO 2026-09-02).
 *
 * Two halves, and the repo has been burned by shipping only the first:
 *
 *   * FIXTURES prove the predicate can FAIL. A fence nobody has watched go red
 *     is a fence nobody knows is wired. Every failure mode this script claims —
 *     new writer, stale entry, drift, spine drift, empty corpus — is planted
 *     here and asserted.
 *   * The REAL TREE proves the committed baseline still describes it. That is
 *     the half that catches a baseline entry left behind by a fix, and it is
 *     the half `__tests__/check-application-fence.test.ts` had to be taught the
 *     hard way (2026-08-20: two frozen entries whose files were already clean).
 *
 * DB-less by construction: it reads the repo, nothing else.
 */

import { describe, expect, it } from "vitest";

import {
  type Baseline,
  type SourceFile,
  checkAppDbBoundary,
  classifyFile,
  collectAppFiles,
  loadBaseline,
} from "../scripts/check-app-db-boundary";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMPORT = 'import { db } from "@/db";\nimport { eq } from "drizzle-orm";\n';

const file = (path: string, body: string): SourceFile => ({ path, content: IMPORT + body });

const baseline = (
  writers: Baseline["writers"],
  meta: Partial<Baseline["_meta"]> = {},
): Baseline => ({
  _meta: {
    generatedAt: "2026-09-02",
    description: "fixture",
    readers: 0,
    spineWriters: 0,
    ...meta,
  },
  writers,
});

const READER = file(
  "app/gob/panel/page.tsx",
  "const rows = await db.select().from(pets).where(eq(pets.id, id));\n",
);

const WRITER = file(
  "app/gob/panel/actions.ts",
  "await db.insert(auditLog).values({ action: 'viewed' });\n",
);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classifyFile", () => {
  it("calls a select-only page READ-class (no kinds)", () => {
    expect(classifyFile(READER).kinds).toEqual([]);
  });

  it("names the idiom and the table of a direct insert", () => {
    const c = classifyFile(WRITER);
    expect(c.kinds).toEqual(["insert"]);
    expect(c.tables).toEqual(["auditLog"]);
  });

  it("sees a write split across lines — the shape the spine writer actually uses", () => {
    const c = classifyFile(
      file("app/x/action.ts", "await db\n  .insert(petEvents)\n  .values(v);"),
    );
    expect(c.kinds).toEqual(["insert"]);
    expect(c.spineTables).toEqual(["petEvents"]);
  });

  it("counts a transaction opened in app/ as a write, even when the module does the insert", () => {
    expect(
      classifyFile(file("app/x/actions.ts", "await db.transaction(async (tx) => run(tx));")),
    ).toMatchObject({ kinds: ["transaction"], tables: [] });
  });

  it("sees a write issued on the transaction handle", () => {
    const c = classifyFile(
      file("app/x/route.ts", "db.transaction(async (tx) => tx.update(cronRuns).set(s));"),
    );
    expect(c.kinds).toEqual(["transaction", "update"]);
    expect(c.tables).toEqual(["cronRuns"]);
  });

  it("does NOT mistake URLSearchParams.delete for a database delete", () => {
    // Live in this corpus: app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx
    // and app/org/[orgToken]/cobertura/CoverageEditor.tsx. A receiver-blind
    // `.delete(` rule classifies both as writers.
    expect(classifyFile(file("app/x/Panel.tsx", "params.delete(next);")).kinds).toEqual([]);
  });

  it("does NOT mistake a Set.delete for a database delete", () => {
    // Live in app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx.
    expect(
      classifyFile(file("app/x/Timeline.tsx", "const next = new Set(o); next.delete(id);")).kinds,
    ).toEqual([]);
  });

  it("leaves a read-only db.execute READ-class, inline or behind a const", () => {
    expect(
      classifyFile(file("app/api/health/route.ts", "await db.execute(sql`select 1`);")).kinds,
    ).toEqual([]);
    expect(
      classifyFile(
        file(
          "app/api/health/route.ts",
          "const STUCK = sql`select count(*) from pg_stat_activity`;\nawait db.execute(STUCK);",
        ),
      ).kinds,
    ).toEqual([]);
  });

  it("calls a mutating db.execute a write", () => {
    expect(
      classifyFile(file("app/x/route.ts", "await db.execute(sql`delete from scan_events`);")).kinds,
    ).toEqual(["execute", "sql"]);
  });

  it("treats raw SQL it cannot resolve as a write — a boundary fence may not guess", () => {
    expect(
      classifyFile(file("app/x/route.ts", "await db.execute(buildStatement(args));")).kinds,
    ).toEqual(["execute"]);
  });

  it("ignores a file that never reaches the database", () => {
    const plain = {
      path: "app/x/page.tsx",
      content: "export default function P() { return null; }",
    };
    const r = checkAppDbBoundary(baseline({}), [plain, WRITER, READER]);
    expect(r.readers.map((f) => f.path)).toEqual([READER.path]);
  });
});

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

describe("checkAppDbBoundary", () => {
  it("(a) FAILS on a new writer that is not baselined", () => {
    const r = checkAppDbBoundary(baseline({}), [READER, WRITER]);
    expect(r.violations).toEqual([
      { kind: "new-writer", file: WRITER.path, found: { kinds: ["insert"], tables: ["auditLog"] } },
    ]);
  });

  it("(b) FAILS on a baselined entry whose file is gone", () => {
    const r = checkAppDbBoundary(
      baseline({ "app/removed/actions.ts": { kinds: ["insert"], tables: ["auditLog"] } }),
      [READER],
    );
    expect(r.violations).toEqual([
      { kind: "stale-baseline", file: "app/removed/actions.ts", reason: "gone" },
    ]);
  });

  it("(b) FAILS on a baselined entry whose file no longer writes", () => {
    const r = checkAppDbBoundary(
      baseline({ [READER.path]: { kinds: ["insert"], tables: ["auditLog"] } }),
      [READER],
    );
    expect(r.violations).toEqual([
      { kind: "stale-baseline", file: READER.path, reason: "no-longer-writes" },
    ]);
  });

  it("(c) PASSES when every writer is baselined and the rest only read", () => {
    const r = checkAppDbBoundary(
      baseline({ [WRITER.path]: { kinds: ["insert"], tables: ["auditLog"] } }),
      [READER, WRITER],
    );
    expect(r.violations).toEqual([]);
    expect(r.readers.map((f) => f.path)).toEqual([READER.path]);
  });

  it("(c) tolerates an UNLIMITED number of new readers — that is the decision, not an oversight", () => {
    const readers = Array.from({ length: 40 }, (_, i) =>
      file(`app/gob/p${i}/page.tsx`, "await db.select().from(pets);"),
    );
    const r = checkAppDbBoundary(baseline({}), readers);
    expect(r.violations).toEqual([]);
    expect(r.readers).toHaveLength(40);
  });

  it("FAILS when a grandfathered writer's write surface grows", () => {
    const r = checkAppDbBoundary(
      baseline({ [WRITER.path]: { kinds: ["insert"], tables: ["auditLog"] } }),
      [file(WRITER.path, "await db.insert(auditLog).values(v);\nawait db.delete(scanEvents);")],
    );
    expect(r.violations).toEqual([
      {
        kind: "writer-drift",
        file: WRITER.path,
        recorded: { kinds: ["insert"], tables: ["auditLog"] },
        found: { kinds: ["delete", "insert"], tables: ["auditLog", "scanEvents"] },
      },
    ]);
  });

  it("FAILS when an already-baselined writer starts inserting into the spine (invariant #2)", () => {
    const spine = file("app/x/action.ts", "await db.insert(petEvents).values(v);");
    const r = checkAppDbBoundary(
      baseline({ [spine.path]: { kinds: ["insert"], tables: ["petEvents"] } }, { spineWriters: 0 }),
      [spine],
    );
    expect(r.violations).toEqual([
      { kind: "spine-drift", recorded: 0, actual: 1, files: [spine.path] },
    ]);
  });

  it("FAILS on an empty corpus — a glob that stopped matching is not a clean tree", () => {
    expect(checkAppDbBoundary(baseline({}), []).violations).toEqual([
      { kind: "empty-corpus", scanned: 0, touching: 0 },
    ]);
  });

  it("FAILS when nothing in the corpus reaches the database", () => {
    const none = [{ path: "app/x/page.tsx", content: "export default () => null;" }];
    expect(checkAppDbBoundary(baseline({}), none).violations).toEqual([
      { kind: "empty-corpus", scanned: 1, touching: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

describe("the real tree against the committed baseline", () => {
  const files = collectAppFiles();
  const committed = loadBaseline();
  const result = checkAppDbBoundary(committed, files);

  it("(d) scans a non-empty corpus", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("(d) passes — no new writer, no stale entry, no drift", () => {
    expect(result.violations).toEqual([]);
  });

  it("(d) the baseline names exactly the writers on the tree", () => {
    expect(Object.keys(committed.writers).sort()).toEqual(result.writers.map((w) => w.path).sort());
  });

  it("pins the spine writer count the decision named", () => {
    // B02: "spineWriters pinned at 1 — app/(public)/p/[publicToken]/encontre/action.ts
    // is the last non-test file in app/ that inserts into the event spine."
    expect(committed._meta.spineWriters).toBe(1);
    expect(result.spineWriters).toEqual(["app/(public)/p/[publicToken]/encontre/action.ts"]);
  });

  it("keeps the read-path count a SNAPSHOT — this test may not enforce what the fence reports", () => {
    // `_meta.readers` is "reported, never enforced" (check-app-db-boundary.ts:111,
    // and the decision quoted at :47-52). The code proves it: `checkAppDbBoundary`
    // raises no violation from that field — the only reader of it is `report()`
    // (:434-442), which prints the count with a `+N since the baseline` delta and
    // then moves on WITHOUT it reaching the exit code. The exit is decided one
    // block later, by `r.violations.length` alone (:444-447), so the reader count
    // can grow by any amount and the fence still exits 0 — while a real violation
    // still exits 1. The fixture test above ("tolerates an UNLIMITED number of new
    // readers — that is the decision, not an oversight") says the same thing from
    // the other side.
    //
    // So this assertion may NOT pin the number. A `toBe(result.readers.length)`
    // would make adding one read-only page under `app/` turn vitest red while
    // `pnpm lint:app-db-boundary` stayed green and printed `+1 since the
    // baseline` — a rule the fence disowns, enforced by its own test, with a
    // failure message that names no rule anybody agreed to. What IS enforced
    // against the real tree is the writer set, and that is asserted above.
    //
    // Pinned here instead: the shape the generator (`writeBaseline`) guarantees.
    expect(Number.isInteger(committed._meta.readers)).toBe(true);
    expect(committed._meta.readers).toBeGreaterThanOrEqual(0);
    // Non-vacuity: a read detector that stopped matching would report a clean
    // zero, and every "reads are tolerated" claim above would be true of nothing.
    expect(result.readers.length).toBeGreaterThan(0);
    // Read-class and write-class PARTITION the files that touch the database,
    // sorted by path. The disjointness half restates, from the reader end, the
    // property test (d) enforces from the writer end: a hand-edited baseline
    // that adds a read-only page to `writers` inflates the grandfathered list
    // and must fail, which it does as a `stale-baseline / no-longer-writes`.
    const readerPaths = result.readers.map((f) => f.path);
    expect(readerPaths).toEqual([...readerPaths].sort());
    expect(readerPaths.filter((p) => Object.hasOwn(committed.writers, p))).toEqual([]);
  });
});
