#!/usr/bin/env tsx
/**
 * Forward-only migration runner for db/migrations/*.sql.
 *
 * WHY THIS EXISTS
 * ---------------
 * `db/migrations/meta/_journal.json` is `{ ..., "entries": [] }` — EMPTY. The
 * 87-number / 85-file migration tree under db/migrations/ was hand-authored, not
 * produced by `drizzle-kit generate`, so drizzle never recorded a journal entry
 * for any of them. As a result `drizzle-kit migrate` (the old `db:migrate`)
 * applied ZERO migrations — a silent no-op. Every environment got its schema
 * from the UNTRACKED ordered replay in scripts/db-bootstrap.ts instead. That
 * made the documented deploy contract ("prod runs db:migrate") dangerously
 * false: a deployer could run it, nothing happens, and code ships expecting a
 * schema that was never applied.
 *
 * This runner replaces that no-op with a real, tracked, forward-only applier.
 *
 * TRACKING TABLE
 * --------------
 *   public._dim_migrations (
 *     filename   text PRIMARY KEY,
 *     checksum   text NOT NULL,          -- sha256 of the file's bytes
 *     applied_at timestamptz NOT NULL DEFAULT now()
 *   )
 * A dedicated table — deliberately NOT drizzle's `drizzle.__drizzle_migrations`,
 * so the two schemes can never collide or confuse each other.
 *
 * EXECUTION MODEL — per-file transaction wrapping
 * -----------------------------------------------
 * Each migration file is wrapped in BEGIN/COMMIT by default so that a failure
 * on any statement rolls the whole file back, leaving the DB unchanged and the
 * tracking row uninserted — safe to retry after fixing the file.
 *
 * OPT-OUT DIRECTIVE — `-- dim:no-transaction`
 * Some statements CANNOT run inside a transaction block:
 *   - `CREATE INDEX CONCURRENTLY`
 *   - `ALTER TYPE … ADD VALUE`
 * If the file's first five lines contain the header comment
 *   `-- dim:no-transaction`
 * the runner executes it UNwrapped (bare `sql.unsafe(contents)`), exactly as
 * the old behaviour. Such migrations MUST be authored idempotently (using IF
 * NOT EXISTS / IF EXISTS guards) because a partial failure cannot be rolled
 * back — the DB may be in an intermediate state and the next run will re-apply
 * from the start of that file.
 *
 * Note: the runner does NOT auto-detect CONCURRENTLY or ADD VALUE by scanning
 * SQL text — that would be fragile (the keywords can appear in comments or
 * string literals). Use the explicit header directive instead.
 *
 * THE BASELINE PROBLEM (read before running against prod)
 * -------------------------------------------------------
 * Existing databases (prod, current local) ALREADY have all migrations applied
 * via the untracked bootstrap replay, but `_dim_migrations` is empty. Running
 * a forward apply on such a DB would re-apply from 0000 onward: it would fail
 * partway through 0000 (e.g. on a non-guarded ADD CONSTRAINT after an earlier
 * statement already committed via -- dim:no-transaction semantics). The runner
 * now detects this state automatically — see the "schema-populated guard" below
 * — and refuses to proceed, printing a clear message to run baseline first.
 * Adopting the runner on an already-provisioned DB MUST start with `--baseline`,
 * which records every migration as applied WITHOUT executing any SQL.
 * Forward-apply on a baselined DB is then a correct no-op.
 * GET THIS WRONG AND YOU BRICK PROD.
 *
 * SCHEMA-POPULATED GUARD
 * ----------------------
 * Before a forward apply (not baseline, not status, not dry-run), if
 * `_dim_migrations` is empty AND `public.pets` already exists, the runner
 * refuses with exit code 5 and instructs the operator to run baseline first.
 * This converts the unbaselined-prod path from a confusing partial failure into
 * a clear, actionable abort.
 *
 * CLI
 * ---
 *   tsx scripts/migrate.ts                 apply all pending migrations
 *   tsx scripts/migrate.ts --status        print applied vs pending, then exit 0
 *   tsx scripts/migrate.ts --check         like --status, but EXIT 6 if anything
 *                                          is pending (a deploy gate: fail the
 *                                          build before code ships ahead of DB)
 *   tsx scripts/migrate.ts --dry-run       print what WOULD apply, apply nothing
 *   tsx scripts/migrate.ts --baseline      mark ALL files applied, run no SQL
 *   tsx scripts/migrate.ts --baseline 0042_foo.sql
 *                                          mark files up to (incl.) 0042 applied
 *   tsx scripts/migrate.ts --strict        drift is fatal in EVERY mode, --status included
 *   tsx scripts/migrate.ts --allow-drift   downgrade drift to a warning — only for
 *                                          an exception recorded in
 *                                          docs/db/migration-errata.md
 *
 * CHECKSUM DRIFT IS FATAL BY DEFAULT (C06-5, 2026-09). It used to be a warning
 * unless --strict was passed, and no caller passed it — deploy:staging ran the
 * bare runner — so an edited, already-applied migration shipped with a banner
 * nobody reads in a deploy log. Now apply, --dry-run and --check refuse on
 * drift (exit 3). --status stays informational (it prints the drifted files and
 * exits 0) unless --strict is also given. --strict and --allow-drift together
 * are a usage error.
 *
 * Flags combine where sensible (e.g. `--baseline --dry-run` previews a baseline).
 *
 * ENV
 *   DATABASE_URL   required (read from .env.local / .env, same as bootstrap)
 *
 * EXIT CODES
 *   0  success
 *   1  a migration failed to apply (forward-apply path)
 *   2  DATABASE_URL not set
 *   3  checksum drift detected (any mode but --status, unless --allow-drift)
 *   4  bad CLI usage (e.g. --baseline target not found)
 *   5  schema-populated guard tripped (unbaselined existing DB detected)
 *   6  --check found pending migrations (DB is behind the committed tree)
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import postgres from "postgres";

import { describeTarget } from "./_db-target";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default migration source. Overridable via DIM_MIGRATIONS_DIR strictly to let
// the e2e test point the runner at a throwaway dir + table — production paths
// never set it.
const MIGRATIONS_DIR = process.env.DIM_MIGRATIONS_DIR ?? "db/migrations";
const TRACKING_TABLE = process.env.DIM_MIGRATIONS_TABLE ?? "_dim_migrations";
// Sentinel table used by the schema-populated guard (issue #2). Overridable by
// tests so they can use a throwaway sentinel instead of the real public.pets.
const SCHEMA_SENTINEL = process.env.DIM_SCHEMA_SENTINEL ?? "public.pets";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/migrate-runner.test.ts)
// ---------------------------------------------------------------------------

/** sha256 hex digest of a file's contents. Stable, fast, collision-safe here. */
export function checksum(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * List migration filenames (basename only), lexically sorted. The NNNN_ prefix
 * makes lexical order equal numeric order; gaps in numbering (e.g. 0009, 0057
 * are absent) are irrelevant because we sort by the actual filenames present.
 */
export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Given all files and the set already recorded as applied, return the files
 * that still need to run, in apply order.
 */
export function computePending(allFiles: string[], applied: Set<string>): string[] {
  return allFiles.filter((f) => !applied.has(f));
}

/**
 * Resolve which files a `--baseline [upTo]` invocation should mark.
 * - No `upTo`     → every file.
 * - `upTo` given  → every file up to and INCLUDING `upTo` (lexical).
 * Throws if `upTo` is provided but does not match a known file.
 */
export function resolveBaselineTargets(allFiles: string[], upTo?: string): string[] {
  if (!upTo) return [...allFiles];
  const idx = allFiles.indexOf(upTo);
  if (idx === -1) {
    throw new Error(
      `--baseline target "${upTo}" is not a migration file. ` +
        `Expected a basename like "0042_foo.sql" present in ${MIGRATIONS_DIR}/.`,
    );
  }
  return allFiles.slice(0, idx + 1);
}

/**
 * Compare on-disk checksums against the recorded ones for files already applied.
 * Returns the list of files whose stored checksum differs from disk — i.e. a
 * migration file was edited after being applied (a real hazard: the DB no
 * longer matches the committed SQL).
 */
export function detectDrift(
  allFiles: string[],
  diskChecksums: Map<string, string>,
  recorded: Map<string, string>,
): string[] {
  const drifted: string[] = [];
  for (const f of allFiles) {
    const stored = recorded.get(f);
    if (stored === undefined) continue; // not applied yet — nothing to drift
    const disk = diskChecksums.get(f);
    if (disk !== undefined && disk !== stored) drifted.push(f);
  }
  return drifted;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Cli {
  status: boolean;
  check: boolean;
  dryRun: boolean;
  baseline: boolean;
  baselineUpTo?: string;
  strict: boolean;
  allowDrift: boolean;
}

/**
 * Does checksum drift stop this run? Fatal by default; --allow-drift is the
 * written-down exception, --status is a report and not a gate, and --strict
 * makes even the report refuse.
 */
export function driftIsFatal(cli: Pick<Cli, "strict" | "allowDrift" | "status">): boolean {
  if (cli.strict) return true;
  if (cli.allowDrift) return false;
  return !cli.status;
}

export function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    status: false,
    check: false,
    dryRun: false,
    baseline: false,
    strict: false,
    allowDrift: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--status":
        cli.status = true;
        break;
      case "--check":
        cli.check = true;
        break;
      case "--dry-run":
        cli.dryRun = true;
        break;
      case "--strict":
        cli.strict = true;
        break;
      case "--allow-drift":
        cli.allowDrift = true;
        break;
      case "--baseline": {
        cli.baseline = true;
        // Optional positional value immediately after --baseline that isn't a flag.
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          cli.baselineUpTo = next;
          i += 1;
        }
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (cli.strict && cli.allowDrift) {
    throw new Error("--strict and --allow-drift contradict each other; pass one of them.");
  }
  return cli;
}

// ---------------------------------------------------------------------------
// DB layer
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

async function ensureTrackingTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create table if not exists public.${TRACKING_TABLE} (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    );
  `);
  // Secure the tracking table with RLS deny-all (Supabase advisor
  // rls_disabled_in_public, migration 0113). The runner owns this table's
  // creation, so enabling RLS here closes the finding in EVERY path: db:migrate
  // creates _dim_migrations before applying 0113, and db:bootstrap creates it in
  // its baseline step — which runs AFTER the best-effort migration replay, so
  // 0113's own ALTER cannot reach it. Idempotent: no-op if already enabled. The
  // runner connects as postgres (BYPASSRLS), so deny-all never blocks it.
  await sql.unsafe(`alter table public.${TRACKING_TABLE} enable row level security;`);
}

/** Read the recorded migrations as filename → checksum. */
async function readRecorded(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql.unsafe<{ filename: string; checksum: string }[]>(
    `select filename, checksum from public.${TRACKING_TABLE}`,
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function recordApplied(sql: Sql, filename: string, sum: string): Promise<void> {
  await sql`
    insert into public.${sql(TRACKING_TABLE)} (filename, checksum)
    values (${filename}, ${sum})
    on conflict (filename) do update set checksum = excluded.checksum
  `;
}

/**
 * Returns true when the file should run WITHOUT a transaction wrapper.
 * Checks only the first five lines for the `-- dim:no-transaction` directive.
 * Using an explicit directive (rather than scanning for CONCURRENTLY / ADD VALUE)
 * is intentional — keyword scanning is fragile when those words appear in
 * comments or string literals.
 */
export function isNoTransaction(contents: string): boolean {
  const firstFiveLines = contents.split("\n").slice(0, 5).join("\n");
  return firstFiveLines.includes("-- dim:no-transaction");
}

/**
 * Guard: before a forward apply, check whether the DB already has application
 * schema without any migration tracking. Probes for `SCHEMA_SENTINEL`
 * (defaults to `public.pets`; overridable via DIM_SCHEMA_SENTINEL for tests)
 * and refuses if it exists while the tracking table is empty.
 * Returns true when the guard trips (caller should exit with code 5).
 */
async function schemaPopulatedButUntracked(sql: Sql, recordedCount: number): Promise<boolean> {
  if (recordedCount > 0) return false; // tracking is populated — safe to apply
  const rows = await sql.unsafe<{ r: string | null }[]>(
    `select to_regclass('${SCHEMA_SENTINEL}') as r`,
  );
  return rows[0].r !== null;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function header(title: string): void {
  const line = "=".repeat(Math.max(40, title.length + 4));
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function warnDrift(drifted: string[]): void {
  console.warn(
    [
      "",
      "**********************************************************************",
      `  WARNING: checksum drift on ${drifted.length} already-applied migration(s).`,
      "  These files were edited AFTER being applied — the database no longer",
      "  matches the committed SQL. Investigate before trusting this schema.",
      "**********************************************************************",
      ...drifted.map((f) => `    - ${f}`),
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error(
      "ERROR: DATABASE_URL is not set. Copy .env.local.example to .env.local " +
        "or export DATABASE_URL before running this script.",
    );
    process.exit(2);
  }

  // A QUÉ BASE, ANTES DE TOCARLA.
  //
  // Este script hace lo más irreversible del repo y era el ÚNICO que no decía
  // dónde estaba parado: los seeds y repair:dni imprimen su destino desde
  // 5bee0f27, migrate.ts no. Al aplicar a staging el 2026-08-13 hubo que
  // comparar los refs a mano contra NEXT_PUBLIC_SUPABASE_URL porque la
  // herramienta no lo mostraba — un paso manual justo antes de la operación que
  // menos admite equivocarse de destino.
  //
  // El ref importa más que el host: los dos proyectos Supabase de la cuenta
  // comparten el mismo pooler, así que el host solo no distingue producción de
  // staging. describeTarget lo recupera del usuario de la URL.
  const target = describeTarget(DATABASE_URL);
  console.log("");
  console.log(`  Destino: ${target.label}${target.isLocal ? "  [LOCAL]" : "  [REMOTO]"}`);
  if (target.parseError) {
    console.log(`  (no se pudo parsear la URL: ${target.parseError})`);
  }
  console.log("");

  const allFiles = listMigrationFiles(MIGRATIONS_DIR);
  const diskChecksums = new Map<string, string>();
  for (const f of allFiles) {
    diskChecksums.set(f, checksum(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")));
  }

  const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

  try {
    await ensureTrackingTable(sql);
    const recorded = await readRecorded(sql);
    const appliedSet = new Set(recorded.keys());

    // Drift check runs for every mode. Fatal unless this is a --status report
    // or --allow-drift was passed for a recorded exception (driftIsFatal).
    const drifted = detectDrift(allFiles, diskChecksums, recorded);
    if (drifted.length > 0) {
      warnDrift(drifted);
      if (driftIsFatal(cli)) {
        console.error(
          "FATAL: checksum drift detected. An applied migration is immutable — correct it in docs/db/migration-errata.md, not in the file. If this drift is a recorded exception, re-run with --allow-drift. Refusing to continue.",
        );
        process.exit(3);
      }
      console.warn(
        cli.allowDrift
          ? "  Continuing under --allow-drift."
          : "  --status is a report, not a gate: continuing.",
      );
    }

    // ---- --status / --check ---------------------------------------------
    // Both print the same applied-vs-pending report. The only difference is the
    // exit code: --status always exits 0 (informational), while --check exits 6
    // when anything is pending so it can gate a deploy — code must never ship
    // ahead of the database it queries.
    if (cli.status || cli.check) {
      const pending = computePending(allFiles, appliedSet);
      header(cli.check ? "Migration check" : "Migration status");
      console.log(`Tracking table : public.${TRACKING_TABLE}`);
      console.log(`Total files    : ${allFiles.length}`);
      console.log(`Applied        : ${appliedSet.size}`);
      console.log(`Pending        : ${pending.length}`);
      if (pending.length > 0) {
        console.log("\nPending migrations:");
        for (const f of pending) console.log(`  - ${f}`);
      }
      if (drifted.length > 0) {
        console.log(`\nDrifted (applied but file changed): ${drifted.length}`);
        for (const f of drifted) console.log(`  ! ${f}`);
      }
      if (cli.check && pending.length > 0) {
        console.error(
          `\nFATAL: ${pending.length} migration(s) pending against this database.
Apply them with \`pnpm db:migrate\` BEFORE deploying code that depends on
them — otherwise the deployed app will query columns/tables that do not
exist yet (errorMissingColumn at runtime).`,
        );
        process.exit(6);
      }
      return;
    }

    // ---- --baseline -----------------------------------------------------
    if (cli.baseline) {
      let targets: string[];
      try {
        targets = resolveBaselineTargets(allFiles, cli.baselineUpTo);
      } catch (err) {
        console.error(`ERROR: ${(err as Error).message}`);
        process.exit(4);
      }
      const toMark = targets.filter((f) => !appliedSet.has(f));
      header(
        cli.dryRun
          ? "Baseline (DRY RUN — nothing written)"
          : "Baseline — marking migrations applied WITHOUT executing SQL",
      );
      console.log(
        `Target range   : ${cli.baselineUpTo ? `up to ${cli.baselineUpTo}` : "ALL files"}`,
      );
      console.log(`Already marked : ${targets.length - toMark.length}`);
      console.log(`To mark now    : ${toMark.length}`);
      if (toMark.length === 0) {
        console.log("\nNothing to do — every target migration is already tracked.");
        return;
      }
      console.log("");
      for (const f of toMark) {
        const sum = diskChecksums.get(f) as string;
        if (cli.dryRun) {
          console.log(`  WOULD mark  ${f}`);
        } else {
          await recordApplied(sql, f, sum);
          console.log(`  marked      ${f}`);
        }
      }
      console.log(
        cli.dryRun
          ? `\nDry run: ${toMark.length} migration(s) would be baselined. No SQL executed.`
          : `\nBaseline complete: ${toMark.length} migration(s) marked applied. No migration SQL executed.`,
      );
      return;
    }

    // ---- forward apply (default) ---------------------------------------
    const pending = computePending(allFiles, appliedSet);

    if (cli.dryRun) {
      header("Dry run — migrations that WOULD apply");
      if (pending.length === 0) {
        console.log("Nothing pending. Database is up to date.");
      } else {
        for (const f of pending) console.log(`  WOULD apply  ${f}`);
        console.log(`\n${pending.length} migration(s) pending. No SQL executed (--dry-run).`);
      }
      return;
    }

    // Schema-populated guard: refuse to apply against an already-provisioned DB
    // that has never been baselined. An empty tracking table on a DB that already
    // has `public.pets` means this is an existing DB — applying from scratch would
    // fail partway through and leave the DB in a broken state.
    if (await schemaPopulatedButUntracked(sql, appliedSet.size)) {
      console.error(
        "\nERROR: This database already has schema but no migration tracking.\n" +
          "Run `pnpm db:migrate:baseline` first (see docs/ops/migrations.md).\n",
      );
      process.exit(5);
    }

    header("Applying migrations");
    if (pending.length === 0) {
      console.log("Nothing pending. Database is up to date.");
      return;
    }
    console.log(`${pending.length} migration(s) to apply.\n`);

    let appliedCount = 0;
    for (const f of pending) {
      const contents = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      const sum = diskChecksums.get(f) as string;
      const noTxn = isNoTransaction(contents);
      process.stdout.write(`  applying    ${f}${noTxn ? " [no-transaction]" : ""} … `);
      try {
        if (noTxn) {
          // File opted out of wrapping — execute statements individually so that
          // CREATE/DROP INDEX CONCURRENTLY (which cannot run inside a transaction
          // block) is not bundled with other statements. The postgres.js simple-
          // query protocol wraps multi-statement strings in an implicit transaction,
          // which would cause CONCURRENTLY to fail even without an explicit BEGIN.
          // Splitting on ";\n" and trimming blank/comment-only chunks mirrors psql
          // behavior: each statement gets its own round-trip, no implicit txn.
          //
          // CONSTRAINT: the splitter cannot parse dollar-quoted bodies (DO $$,
          // CREATE FUNCTION ... $$) — internal ";\n" would split mid-body. Such
          // statements belong in a normal transactional migration; refuse loudly
          // rather than corrupt silently.
          if (/\$[A-Za-z_]*\$/.test(contents)) {
            throw new Error(
              `${f} uses dollar-quoting inside a -- dim:no-transaction file; the statement splitter cannot parse it. Move DO/function bodies to a transactional migration.`,
            );
          }
          const statements = contents
            .split(/;\s*\n/)
            .map((s) => s.trim())
            .filter(
              (s) =>
                s.length > 0 &&
                !s
                  .replace(/--[^\n]*/g, "")
                  .trim()
                  .match(/^$/),
            );
          for (const stmt of statements) {
            await sql.unsafe(`${stmt};`);
          }
        } else {
          // Wrap in a transaction so a mid-file failure rolls back cleanly;
          // safe to retry after fixing the migration.
          await sql.unsafe(`begin;\n${contents}\ncommit;`);
        }
      } catch (err) {
        console.log("FAILED");
        console.error(`\nFATAL: migration ${f} failed:\n${(err as Error).message}`);
        console.error(
          `\nApplied ${appliedCount} migration(s) before the failure. Fix the migration and re-run; already-applied files are skipped.`,
        );
        process.exit(1);
      }
      await recordApplied(sql, f, sum);
      appliedCount += 1;
      console.log("ok");
    }

    console.log(`\nDone. Applied ${appliedCount} migration(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked directly (so the pure helpers can be imported by tests).
// Under tsx/ESM, process.argv[1] is the script path.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith("migrate.ts");

if (invokedDirectly) {
  main().catch((err) => {
    console.error("UNEXPECTED ERROR:", err);
    process.exit(1);
  });
}
