#!/usr/bin/env tsx
/**
 * DB bootstrap — replicates the manual "paste-into-Studio + run-scripts" dance
 * that brings a brand-new Postgres up to the state the test suite expects.
 *
 * Intended for two callers:
 *   - **CI**: a fresh `supabase start` produces an empty DB; bootstrap fills it.
 *   - **Fresh local clones**: dev clones the repo, runs `supabase start` and
 *     then `pnpm db:bootstrap` instead of pasting nine SQL files into Studio.
 *
 * Idempotent. Re-running on an already-bootstrapped DB is safe — `db/*.sql`
 * files use IF NOT EXISTS / IF EXISTS / DROP IF EXISTS + CREATE patterns, and
 * the seed scripts UPSERT.
 *
 * Steps (in order):
 *   1. `pnpm db:push` — drizzle-kit syncs schema.ts to the DB (enums, tables,
 *      columns, indexes, FKs). Authoritative for everything Drizzle models.
 *      On a virgin DB this step legitimately does NOT finish: the schema has
 *      generated columns over public.immutable_unaccent, which migration 0146
 *      creates. push reports what it managed and moves on.
 *   2. Replay `db/migrations/*.sql` in numeric order, BEST-EFFORT. After
 *      step 1 the schema already matches schema.ts, so "column already exists"
 *      errors are expected and ignored. What we actually want from this step
 *      are the bits schema.ts can't express: CHECK constraints, functions
 *      (e.g. check_pet_event_case_id_immutable, enforce_admin_no_pets,
 *      cases_set_updated_at) and triggers. Real failures here are quiet by
 *      design; if a custom function doesn't land, downstream tests will yell.
 *      Then VERIFIED: steps 1+2 are one contract, and this is where the schema
 *      is supposed to be whole — every table db/schema.ts declares must exist.
 *      push can exit 0 having created a quarter of the schema, and a bootstrap
 *      that trusts the exit code carries that forward (see verifySchemaLanded).
 *   3. Apply the non-RLS orthogonal `db/*.sql` STRICTLY:
 *        triggers.sql → storage.sql → welfare_storage.sql
 *      These files are normally pasted into Studio by hand (see the header of
 *      db/triggers.sql). RLS is NOT applied here anymore — it lives in the
 *      migration tree (db/migrations/0086_track_rls_in_migrations.sql, applied
 *      in step 2) as the single source of truth. The loose db/*rls*.sql files
 *      remain as readable reference only.
 *   4. Seed reference data + test users via the existing import scripts:
 *      import-indec-localities, import-caba-barrios, seed-test-users.
 *
 * Usage:
 *   pnpm db:bootstrap                  # full bootstrap (1+2+3+4)
 *   pnpm db:bootstrap --no-seeds       # skip step 4 (schema only, fast)
 *   pnpm db:bootstrap --bare           # only step 1 (schema.ts → DB)
 *   pnpm db:bootstrap --allow-remote   # opt out of the local-host guard
 *
 * Safety: refuses to run unless DATABASE_URL points at one of
 * {127.0.0.1, localhost, host.docker.internal, ::1}. The remote opt-out
 * exists for staging bootstraps but should never appear in a CI workflow
 * for the test job. Every step here is destructive — running it against
 * production by mistake is a real incident.
 *
 * Env:
 *   DATABASE_URL                       required. Read from .env.local.
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  required for step 4 only.
 *
 * Exit codes:
 *   0   success
 *   1   step 1 (db:push errored), step 2 (the schema is still incomplete after
 *       the replay), or step 3 (db/*.sql) failed
 *   2   step 4 (a seed script) failed
 *   3   DATABASE_URL not set
 *   4   DATABASE_URL points at a non-local host (use --allow-remote to override)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const BARE = args.has("--bare");
const NO_SEEDS = args.has("--no-seeds") || BARE;
const ALLOW_REMOTE = args.has("--allow-remote");

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is not set. Copy .env.local.example to .env.local " +
      "or export DATABASE_URL before running this script.",
  );
  process.exit(3);
}

function parsePgUrl(url: string) {
  // postgres://user:password@host:port/database
  const match = url.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/([^?]+)/);
  if (!match) {
    throw new Error(`Cannot parse DATABASE_URL: ${url}`);
  }
  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: match[4],
    db: match[5],
  };
}

const pg = parsePgUrl(DATABASE_URL);

// ---------------------------------------------------------------------------
// Safety guard — refuse to run against a remote DB unless explicitly allowed
// ---------------------------------------------------------------------------
//
// Bootstrap is destructive at every step: db:push alters schema, replayed
// migrations alter schema, db/*.sql adds policies + functions, and the seed
// step inserts thousands of rows. Aiming this at production by mistake is
// catastrophic. The repo had no separation between local and remote
// DATABASE_URL configuration when this script was written — until that's
// fixed at the project level, this guard is the seatbelt.
//
// Allow-list a few hostnames that are unambiguously local. Anything else
// requires --allow-remote, which prints a loud confirmation in the output
// so reviewers can spot it in a CI log or shell history.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

if (!LOCAL_HOSTS.has(pg.host) && !ALLOW_REMOTE) {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: db:bootstrap target is NOT a local Postgres.",
      "==============================================================",
      `  DATABASE_URL host: ${pg.host}`,
      `  Allowed local hosts: ${[...LOCAL_HOSTS].join(", ")}`,
      "",
      "  This script applies destructive schema changes and writes",
      "  thousands of seed rows. Running it against a remote DB by",
      "  mistake is a production incident.",
      "",
      "  If you meant to target this host, re-run with --allow-remote.",
      "  Otherwise edit .env.local to point at the local Postgres:",
      "    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(4);
}

if (!LOCAL_HOSTS.has(pg.host) && ALLOW_REMOTE) {
  console.warn(
    [
      "",
      "==============================================================",
      "  WARNING: --allow-remote in effect.",
      `  DATABASE_URL host: ${pg.host}`,
      "  About to apply destructive changes to a remote DB.",
      "==============================================================",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Env alignment — keep the seed step on the SAME stack as DATABASE_URL
// ---------------------------------------------------------------------------
//
// Step 4 (scripts/seed-test-users.ts) uses the supabase admin SDK, which
// reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. If those env
// vars point at a remote project while DATABASE_URL is local (a real shape
// in this repo's .env.local), the seed creates auth.users on the remote
// project and the local DB ends up half-bootstrapped with no test users.
// The seed script's own `isLocalUrl` guard then aborts the run.
//
// When DATABASE_URL is local, force the supabase env back to local too.
// The new-style sb_secret_* key from `supabase status` is universal across
// local stacks; a legacy JWT (eyJ…) is the smell of a remote-project key
// that snuck into .env.local. We don't touch anything when --allow-remote
// is in effect — that mode trusts the user.

const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_SERVICE_KEY = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

function isLocalUrl(u: string | undefined): boolean {
  return !!u && (u.includes("127.0.0.1") || u.includes("localhost"));
}

if (LOCAL_HOSTS.has(pg.host)) {
  if (!isLocalUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
      console.warn(
        `NOTICE: NEXT_PUBLIC_SUPABASE_URL=${process.env.NEXT_PUBLIC_SUPABASE_URL} is not local — forcing to ${LOCAL_SUPABASE_URL} for this run.`,
      );
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_SUPABASE_URL;
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || serviceKey.startsWith("eyJ")) {
    if (serviceKey) {
      console.warn(
        "NOTICE: SUPABASE_SERVICE_ROLE_KEY looks like a remote-project JWT — overriding to local sb_secret_* for this run.",
      );
    }
    process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_KEY;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(title: string): void {
  const line = "=".repeat(Math.max(40, title.length + 4));
  console.log(`\n${line}\n  ${title}\n${line}`);
}

// Supabase ships Postgres inside its `supabase_db_<project_id>` container;
// host machines often don't have `psql` installed (notably Windows). Going
// through `docker exec` keeps the script portable — no client-side install,
// no PATH wrangling, no Docker-vs-WSL ambiguity. Falls back to host psql if
// docker isn't available (e.g. CI service-container setups).
function findPostgresContainer(): string | null {
  const result = spawnSync(
    "docker",
    ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return result.stdout?.trim().split("\n")[0] || null;
}

const POSTGRES_CONTAINER = findPostgresContainer();

function psql(file: string, opts: { strict: boolean }): boolean {
  const sql = readFileSync(file, "utf8");
  if (opts.strict) {
    // Strict mode: abort the entire file on the first error (used for step 3).
    const onErrorStop = ["-v", "ON_ERROR_STOP=1"];
    if (POSTGRES_CONTAINER) {
      const result = spawnSync(
        "docker",
        ["exec", "-i", POSTGRES_CONTAINER, "psql", "-U", pg.user, "-d", pg.db, ...onErrorStop],
        { input: sql, stdio: ["pipe", "inherit", "inherit"] },
      );
      return result.status === 0;
    }
    const result = spawnSync(
      "psql",
      ["-h", pg.host, "-p", pg.port, "-U", pg.user, "-d", pg.db, ...onErrorStop, "-f", file],
      { stdio: "inherit", env: { ...process.env, PGPASSWORD: pg.password } },
    );
    return result.status === 0;
  }
  // Best-effort mode (step 2 migration replay): each statement gets an implicit
  // savepoint so that an "already exists" error rolls back only that statement
  // and psql continues. Without ON_ERROR_ROLLBACK, a single error inside a
  // BEGIN/COMMIT block (like 0086_track_rls_in_migrations.sql) aborts the
  // entire transaction and silently skips every subsequent statement.
  const onErrorRollback = ["-v", "ON_ERROR_ROLLBACK=on"];
  if (POSTGRES_CONTAINER) {
    const result = spawnSync(
      "docker",
      ["exec", "-i", POSTGRES_CONTAINER, "psql", "-U", pg.user, "-d", pg.db, ...onErrorRollback],
      { input: sql, stdio: ["pipe", "inherit", "inherit"] },
    );
    return result.status === 0;
  }
  const result = spawnSync(
    "psql",
    ["-h", pg.host, "-p", pg.port, "-U", pg.user, "-d", pg.db, ...onErrorRollback, "-f", file],
    { stdio: "inherit", env: { ...process.env, PGPASSWORD: pg.password } },
  );
  return result.status === 0;
}

/**
 * Run a one-shot query and return its rows as raw lines (`-t -A`), or null if
 * the query could not be run at all. Same docker-or-host-psql fallback as
 * psql() above.
 */
function psqlQuery(query: string): string[] | null {
  const flags = ["-t", "-A", "-c", query];
  const result = POSTGRES_CONTAINER
    ? spawnSync(
        "docker",
        ["exec", "-i", POSTGRES_CONTAINER, "psql", "-U", pg.user, "-d", pg.db, ...flags],
        {
          encoding: "utf8",
        },
      )
    : spawnSync("psql", ["-h", pg.host, "-p", pg.port, "-U", pg.user, "-d", pg.db, ...flags], {
        encoding: "utf8",
        env: { ...process.env, PGPASSWORD: pg.password },
      });
  if (result.status !== 0) return null;
  return (result.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Every table name db/schema.ts declares, read from the source.
 *
 * Deliberately a regex over the file rather than an import: importing schema.ts
 * from here would drag in drizzle and the server-only sentinel for what is a
 * list of string literals. Both call shapes are covered —
 * `pgTable("name", {…})` and the multi-line `pgTable(\n  "name",`.
 */
function declaredTableNames(): string[] {
  const source = readFileSync("db/schema.ts", "utf8");
  const names = [...source.matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

/**
 * Which tables db/schema.ts declares but the database does not have. Returns
 * null when the question could not be asked (DB unreachable).
 */
function missingTables(declared: string[]): string[] | null {
  const present = psqlQuery(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  if (present === null) return null;
  const have = new Set(present);
  return declared.filter((t) => !have.has(t));
}

/**
 * Did the schema actually land? — the H10 gate.
 *
 * `drizzle-kit push` can fail partway through and STILL exit 0. Reproduced on
 * a virgin database: the schema declares generated columns over
 * public.immutable_unaccent, a function that is not born until migration 0146,
 * so push errors mid-apply and reports success. 4 of 52 tables get created.
 * Bootstrap declared FATAL only on a non-zero exit code, so it sailed past
 * carrying a quarter of a schema forward.
 *
 * WHERE THIS IS MEASURED, AND WHY IT MOVED
 * ---------------------------------------------------------------------------
 * The first version of this gate ran right after step 1 and made a partial push
 * fatal. That was wrong, and CI said so within the hour: on a virgin database
 * step 1 CANNOT complete — the egg-and-chicken above is structural, not a
 * defect. Step 1 and step 2 are one contract, and the replay in step 2 is what
 * creates the missing function and then the missing tables.
 *
 * So the FATAL belongs after step 2, where the schema is genuinely supposed to
 * be whole. After step 1 the same measurement is still worth printing — it is
 * how you tell "push did everything" from "push did what it could and the
 * replay finished the job" — but it is a note, not a verdict.
 *
 * Names, not a count: the DB legitimately holds tables schema.ts does not
 * declare (_dim_migrations, Supabase internals), so equal totals would not
 * have meant equal sets.
 */
function reportSchemaAfterPush(declared: string[]): void {
  const missing = missingTables(declared);
  if (missing === null) return; // step 2's check will report the unreachable DB
  if (missing.length === 0) {
    console.log(`✓ push landed all ${declared.length} declared table(s).`);
    return;
  }
  const created = declared.length - missing.length;
  const why =
    "  Expected on a virgin DB — the schema declares generated columns over\n" +
    "  public.immutable_unaccent, which migration 0146 creates. Step 2 replays the\n" +
    "  migrations and finishes the job; step 2's check is the one that can fail.";
  console.log(
    `NOTE: push created ${created} of ${declared.length} declared table(s); ${missing.length} still missing.\n${why}`,
  );
}

/** The gate: after the replay, every declared table must exist. */
function verifySchemaLanded(declared: string[]): void {
  const missing = missingTables(declared);

  if (missing === null) {
    const how = POSTGRES_CONTAINER
      ? `docker exec ${POSTGRES_CONTAINER} psql`
      : `psql -h ${pg.host} -p ${pg.port}`;
    console.error(
      `FATAL: could not list tables to verify the schema — the database is unreachable from this script.\n  Tried ${how}.`,
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      [
        "",
        "==============================================================",
        "  FATAL: the schema did not fully land.",
        "==============================================================",
        `  Declared in db/schema.ts: ${declared.length} table(s)`,
        `  Present in the database:  ${declared.length - missing.length} of them`,
        `  MISSING (${missing.length}): ${missing.join(", ")}`,
        "",
        "  Step 1 (drizzle-kit push) can fail partway through and still exit 0,",
        "  and step 2 (the migration replay) tolerates per-statement errors by",
        "  design. Between them the schema is supposed to be whole. It is not.",
        "",
        "  Scroll up for the first real error in either step — usually a missing",
        "  function or extension that a column or index depends on.",
        "==============================================================",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `✓ schema landed — all ${declared.length} table(s) declared in db/schema.ts exist in the database.`,
  );
}

/** Fail early if the derivation itself broke — an empty one waves anything through. */
function declaredTablesOrDie(): string[] {
  const declared = declaredTableNames();
  if (declared.length === 0) {
    console.error(
      "FATAL: could not read any pgTable(...) declarations from db/schema.ts.\n" +
        "  This check derives what the bootstrap SHOULD have created; an empty derivation\n" +
        "  is not a pass, it means the parse broke and the check would wave anything through.",
    );
    process.exit(1);
  }
  return declared;
}

function pnpmRun(
  command: string,
  scriptArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): boolean {
  const result = spawnSync("pnpm", [command, ...scriptArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  return result.status === 0;
}

function tsxRun(scriptPath: string): boolean {
  // Launch with the server-only stub registered first, matching the package.json
  // seed:* scripts. The step-4 seeds import db/index.ts, which imports the
  // `server-only` sentinel; under plain `tsx` that throws ("cannot be imported
  // from a Client Component"). The stub resolves server-only/client-only to an
  // empty module for these standalone scripts (Next's build is untouched).
  const result = spawnSync(
    "node",
    ["--import", "./scripts/register-server-only-stub.mjs", "--import", "tsx", scriptPath],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Step 1 — Schema via drizzle-kit push
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 0 — Prerequisites push cannot create for itself
// ---------------------------------------------------------------------------

header("Step 0/4 — db/prerequisites.sql (extensions + functions push needs)");
if (!psql("db/prerequisites.sql", { strict: true })) {
  console.error(
    "FATAL: db/prerequisites.sql failed.\n" +
      "  Nothing downstream can work: push emits generated columns that call these\n" +
      "  functions, so without them it creates a fraction of the schema and exits 0.\n" +
      "  See the header of db/prerequisites.sql.",
  );
  process.exit(1);
}
console.log("✓ prerequisites applied (pgcrypto, unaccent, public.immutable_unaccent).");

header("Step 1/4 — drizzle-kit push (schema.ts → DB)");
// drizzle.config.ts opts into strict (interactive) mode unless CI=true.
// Bootstrap is automation by definition — force non-interactive so it
// doesn't hang waiting on stdin.
if (!pnpmRun("db:push", [], { CI: "true" })) {
  console.error("FATAL: db:push failed.");
  process.exit(1);
}

// An exit code of 0 from drizzle-kit push is not evidence the schema landed.
// After step 1 that is a note; after step 2 it is the gate. See the docblock
// on verifySchemaLanded for why the verdict cannot live here.
const DECLARED_TABLES = declaredTablesOrDie();
reportSchemaAfterPush(DECLARED_TABLES);

if (BARE) {
  console.log(
    "\n--bare: stopping after step 1. NOTE: the schema-landed gate runs after the\n" +
      "  step 2 replay, so --bare on a virgin DB legitimately leaves tables missing.",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 2 — Replay migrations (best-effort)
// ---------------------------------------------------------------------------

header("Step 2/4 — replay db/migrations/*.sql (best-effort)");

const migrationsDir = "db/migrations";
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

console.log(`Replaying ${migrationFiles.length} migrations…`);
console.log("(benign 'already exists' errors are expected — step 1 already created the columns)");

let migrationsAttempted = 0;
let migrationsClean = 0;
for (const fileName of migrationFiles) {
  migrationsAttempted += 1;
  const fullPath = path.join(migrationsDir, fileName);
  const ok = psql(fullPath, { strict: false });
  if (ok) migrationsClean += 1;
}
console.log(
  `Migrations replayed: ${migrationsClean}/${migrationsAttempted} exit-zero (non-zero exits are tolerated — see header).`,
);

// Steps 1 and 2 are one contract: push does what it can, the replay finishes
// it. THIS is the point where the schema is supposed to be whole, so this is
// where a half-applied schema stops being carried forward silently (H10).
verifySchemaLanded(DECLARED_TABLES);

// ---------------------------------------------------------------------------
// Step 2.5 — Baseline the migration tracking table
// ---------------------------------------------------------------------------
//
// Step 2 above replays every db/migrations/*.sql via psql, but that replay is
// UNTRACKED — it leaves no record of which migrations ran. The production
// deploy contract is `pnpm db:migrate` (scripts/migrate.ts), a forward-only
// runner that tracks applied files in public._dim_migrations. If we left that
// table empty after bootstrap, a subsequent `db:migrate` would try to RE-APPLY
// 0000 onward against a DB that already has the schema — and the bare
// CREATE TABLEs in early migrations would error.
//
// So immediately after the replay, we baseline: mark every migration as
// applied WITHOUT executing any SQL. `migrate.ts --baseline` only INSERTs
// tracking rows (idempotent via ON CONFLICT). A `db:migrate` right after a
// fresh bootstrap is then a correct no-op. This is the single place that keeps
// `db:bootstrap` and `db:migrate` consistent.

header("Step 2.5/4 — baseline migration tracking table (_dim_migrations)");
if (!pnpmRun("db:migrate:baseline")) {
  console.error("FATAL: baseline of the migration tracking table failed.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 3 — Orthogonal SQL (strict)
// ---------------------------------------------------------------------------

header("Step 3/4 — apply db/*.sql (triggers, RLS, storage) — STRICT");

// RLS is now applied by the migration tree (db/migrations/0086_track_rls_in_migrations.sql,
// replayed in step 2) — it is the single source of truth for RLS application. The loose
// db/*rls*.sql files (rls.sql, cases_rls.sql, organizations_rls.sql, welfare_rls.sql,
// foster_rls.sql, scheduling_rls.sql) are kept as readable reference but are NO LONGER
// applied here, so RLS is applied exactly once and there is no double-application conflict.
// can_read_case() is defined by migration 0034 (also replayed in step 2). This list keeps
// only the non-RLS-policy orthogonal SQL (triggers + storage buckets/policies).
const ORTHOGONAL_ORDER = ["db/triggers.sql", "db/storage.sql", "db/welfare_storage.sql"];

for (const sqlPath of ORTHOGONAL_ORDER) {
  if (!existsSync(sqlPath)) {
    console.warn(`SKIP: ${sqlPath} not present.`);
    continue;
  }
  console.log(`\n> ${sqlPath}`);
  if (!psql(sqlPath, { strict: true })) {
    console.error(`FATAL: ${sqlPath} failed.`);
    process.exit(1);
  }
}

// Step 3.5 — tell PostgREST to reload its schema cache so RPCs and new
// columns added by migrations (which ran in step 2) become visible without
// restarting the supabase stack. Without this, tests calling RPCs that
// were created post-startup get PGRST202 (function not in cache).
{
  console.log("\n> NOTIFY pgrst, 'reload schema'");
  const file = path.join(process.cwd(), "tmp_pgrst_reload.sql");
  writeFileSync(file, "NOTIFY pgrst, 'reload schema';\n");
  try {
    psql(file, { strict: false });
  } finally {
    try {
      unlinkSync(file);
    } catch {}
  }
}

if (NO_SEEDS) {
  console.log("\n--no-seeds: stopping after step 3.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 4 — Seed reference data + test users
// ---------------------------------------------------------------------------

header("Step 4/4 — seed reference data + test users");

const SEEDS: { path: string; label: string }[] = [
  {
    path: "scripts/import-indec-localities.ts",
    label: "INDEC localities (~4k rows)",
  },
  { path: "scripts/import-caba-barrios.ts", label: "CABA barrios (48 rows)" },
  {
    path: "scripts/seed-test-users.ts",
    label: "Test users (admin/owner/vet/orgadmin/govt)",
  },
];

let seedsFailed = 0;
for (const { path: scriptPath, label } of SEEDS) {
  if (!existsSync(scriptPath)) {
    console.warn(`SKIP: ${scriptPath} not present.`);
    continue;
  }
  console.log(`\n> ${label} (${scriptPath})`);
  if (!tsxRun(scriptPath)) {
    console.error(`WARN: ${scriptPath} exited non-zero — continuing.`);
    seedsFailed += 1;
  }
}

if (seedsFailed > 0) {
  console.error(`\nBootstrap finished with ${seedsFailed} seed failure(s).`);
  process.exit(2);
}

console.log("\nBootstrap complete.");
