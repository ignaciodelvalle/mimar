// Tests for the forward-only migration runner (scripts/migrate.ts).
//
// Two layers:
//   1. Pure-logic unit tests — sorting, checksum, pending calc, baseline target
//      resolution, drift detection, CLI parsing. No DB, no I/O.
//   2. End-to-end tests against the LOCAL Postgres — they point the runner at a
//      THROWAWAY migrations dir and a THROWAWAY tracking table (via the
//      DIM_MIGRATIONS_DIR / DIM_MIGRATIONS_TABLE overrides), so the real
//      db/migrations tree and the real _dim_migrations table are never touched.
//      The throwaway migration creates and drops its own scratch table inside a
//      transaction, leaving zero residue in the public schema.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checksum,
  computePending,
  detectDrift,
  driftIsFatal,
  isNoTransaction,
  listMigrationFiles,
  parseArgs,
  resolveBaselineTargets,
} from "../scripts/migrate";

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("checksum", () => {
  it("is a stable sha256 hex digest of the contents", () => {
    expect(checksum("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("changes when the file contents change (drift signal)", () => {
    expect(checksum("create table a();")).not.toBe(checksum("create table a(); -- edited"));
  });
});

describe("listMigrationFiles", () => {
  it("returns only .sql files, lexically sorted (NNNN prefix => numeric order)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dim-list-"));
    try {
      writeFileSync(path.join(dir, "0010_b.sql"), "");
      writeFileSync(path.join(dir, "0002_a.sql"), "");
      writeFileSync(path.join(dir, "notes.txt"), "");
      writeFileSync(path.join(dir, "meta"), ""); // no .sql ext
      expect(listMigrationFiles(dir)).toEqual(["0002_a.sql", "0010_b.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computePending", () => {
  it("returns files not yet applied, in order, preserving gaps", () => {
    const all = ["0000_a.sql", "0002_b.sql", "0010_c.sql"];
    expect(computePending(all, new Set(["0000_a.sql"]))).toEqual(["0002_b.sql", "0010_c.sql"]);
  });

  it("returns empty when everything is applied", () => {
    const all = ["0000_a.sql", "0001_b.sql"];
    expect(computePending(all, new Set(all))).toEqual([]);
  });
});

describe("resolveBaselineTargets", () => {
  const all = ["0000_a.sql", "0001_b.sql", "0002_c.sql"];

  it("returns all files when no upTo is given", () => {
    expect(resolveBaselineTargets(all)).toEqual(all);
  });

  it("returns files up to and including upTo", () => {
    expect(resolveBaselineTargets(all, "0001_b.sql")).toEqual(["0000_a.sql", "0001_b.sql"]);
  });

  it("throws when upTo does not match a known file", () => {
    expect(() => resolveBaselineTargets(all, "9999_nope.sql")).toThrow(/not a migration file/);
  });
});

describe("detectDrift", () => {
  it("flags applied files whose on-disk checksum differs from the recorded one", () => {
    const all = ["0000_a.sql", "0001_b.sql"];
    const disk = new Map([
      ["0000_a.sql", "aaa"],
      ["0001_b.sql", "NEW"],
    ]);
    const recorded = new Map([
      ["0000_a.sql", "aaa"],
      ["0001_b.sql", "old"],
    ]);
    expect(detectDrift(all, disk, recorded)).toEqual(["0001_b.sql"]);
  });

  it("ignores files that are not yet applied", () => {
    const all = ["0000_a.sql"];
    const disk = new Map([["0000_a.sql", "x"]]);
    const recorded = new Map<string, string>(); // nothing applied
    expect(detectDrift(all, disk, recorded)).toEqual([]);
  });
});

describe("isNoTransaction", () => {
  it("returns true when first line is the directive", () => {
    expect(isNoTransaction("-- dim:no-transaction\ncreate index concurrently ...")).toBe(true);
  });

  it("returns true when directive is on line 3 (within first five)", () => {
    const sql = "-- migration: foo\n-- author: bar\n-- dim:no-transaction\nselect 1;";
    expect(isNoTransaction(sql)).toBe(true);
  });

  it("returns false when directive is absent", () => {
    expect(isNoTransaction("begin;\ncreate table foo (id int);\ncommit;")).toBe(false);
  });

  it("returns false when directive appears only after line 5", () => {
    const lines = [
      "-- line1",
      "-- line2",
      "-- line3",
      "-- line4",
      "-- line5",
      "-- dim:no-transaction",
    ];
    expect(isNoTransaction(lines.join("\n"))).toBe(false);
  });
});

describe("parseArgs", () => {
  it("defaults to forward-apply with no flags", () => {
    expect(parseArgs([])).toEqual({
      status: false,
      check: false,
      dryRun: false,
      baseline: false,
      strict: false,
      allowDrift: false,
    });
  });

  it("parses --allow-drift, and refuses it next to --strict", () => {
    expect(parseArgs(["--allow-drift"]).allowDrift).toBe(true);
    expect(() => parseArgs(["--strict", "--allow-drift"])).toThrow(/contradict/);
  });

  it("parses --status, --dry-run, --strict", () => {
    const cli = parseArgs(["--status", "--dry-run", "--strict"]);
    expect(cli.status).toBe(true);
    expect(cli.dryRun).toBe(true);
    expect(cli.strict).toBe(true);
  });

  it("parses --check", () => {
    expect(parseArgs(["--check"]).check).toBe(true);
    expect(parseArgs([]).check).toBe(false);
  });

  it("parses --baseline with an optional upTo positional", () => {
    expect(parseArgs(["--baseline", "0042_foo.sql"]).baselineUpTo).toBe("0042_foo.sql");
  });

  it("treats a trailing --baseline (no value) as baseline-all", () => {
    const cli = parseArgs(["--baseline"]);
    expect(cli.baseline).toBe(true);
    expect(cli.baselineUpTo).toBeUndefined();
  });

  it("does not swallow a following flag as the baseline target", () => {
    const cli = parseArgs(["--baseline", "--dry-run"]);
    expect(cli.baseline).toBe(true);
    expect(cli.baselineUpTo).toBeUndefined();
    expect(cli.dryRun).toBe(true);
  });

  it("throws on unknown args", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });
});

// C06-5: drift used to be a warning unless --strict, and no caller passed it.
describe("driftIsFatal — fatal by default", () => {
  it("is fatal for a bare apply, --dry-run and --check", () => {
    expect(driftIsFatal(parseArgs([]))).toBe(true);
    expect(driftIsFatal(parseArgs(["--dry-run"]))).toBe(true);
    expect(driftIsFatal(parseArgs(["--check"]))).toBe(true);
  });

  it("lets --status report without refusing, unless --strict", () => {
    expect(driftIsFatal(parseArgs(["--status"]))).toBe(false);
    expect(driftIsFatal(parseArgs(["--status", "--strict"]))).toBe(true);
  });

  it("downgrades to a warning only under --allow-drift", () => {
    expect(driftIsFatal(parseArgs(["--allow-drift"]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against the local DB (throwaway dir + table — no real schema touch)
// ---------------------------------------------------------------------------

const RUNNER = path.join(process.cwd(), "scripts", "migrate.ts");
const SCRATCH_TABLE = "_dim_migrations_test";

// Default sentinel points to a table that never exists in the test DB so the
// schema-populated guard does not fire for tests that don't intend to test it.
// The guard test overrides this via extraEnv.
const NO_SENTINEL = "public._dim_e2e_no_sentinel_table";

function runMigrate(args: string[], migrationsDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("pnpm", ["tsx", RUNNER, ...args], {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      DIM_MIGRATIONS_DIR: migrationsDir,
      DIM_MIGRATIONS_TABLE: SCRATCH_TABLE,
      DIM_SCHEMA_SENTINEL: NO_SENTINEL,
      ...extraEnv,
    },
  });
}

// Each case spawns the runner via `pnpm tsx` one or more times; tsx cold-start
// is a few seconds, so the default 5s timeout is too tight for the cases that
// spawn twice. 30s is comfortable headroom without masking real hangs.
describe("migrate runner e2e (local DB, scratch dir + table)", { timeout: 30_000 }, () => {
  let dir: string;
  const sql = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 1 });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dim-mig-e2e-"));
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    // Drop the scratch tracking + any residue table so each test starts clean.
    await sql.unsafe(`drop table if exists public.${SCRATCH_TABLE}`);
    await sql.unsafe("drop table if exists public._dim_e2e_scratch");
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("applies a pending migration and records a tracking row", async () => {
    // A self-contained migration: create then keep a scratch table. Wrapped in
    // its own transaction so it is atomic regardless of the runner.
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      "begin;\ncreate table public._dim_e2e_scratch (id int primary key);\ncommit;\n",
    );

    const res = runMigrate([], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Applied 1 migration");

    // The scratch table now exists ...
    const created = await sql.unsafe("select to_regclass('public._dim_e2e_scratch') as r");
    expect(created[0].r).toBe("_dim_e2e_scratch");

    // ... and the tracking row landed with a checksum.
    const rows = await sql.unsafe<{ filename: string; checksum: string }[]>(
      `select filename, checksum from public.${SCRATCH_TABLE}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("0000_e2e.sql");
    expect(rows[0].checksum).toHaveLength(64); // sha256 hex
  });

  it("is a no-op on the second run (already tracked => skipped)", async () => {
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      "begin;\ncreate table public._dim_e2e_scratch (id int primary key);\ncommit;\n",
    );

    expect(runMigrate([], dir).status).toBe(0);
    const second = runMigrate([], dir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Nothing pending");
  });

  it("checksum drift refuses a bare run (exit 3); --status and --allow-drift go on", async () => {
    const file = path.join(dir, "0000_e2e.sql");
    writeFileSync(file, "select 1;\n");
    expect(runMigrate([], dir).status).toBe(0);
    // Edit the applied file: the ledger's checksum no longer matches.
    writeFileSync(file, "select 2;\n");

    const bare = runMigrate([], dir);
    expect(bare.status, bare.stdout).toBe(3);
    expect(bare.stderr).toContain("checksum drift");

    expect(runMigrate(["--status"], dir).status).toBe(0);
    expect(runMigrate(["--status", "--strict"], dir).status).toBe(3);
    expect(runMigrate(["--allow-drift"], dir).status).toBe(0);
    // Five tsx cold starts: more than the describe's 30 s allows for two.
  }, 90_000);

  it("--baseline marks files applied WITHOUT executing their SQL", async () => {
    // This migration would FAIL if executed (references a missing table), proving
    // baseline never runs the SQL.
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      "insert into public._dim_no_such_table values (1);\n",
    );

    const res = runMigrate(["--baseline"], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("No migration SQL executed");

    const rows = await sql.unsafe(`select count(*)::int n from public.${SCRATCH_TABLE}`);
    expect(rows[0].n).toBe(1);
    // The bogus table never got created — SQL was not run.
    const probe = await sql.unsafe("select to_regclass('public._dim_no_such_table') as r");
    expect(probe[0].r).toBeNull();
  });

  it("--status reports applied vs pending", async () => {
    writeFileSync(path.join(dir, "0000_e2e.sql"), "select 1;\n");
    writeFileSync(path.join(dir, "0001_e2e.sql"), "select 1;\n");
    // Baseline only the first, leaving the second pending.
    expect(runMigrate(["--baseline", "0000_e2e.sql"], dir).status).toBe(0);

    const res = runMigrate(["--status"], dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Applied        : 1");
    expect(res.stdout).toContain("Pending        : 1");
    expect(res.stdout).toContain("0001_e2e.sql");
  });

  it("--check exits 6 when migrations are pending, 0 when up to date (deploy gate)", async () => {
    writeFileSync(path.join(dir, "0000_e2e.sql"), "select 1;\n");
    writeFileSync(path.join(dir, "0001_e2e.sql"), "select 1;\n");
    // Baseline only the first, leaving the second pending.
    expect(runMigrate(["--baseline", "0000_e2e.sql"], dir).status).toBe(0);

    // Pending => the gate must fail loudly so a deploy aborts.
    const behind = runMigrate(["--check"], dir);
    expect(behind.status).toBe(6);
    expect(behind.stdout).toContain("Pending        : 1");
    expect(behind.stderr).toContain("pending against this database");

    // Once everything is applied, the gate passes.
    expect(runMigrate(["--baseline"], dir).status).toBe(0);
    const upToDate = runMigrate(["--check"], dir);
    expect(upToDate.status, upToDate.stderr).toBe(0);
    expect(upToDate.stdout).toContain("Pending        : 0");
  });

  it("fails fast on a broken migration and reports the file", async () => {
    writeFileSync(path.join(dir, "0000_e2e.sql"), "this is not valid sql;\n");
    const res = runMigrate([], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("0000_e2e.sql");
  });

  it("transaction rollback: a mid-file failure leaves DB unchanged and no tracking row; retry succeeds after fix", async () => {
    // First attempt: statement 1 creates a table, statement 2 is invalid.
    // With the transaction wrapper, the whole file rolls back — the table must
    // NOT exist after the failure.
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      "create table public._dim_e2e_scratch (id int primary key);\nthis is intentionally invalid sql;\n",
    );

    const failRun = runMigrate([], dir);
    expect(failRun.status).toBe(1);
    expect(failRun.stderr).toContain("0000_e2e.sql");

    // The scratch table must NOT exist — rollback worked.
    const afterFail = await sql.unsafe("select to_regclass('public._dim_e2e_scratch') as r");
    expect(afterFail[0].r).toBeNull();

    // No tracking row must have been inserted.
    const tracked = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int n from public.${SCRATCH_TABLE}`,
    );
    expect(tracked[0].n).toBe(0);

    // Fix the file and retry — must succeed cleanly.
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      "create table public._dim_e2e_scratch (id int primary key);\n",
    );

    const retryRun = runMigrate([], dir);
    expect(retryRun.status, retryRun.stderr).toBe(0);
    expect(retryRun.stdout).toContain("Applied 1 migration");

    // Table now exists and tracking row landed.
    const afterRetry = await sql.unsafe("select to_regclass('public._dim_e2e_scratch') as r");
    expect(afterRetry[0].r).toBe("_dim_e2e_scratch");

    const trackedAfterRetry = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int n from public.${SCRATCH_TABLE}`,
    );
    expect(trackedAfterRetry[0].n).toBe(1);
  });

  it("-- dim:no-transaction directive: file runs unwrapped (no BEGIN/COMMIT injected)", async () => {
    // A migration that opts out of wrapping. We prove it ran (creates the table)
    // and that the runner accepted the directive without errors.
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      `${[
        "-- dim:no-transaction",
        "create table public._dim_e2e_scratch (id int primary key);",
      ].join("\n")}\n`,
    );

    const res = runMigrate([], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("[no-transaction]");
    expect(res.stdout).toContain("Applied 1 migration");

    const created = await sql.unsafe("select to_regclass('public._dim_e2e_scratch') as r");
    expect(created[0].r).toBe("_dim_e2e_scratch");
  });

  it("-- dim:no-transaction: multi-statement file splits per statement (CONCURRENTLY works)", async () => {
    // CREATE INDEX CONCURRENTLY cannot run inside a transaction block — including
    // the implicit one postgres.js wraps around multi-statement strings. This
    // proves the splitter executes each statement on its own round-trip.
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      `${[
        "-- dim:no-transaction",
        "create table public._dim_e2e_scratch (id int primary key, val text);",
        "-- a comment between statements",
        "create index concurrently if not exists _dim_e2e_scratch_val_idx on public._dim_e2e_scratch (val);",
        "create index concurrently if not exists _dim_e2e_scratch_val2_idx on public._dim_e2e_scratch (val) where val is not null;",
      ].join("\n")}\n`,
    );

    const res = runMigrate([], dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Applied 1 migration");

    const idx = await sql.unsafe<{ indexname: string }[]>(
      "select indexname from pg_indexes where tablename = '_dim_e2e_scratch' order by indexname",
    );
    const names = idx.map((r) => r.indexname);
    expect(names).toContain("_dim_e2e_scratch_val_idx");
    expect(names).toContain("_dim_e2e_scratch_val2_idx");
  });

  it("-- dim:no-transaction: refuses dollar-quoted bodies (splitter cannot parse them)", async () => {
    writeFileSync(
      path.join(dir, "0000_e2e.sql"),
      `${["-- dim:no-transaction", "do $$ begin perform 1; end $$;"].join("\n")}\n`,
    );

    const res = runMigrate([], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("dollar-quoting");
  });

  it("schema-populated guard: refuses apply when tracking is empty but sentinel table exists; allows baseline", async () => {
    // Throwaway sentinel, so we do not touch the real public.pets table.
    //
    // Vive en su PROPIO SCHEMA y no en `public` (2026-08-13). Antes era
    // `public._dim_e2e_guard_sentinel`, y el `finally` de abajo la borraba —
    // salvo cuando el proceso muere de golpe (una corrida interrumpida, un
    // kill). Ahí quedaba huérfana en `public` y hacía fallar `lint:rls`, que
    // audita `public` y con razón exige RLS en cada tabla.
    //
    // La respuesta no es limpiar mejor ni relajar el fence: es que el andamio
    // de test no viva donde el fence mira. Un fence que hay que enseñarle a
    // ignorar cosas deja de ser un fence.
    const SENTINEL = "_dim_e2e.guard_sentinel";
    const guardEnv = { DIM_SCHEMA_SENTINEL: SENTINEL };

    await sql.unsafe("create schema if not exists _dim_e2e");
    await sql.unsafe(`create table if not exists ${SENTINEL} (id int primary key)`);

    try {
      writeFileSync(path.join(dir, "0000_e2e.sql"), "select 1;\n");

      // Forward apply must refuse (exit 5) because the DB looks provisioned but
      // has no migration tracking rows.
      const applyRes = runMigrate([], dir, guardEnv);
      expect(applyRes.status).toBe(5);
      expect(applyRes.stderr).toContain("already has schema but no migration tracking");
      expect(applyRes.stderr).toContain("db:migrate:baseline");

      // Baseline must still work — the guard only blocks forward apply.
      const baselineRes = runMigrate(["--baseline"], dir, guardEnv);
      expect(baselineRes.status, baselineRes.stderr).toBe(0);
      expect(baselineRes.stdout).toContain("No migration SQL executed");

      // After baseline, forward apply is also allowed (tracking is no longer empty).
      // Status should confirm 0 pending.
      const statusRes = runMigrate(["--status"], dir, guardEnv);
      expect(statusRes.status).toBe(0);
      expect(statusRes.stdout).toContain("Pending        : 0");
    } finally {
      await sql.unsafe("drop schema if exists _dim_e2e cascade");
    }
  });
});
