#!/usr/bin/env tsx
/**
 * Remote-safe, idempotent provisioner — the psql-free replacement for
 * `db:bootstrap` when the target is a fresh REMOTE Supabase (staging / prod).
 *
 * WHY THIS EXISTS
 * ---------------
 * `db:bootstrap` shells out to `psql` for db/*.sql and the migration replay.
 * Against a remote deploy that breaks two ways:
 *   1. psql connects to the LOCAL socket / 127.0.0.1 and ignores DATABASE_URL
 *      unless every -h/-p/-U/PGPASSWORD is threaded through — and psql is not
 *      installed on many machines (Windows especially).
 *   2. The numbered migrations are NOT self-contained (0000 references
 *      public.ownership_role before it exists); they assume `db:push`
 *      (drizzle → enums + tables) ran first.
 *
 * This script replicates the PROVEN manual remote sequence using postgres.js
 * only (the same driver the app + migrate runner use), so there is zero psql
 * dependency and DATABASE_URL is always honored. It mirrors db-bootstrap's
 * steps exactly — just with `client.unsafe(...)` instead of `psql`:
 *
 *   1. `pnpm db:push`  — drizzle-kit builds enums + the ~46 tables from
 *      schema.ts (respects DATABASE_URL).
 *   2. Best-effort replay of db/migrations/*.sql via postgres.js — lands the
 *      bits schema.ts can't express: SQL functions (e.g. can_read_case, which
 *      the loose RLS files call), CHECK constraints and triggers. "already
 *      exists" errors are expected (step 1 built the columns) and tolerated
 *      per file.
 *   3. Apply the loose orthogonal db/*.sql (triggers, storage buckets/policies,
 *      per-domain RLS) via client.unsafe, best-effort per file. db/rls.sql is
 *      intentionally EXCLUDED — it needs can_read_case and is superseded by the
 *      RLS carried in the migration tree + the per-domain *_rls.sql files.
 *   4. Baseline public._dim_migrations (`db:migrate:baseline`) so a later
 *      `pnpm db:migrate` is a correct no-op instead of re-applying 0000 onward
 *      against a populated schema.
 *   5. Seed reference data + accounts by invoking the existing import/seed
 *      scripts through the server-only stub, passing --allow-remote.
 *
 * Every step is destructive against a fresh DB, so the script refuses to run
 * unless `--target remote` is passed (mirrors db-bootstrap's --allow-remote
 * loud confirmation). Idempotent: safe to re-run.
 *
 * ENV (read from process.env; .env.local / .env are loaded for convenience but
 *      do NOT override values already exported):
 *   DATABASE_URL                required. Use the SESSION pooler (port 5432) for
 *                               provisioning — db:push + DDL need a real session,
 *                               NOT the transaction pooler (6543).
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 *                               required for the seed step (step 5).
 *
 * USAGE
 *   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     pnpm deploy:provision --target remote
 *   pnpm deploy:provision --target remote --reference-only  # no test users
 *   pnpm deploy:provision --target remote --no-seeds        # schema + SQL only
 *   pnpm deploy:provision --target remote --dry-run         # print the plan
 *
 * EXIT CODES
 *   0  success
 *   1  a hard step failed (db:push, baseline, or a seed script)
 *   2  DATABASE_URL not set
 *   3  missing `--target remote` confirmation
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import postgres from "postgres";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const targetIdx = argv.indexOf("--target");
const TARGET = targetIdx >= 0 ? argv[targetIdx + 1] : undefined;
const DRY_RUN = argv.includes("--dry-run");
const NO_SEEDS = argv.includes("--no-seeds") || argv.includes("--schema-only");
const REFERENCE_ONLY = argv.includes("--reference-only");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function header(title: string): void {
  const line = "=".repeat(Math.max(40, title.length + 4));
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function parsePgHost(url: string): string {
  const match = url.match(/^postgres(?:ql)?:\/\/[^:]+:[^@]+@([^:/]+):\d+\//);
  return match?.[1] ?? "(unparseable)";
}

// ---------------------------------------------------------------------------
// Env + confirmation guard
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is not set. Export the SESSION pooler (port 5432) URL " +
      "of the target Supabase before running this script.",
  );
  process.exit(2);
}
// Narrowed at module scope so the type flows into main()'s closure (TS does not
// propagate the guard above into nested function bodies for a module-level let).
const DB_URL: string = DATABASE_URL;

if (TARGET !== "remote") {
  console.error(
    [
      "",
      "==============================================================",
      "  ABORT: deploy:provision requires explicit confirmation.",
      "==============================================================",
      `  DATABASE_URL host: ${parsePgHost(DATABASE_URL)}`,
      "",
      "  This script runs db:push, replays every migration, applies the",
      "  loose db/*.sql, baselines the migration ledger and seeds — all",
      "  destructive against a fresh DB. Aiming it at the wrong project",
      "  is a production incident.",
      "",
      "  Re-run with the confirmation flag once you are sure:",
      "    pnpm deploy:provision --target remote",
      "==============================================================",
      "",
    ].join("\n"),
  );
  process.exit(3);
}

console.warn(
  [
    "",
    "==============================================================",
    "  deploy:provision — --target remote in effect.",
    `  DATABASE_URL host: ${parsePgHost(DATABASE_URL)}`,
    `  Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "APPLY"}`,
    `  Seeds: ${NO_SEEDS ? "skipped" : REFERENCE_ONLY ? "reference data only" : "reference data + test users"}`,
    "==============================================================",
    "",
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// Spawn helpers (mirror db-bootstrap: shell:true on Windows for pnpm/node)
// ---------------------------------------------------------------------------

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

// Launch a DB-touching script with the server-only stub registered first, the
// same way package.json's seed:* scripts do. Extra env lets us align the
// supabase SDK vars for the seed step.
function seedRun(
  scriptPath: string,
  scriptArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): boolean {
  const result = spawnSync(
    "node",
    [
      "--import",
      "./scripts/register-server-only-stub.mjs",
      "--import",
      "tsx",
      scriptPath,
      ...scriptArgs,
    ],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...extraEnv },
    },
  );
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// SQL application via postgres.js (NO psql)
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;

/**
 * Split a SQL script into individual statements, respecting the constructs a
 * naive `split(";")` would corrupt:
 *   - dollar-quoted bodies  $$ … $$  and  $tag$ … $tag$  (function/DO bodies,
 *     whose internal semicolons must NOT terminate the statement)
 *   - single-quoted strings  '…'  (with the '' escape)
 *   - double-quoted identifiers  "…"
 *   - line comments  -- …  and block comments  /* … *​/
 *
 * This is the crux of the fresh-provision fix: the old replay sent each whole
 * migration file to `sql.unsafe(contents)`, wrapping it in ONE implicit
 * transaction. A single benign "already exists" from an early statement (db:push
 * built the columns first) rolled the ENTIRE file back — dropping the
 * CREATE FUNCTION / CREATE TRIGGER we actually needed. That is why only 10/46
 * functions landed on the first staging deploy. Splitting statement-by-statement
 * lets each one run in its own autocommit round-trip, so a duplicate on one
 * statement never discards its siblings.
 */
export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = input.length;
  let dollarTag: string | null = null;

  while (i < n) {
    const ch = input[i];

    if (dollarTag) {
      if (ch === "$" && input.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }

    // Line comment — copy verbatim to end of line.
    if (ch === "-" && input[i + 1] === "-") {
      const nl = input.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      current += input.slice(i, end);
      i = end;
      continue;
    }

    // Block comment — copy verbatim to closing */.
    if (ch === "/" && input[i + 1] === "*") {
      const close = input.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      current += input.slice(i, end);
      i = end;
      continue;
    }

    // Single-quoted string literal ('' escapes an embedded quote).
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        if (input[i] === "'" && input[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        if (input[i] === "'") {
          current += "'";
          i += 1;
          break;
        }
        current += input[i];
        i += 1;
      }
      continue;
    }

    // Double-quoted identifier ("" escapes an embedded quote).
    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < n) {
        if (input[i] === '"' && input[i + 1] === '"') {
          current += '""';
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          current += '"';
          i += 1;
          break;
        }
        current += input[i];
        i += 1;
      }
      continue;
    }

    // Possible dollar-quote open:  $tag$  where tag is [A-Za-z_][A-Za-z0-9_]* or empty.
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i));
      if (m) {
        dollarTag = m[0];
        current += m[0];
        i += m[0].length;
        continue;
      }
    }

    // Statement terminator.
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/** Strip -- and /* *​/ comments so a statement's leading keyword can be classified. */
export function stripSqlComments(stmt: string): string {
  return stmt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * True for a bare transaction-control statement (BEGIN/COMMIT/ROLLBACK/END/
 * START TRANSACTION). The replay runs each statement in its own autocommit
 * round-trip, so the explicit BEGIN/COMMIT that wrap several migration files
 * must be dropped — executing them standalone on a pooled connection would
 * either no-op with a warning or, worse, leave a lingering aborted transaction.
 */
export function isTransactionControl(codeOnly: string): boolean {
  return /^\s*(begin|start\s+transaction|commit|end|rollback)\s*(work|transaction)?\s*$/i.test(
    codeOnly,
  );
}

/**
 * SQLSTATEs the migration replay TOLERATES. Two families, both benign under the
 * db:push-first architecture (step 1 builds the FINAL schema.ts state, then the
 * whole migration HISTORY replays over it):
 *
 * 1. "already exists" — the object a migration would create already exists
 *    because db:push built it. Re-creating it is a no-op.
 * 2. "superseded history" — a historical migration references a column/object
 *    that the FINAL schema removed or renamed (e.g. pets.microchip_id and
 *    pets.tattoo_code were dropped once canonical id data moved to
 *    pet_identifications; cases.primary_location_lat was renamed to location_lat).
 *    db:push is AUTHORITATIVE for every column/table/enum in schema.ts, so a
 *    reference to a NON-existent column can only mean the final schema moved past
 *    that step — it can NEVER be a real "missing column" gap (db:push would have
 *    created it). Tolerating these can only skip an obsolete drop/backfill, never
 *    remove an app-required object. The independent post-provision verification
 *    (function/index/trigger/census/grant counts) is the real completeness gate.
 *
 * ANYTHING ELSE — syntax (42601), permission (42501), undefined table/function
 * (42P01/42883), undefined schema (3F000) — is a REAL gap and fails loudly.
 */
const TOLERABLE_SQLSTATES = new Set<string>([
  // Family 1 — already exists
  "42P07", // duplicate_table (table, index, view, sequence, matview already exists)
  "42P06", // duplicate_schema
  "42710", // duplicate_object (constraint, trigger, policy, type, cast, enum value, …)
  "42701", // duplicate_column
  "42723", // duplicate_function
  "42P04", // duplicate_database
  "23505", // unique_violation (re-inserting reference/seed rows on an idempotent re-run)
  // Family 2 — superseded history against the db:push final schema
  "42703", // undefined_column (migration touches a since-removed/renamed column)
  "42704", // undefined_object (migration drops a constraint/object the final schema lacks)
  "2BP01", // dependent_objects_still_exist (drop of a column the final schema keeps + depends on)
]);

interface FatalStatementError {
  file: string;
  sqlstate: string;
  message: string;
  statement: string;
}

/**
 * Replay every migration file statement-by-statement. Tolerates the
 * "already exists" family (db:push built the columns first); collects EVERY
 * other error and throws a single consolidated report at the end so the operator
 * sees the full picture, not just the first failure.
 *
 * Returns a summary { applied, tolerated } for logging.
 */
async function replayMigrationsStrict(
  sql: Sql,
  migrationsDir: string,
  files: string[],
): Promise<{ applied: number; tolerated: number }> {
  let applied = 0;
  let tolerated = 0;
  const fatals: FatalStatementError[] = [];

  for (const fileName of files) {
    const contents = readFileSync(path.join(migrationsDir, fileName), "utf8");
    const statements = splitSqlStatements(contents);
    let fileApplied = 0;
    let fileTolerated = 0;

    for (const stmt of statements) {
      const codeOnly = stripSqlComments(stmt).trim();
      if (codeOnly.length === 0) continue; // comment-only chunk
      if (isTransactionControl(codeOnly)) continue; // drop BEGIN/COMMIT/…

      try {
        await sql.unsafe(stmt);
        fileApplied += 1;
      } catch (err) {
        const sqlstate = (err as { code?: string }).code ?? "";
        if (TOLERABLE_SQLSTATES.has(sqlstate)) {
          fileTolerated += 1;
          continue;
        }
        fatals.push({
          file: fileName,
          sqlstate,
          message: (err as Error).message.split("\n")[0],
          statement: codeOnly.replace(/\s+/g, " ").slice(0, 160),
        });
      }
    }

    applied += fileApplied;
    tolerated += fileTolerated;
    console.log(
      `  ${fatals.some((f) => f.file === fileName) ? "✗" : "+"} ${fileName} ` +
        `(${fileApplied} applied, ${fileTolerated} tolerated)`,
    );
  }

  if (fatals.length > 0) {
    console.error(
      [
        "",
        "**********************************************************************",
        `  FATAL: ${fatals.length} migration statement(s) failed with a NON-tolerable`,
        "  error. These are real schema gaps (not benign 'already exists') — the",
        "  provision is aborting so the incomplete schema is never trusted.",
        "**********************************************************************",
        ...fatals.map((f) => `    ${f.file} [${f.sqlstate}] ${f.message}\n      → ${f.statement}`),
        "",
      ].join("\n"),
    );
    throw new Error(`${fatals.length} non-tolerable migration statement error(s).`);
  }

  return { applied, tolerated };
}

/**
 * Apply one LOOSE SQL file (triggers / storage / per-domain RLS) statement-by-
 * statement, best-effort. These files are authored idempotently (DROP … IF
 * EXISTS then CREATE, CREATE OR REPLACE), so they replay cleanly; per-statement
 * execution means a stray failure never discards the rest of the file. Errors
 * are logged, never thrown.
 */
async function applySqlFileBestEffort(sql: Sql, filePath: string): Promise<boolean> {
  const contents = readFileSync(filePath, "utf8");
  const label = path.basename(filePath);
  const statements = splitSqlStatements(contents);
  let hadError = false;

  for (const stmt of statements) {
    const codeOnly = stripSqlComments(stmt).trim();
    if (codeOnly.length === 0) continue;
    if (isTransactionControl(codeOnly)) continue;
    try {
      await sql.unsafe(stmt);
    } catch (err) {
      hadError = true;
      console.warn(`  ! ${label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  console.log(`  ${hadError ? "~" : "+"} ${label}`);
  return !hadError;
}

// ---------------------------------------------------------------------------
// Extensions, grants, post-provision verification
// ---------------------------------------------------------------------------

// Extensions the migrations + indexes depend on. The first four MUST exist
// (pg_trgm/unaccent for search, pgcrypto/uuid-ossp for id + hashing helpers);
// db:push does not create them and migration 0070 assumes unaccent is present.
const REQUIRED_EXTENSIONS = ["pg_trgm", "unaccent", "pgcrypto", "uuid-ossp"] as const;
// Platform-managed on hosted Supabase; best-effort locally (may be unavailable).
const PLATFORM_EXTENSIONS = ["pg_graphql", "pg_net"] as const;

async function applyExtensions(sql: Sql): Promise<void> {
  for (const ext of REQUIRED_EXTENSIONS) {
    try {
      await sql.unsafe(`create extension if not exists "${ext}";`);
      console.log(`  + ${ext}`);
    } catch (err) {
      // Required extensions failing is fatal — surfaced here and re-checked in
      // the post-provision verification.
      console.error(`  ✗ ${ext}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  for (const ext of PLATFORM_EXTENSIONS) {
    try {
      await sql.unsafe(`create extension if not exists "${ext}";`);
      console.log(`  + ${ext} (platform)`);
    } catch {
      console.warn(`  ~ ${ext}: unavailable (platform-only) — skipped.`);
    }
  }
}

/**
 * Apply Supabase's default public-schema grants. `db:push` (drizzle) creates
 * tables WITHOUT them, so storage RLS policies that reference public tables fail
 * with "permission denied for table …" for the authenticated role. This
 * reproduces the grants the Supabase platform normally applies. Best-effort per
 * statement — the post-provision verification re-checks and fails loud if short.
 */
async function applySchemaGrants(sql: Sql): Promise<void> {
  const grants = [
    "grant usage on schema public to anon, authenticated, service_role;",
    "grant all on all tables in schema public to anon, authenticated, service_role;",
    "grant all on all sequences in schema public to anon, authenticated, service_role;",
    "grant all on all functions in schema public to anon, authenticated, service_role;",
    "alter default privileges in schema public grant all on tables to anon, authenticated, service_role;",
    "alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;",
    "alter default privileges in schema public grant all on functions to anon, authenticated, service_role;",
  ];
  for (const stmt of grants) {
    try {
      await sql.unsafe(stmt);
      console.log(`  + ${stmt.split(" ").slice(0, 6).join(" ")}…`);
    } catch (err) {
      console.warn(`  ! grant failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// Manifest minimums — floors measured against the local reference DB (which has
// 46 functions / 239 indexes / 9 triggers / 24 census rows / 329 authenticated
// grants) and set safely below those actuals so benign drift passes but a gross
// shortfall (the first staging deploy landed only 10/46 functions) fails loud.
const VERIFICATION_MINIMUMS = {
  functions: 40,
  indexes: 200,
  triggers: 8,
  census: 24,
  authenticatedGrants: 50,
} as const;

// Tables the PII baseline (migration 0058) applies its retention columns to.
// A fresh provision that skipped the BEGIN/COMMIT-wrapped pii migrations left
// the `pii` schema absent, so Ley 25.326 export/erase died with
// `schema "pii" does not exist` — verified here so that gap fails loud.
const PII_BASELINE_TABLES = [
  "profiles",
  "pets",
  "pet_identifications",
  "custody_disputes",
] as const;
// pii schema functions the subject-rights RPCs depend on (0058 + 0059).
const PII_REQUIRED_FUNCTIONS = ["apply_baseline", "caller_is_admin"] as const;
// Storage buckets the app writes to that a fresh deploy must declare. A missing
// bucket 500s the corresponding upload with "Bucket not found" (the revocations
// bucket had no db/*storage.sql coverage and had to be hot-patched by hand).
const REQUIRED_BUCKETS = [
  "pet-photos",
  "event-attachments",
  "welfare-evidence",
  "welfare-exports",
  "ppp-exports",
  "travel-exports",
  "revocations",
  // Decomiso evidence (0234, PO decision D10): without it every decomiso dies
  // on its first upload, before the transaction opens.
  "decomiso-evidence",
] as const;

interface VerificationReport {
  functions: number;
  indexes: number;
  triggers: number;
  tables: number;
  census: number;
  extensionsPresent: string[];
  extensionsMissing: string[];
  authenticatedGrants: number;
  schemaUsageAuthenticated: boolean;
  storagePolicies: number;
  piiSchemaPresent: boolean;
  piiFunctionsPresent: string[];
  piiFunctionsMissing: string[];
  piiRetentionColumns: number;
  bucketsPresent: string[];
  bucketsMissing: string[];
  shortfalls: string[];
}

async function verifyProvision(sql: Sql): Promise<VerificationReport> {
  const one = async (query: Promise<{ n: number }[]>): Promise<number> => (await query)[0]?.n ?? 0;

  const functions = await one(
    sql`select count(*)::int as n from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace where nsp.nspname = 'public'`,
  );
  const indexes = await one(
    sql`select count(*)::int as n from pg_indexes where schemaname = 'public'`,
  );
  const triggers = await one(
    sql`select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace nsp on nsp.oid = c.relnamespace where nsp.nspname = 'public' and not t.tgisinternal`,
  );
  const tables = await one(
    sql`select count(*)::int as n from pg_tables where schemaname = 'public'`,
  );
  const census = await one(sql`select count(*)::int as n from public.jurisdictions_census`).catch(
    () => 0,
  );
  const extRows = (await sql`select extname from pg_extension`) as { extname: string }[];
  const extPresent = new Set(extRows.map((r) => r.extname));
  const extensionsMissing = REQUIRED_EXTENSIONS.filter((e) => !extPresent.has(e));
  const extensionsPresent = REQUIRED_EXTENSIONS.filter((e) => extPresent.has(e));
  const authenticatedGrants = await one(
    sql`select count(*)::int as n from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated'`,
  );
  const usageRows =
    (await sql`select has_schema_privilege('authenticated', 'public', 'USAGE') as usage`) as {
      usage: boolean;
    }[];
  const schemaUsageAuthenticated = usageRows[0]?.usage ?? false;
  const storagePolicies = await one(
    sql`select count(*)::int as n from pg_policies where schemaname = 'storage'`,
  ).catch(() => 0);

  // ---- PII schema / functions / retention columns (Ley 25.326) ------------
  const piiSchemaPresent =
    (await one(sql`select count(*)::int as n from pg_namespace where nspname = 'pii'`)) > 0;
  const piiFnRows = (await sql`
    select p.proname from pg_proc p
      join pg_namespace nsp on nsp.oid = p.pronamespace
     where nsp.nspname = 'pii'
  `.catch(() => [])) as { proname: string }[];
  const piiFnPresent = new Set(piiFnRows.map((r) => r.proname));
  const piiFunctionsPresent = PII_REQUIRED_FUNCTIONS.filter((f) => piiFnPresent.has(f));
  const piiFunctionsMissing = PII_REQUIRED_FUNCTIONS.filter((f) => !piiFnPresent.has(f));
  const piiRetentionColumns = await one(sql`
    select count(*)::int as n from information_schema.columns
     where table_schema = 'public'
       and column_name = 'retention_until'
       and table_name = any(${sql.array([...PII_BASELINE_TABLES])})
  `).catch(() => 0);

  // ---- Storage buckets (a missing one 500s its upload with Bucket not found) -
  const bucketRows = (await sql`select id from storage.buckets`.catch(() => [])) as {
    id: string;
  }[];
  const bucketIds = new Set(bucketRows.map((r) => r.id));
  const bucketsPresent = REQUIRED_BUCKETS.filter((b) => bucketIds.has(b));
  const bucketsMissing = REQUIRED_BUCKETS.filter((b) => !bucketIds.has(b));

  const shortfalls: string[] = [];
  if (functions < VERIFICATION_MINIMUMS.functions)
    shortfalls.push(`functions ${functions} < ${VERIFICATION_MINIMUMS.functions}`);
  if (indexes < VERIFICATION_MINIMUMS.indexes)
    shortfalls.push(`indexes ${indexes} < ${VERIFICATION_MINIMUMS.indexes}`);
  if (triggers < VERIFICATION_MINIMUMS.triggers)
    shortfalls.push(`triggers ${triggers} < ${VERIFICATION_MINIMUMS.triggers}`);
  if (census < VERIFICATION_MINIMUMS.census)
    shortfalls.push(`jurisdictions_census ${census} < ${VERIFICATION_MINIMUMS.census}`);
  if (extensionsMissing.length > 0)
    shortfalls.push(`missing extensions: ${extensionsMissing.join(", ")}`);
  if (!schemaUsageAuthenticated)
    shortfalls.push("authenticated lacks USAGE on schema public (grants not applied)");
  if (authenticatedGrants < VERIFICATION_MINIMUMS.authenticatedGrants)
    shortfalls.push(
      `authenticated table grants ${authenticatedGrants} < ${VERIFICATION_MINIMUMS.authenticatedGrants}`,
    );
  if (!piiSchemaPresent)
    shortfalls.push("pii schema missing (Ley 25.326 export/erase would fail — see migration 0058)");
  if (piiFunctionsMissing.length > 0)
    shortfalls.push(
      `pii functions missing: ${piiFunctionsMissing.map((f) => `pii.${f}`).join(", ")}`,
    );
  if (piiRetentionColumns < PII_BASELINE_TABLES.length)
    shortfalls.push(
      `pii.retention_until columns ${piiRetentionColumns} < ${PII_BASELINE_TABLES.length} (expected on ${PII_BASELINE_TABLES.join(", ")})`,
    );
  if (bucketsMissing.length > 0)
    shortfalls.push(`storage buckets missing: ${bucketsMissing.join(", ")}`);

  return {
    functions,
    indexes,
    triggers,
    tables,
    census,
    extensionsPresent,
    extensionsMissing,
    authenticatedGrants,
    schemaUsageAuthenticated,
    storagePolicies,
    piiSchemaPresent,
    piiFunctionsPresent,
    piiFunctionsMissing,
    piiRetentionColumns,
    bucketsPresent,
    bucketsMissing,
    shortfalls,
  };
}

function printVerificationReport(r: VerificationReport): void {
  console.log("  POST-PROVISION VERIFICATION");
  console.log(
    `    public functions      : ${r.functions} (min ${VERIFICATION_MINIMUMS.functions})`,
  );
  console.log(`    public indexes        : ${r.indexes} (min ${VERIFICATION_MINIMUMS.indexes})`);
  console.log(`    public triggers       : ${r.triggers} (min ${VERIFICATION_MINIMUMS.triggers})`);
  console.log(`    public tables         : ${r.tables}`);
  console.log(`    jurisdictions_census  : ${r.census} (min ${VERIFICATION_MINIMUMS.census})`);
  console.log(
    `    extensions present    : ${r.extensionsPresent.join(", ") || "(none)"}${r.extensionsMissing.length ? ` — MISSING: ${r.extensionsMissing.join(", ")}` : ""}`,
  );
  console.log(
    `    schema grants (authn) : USAGE=${r.schemaUsageAuthenticated} tableGrants=${r.authenticatedGrants} (min ${VERIFICATION_MINIMUMS.authenticatedGrants})`,
  );
  console.log(`    storage policies      : ${r.storagePolicies} (informational)`);
  console.log(
    `    pii schema            : ${r.piiSchemaPresent ? "present" : "MISSING"} — functions ${r.piiFunctionsPresent.map((f) => `pii.${f}`).join(", ") || "(none)"}${r.piiFunctionsMissing.length ? ` — MISSING: ${r.piiFunctionsMissing.map((f) => `pii.${f}`).join(", ")}` : ""}`,
  );
  console.log(
    `    pii retention columns : ${r.piiRetentionColumns}/${PII_BASELINE_TABLES.length} (${PII_BASELINE_TABLES.join(", ")})`,
  );
  console.log(
    `    storage buckets       : ${r.bucketsPresent.length}/${REQUIRED_BUCKETS.length} — ${r.bucketsPresent.join(", ") || "(none)"}${r.bucketsMissing.length ? ` — MISSING: ${r.bucketsMissing.join(", ")}` : ""}`,
  );
}

// The loose orthogonal SQL, in dependency order. RLS files are applied AFTER
// the migration replay so can_read_case() and friends already exist.
// db/rls.sql is deliberately omitted (see header).
const LOOSE_SQL_ORDER = [
  "db/triggers.sql",
  "db/storage.sql",
  "db/welfare_storage.sql",
  "db/exports_storage.sql",
  "db/revocations_storage.sql",
  "db/cases_rls.sql",
  "db/foster_rls.sql",
  "db/organizations_rls.sql",
  "db/scheduling_rls.sql",
  "db/welfare_rls.sql",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const migrationsDir = "db/migrations";
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  // ---- Step 1 — drizzle-kit push -------------------------------------------
  header("Step 1/8 — drizzle-kit push (schema.ts → remote DB)");
  if (DRY_RUN) {
    console.log("  WOULD run: pnpm db:push (CI=true)");
  } else if (!pnpmRun("db:push", [], { CI: "true" })) {
    console.error("FATAL: db:push failed.");
    process.exit(1);
  }

  if (DRY_RUN) {
    header("Step 2/8 — create required extensions");
    for (const ext of [...REQUIRED_EXTENSIONS, ...PLATFORM_EXTENSIONS]) {
      console.log(`  WOULD run: create extension if not exists "${ext}"`);
    }
    header(`Step 3/8 — replay ${migrationFiles.length} db/migrations/*.sql (statement-strict)`);
    console.log(`  WOULD replay ${migrationFiles.length} migration file(s) via postgres.js.`);
    header("Step 4/8 — apply loose db/*.sql (triggers, storage, RLS)");
    for (const sqlPath of LOOSE_SQL_ORDER) {
      console.log(`  WOULD apply ${sqlPath}${existsSync(sqlPath) ? "" : " (MISSING)"}`);
    }
    header("Step 5/8 — apply Supabase default public-schema grants");
    console.log(
      "  WOULD grant usage/all + alter default privileges to anon, authenticated, service_role",
    );
    console.log("  WOULD run: NOTIFY pgrst, 'reload schema'");
    header("Step 6/8 — post-provision verification");
    console.log(
      "  WOULD count functions/indexes/triggers/census/extensions/grants and FAIL if short.",
    );
  } else {
    const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });
    try {
      // ---- Step 2 — required extensions (before the replay uses them) ------
      header("Step 2/8 — create required extensions");
      await applyExtensions(sql);

      // ---- Step 3 — replay migrations (statement-strict) ------------------
      header(`Step 3/8 — replay ${migrationFiles.length} db/migrations/*.sql (statement-strict)`);
      console.log(
        "(benign 'already exists' statements are tolerated; any OTHER error fails the provision)\n",
      );
      // Pre-create the migration ledger BEFORE the replay so migration 0113
      // (ALTER TABLE public._dim_migrations ENABLE ROW LEVEL SECURITY) applies
      // instead of failing with undefined_table — the ledger is otherwise only
      // created by the baseline step (step 7), which runs AFTER this replay.
      // Mirrors ensureTrackingTable() in scripts/migrate.ts; idempotent.
      await sql.unsafe(
        `create table if not exists public._dim_migrations (
           filename   text primary key,
           checksum   text not null,
           applied_at timestamptz not null default now()
         );`,
      );
      await sql.unsafe("alter table public._dim_migrations enable row level security;");
      const { applied, tolerated } = await replayMigrationsStrict(
        sql,
        migrationsDir,
        migrationFiles,
      );
      console.log(
        `\nMigration replay: ${applied} statement(s) applied, ${tolerated} tolerated (already-exists).`,
      );

      // ---- Step 4 — loose orthogonal SQL (best-effort) ---------------------
      header("Step 4/8 — apply loose db/*.sql (triggers, storage, RLS)");
      for (const sqlPath of LOOSE_SQL_ORDER) {
        if (!existsSync(sqlPath)) {
          console.warn(`  SKIP: ${sqlPath} not present.`);
          continue;
        }
        await applySqlFileBestEffort(sql, sqlPath);
      }

      // ---- Step 5 — Supabase default public-schema grants -----------------
      header("Step 5/8 — apply Supabase default public-schema grants");
      await applySchemaGrants(sql);

      // Tell PostgREST to refresh its schema cache so RPCs/columns added post
      // startup become visible without a stack restart.
      try {
        await sql.unsafe("NOTIFY pgrst, 'reload schema';");
        console.log("  + NOTIFY pgrst, 'reload schema'");
      } catch {
        /* best-effort */
      }

      // ---- Step 6 — post-provision verification (FAIL if short) -----------
      header("Step 6/8 — post-provision verification");
      const report = await verifyProvision(sql);
      printVerificationReport(report);
      if (report.shortfalls.length > 0) {
        console.error(
          [
            "",
            "**********************************************************************",
            "  FATAL: post-provision verification found an INCOMPLETE schema.",
            "  The provisioner did not land everything a fresh deploy needs —",
            "  aborting before baseline/seeds so the gap is never trusted.",
            "**********************************************************************",
            ...report.shortfalls.map((s) => `    - ${s}`),
            "",
          ].join("\n"),
        );
        throw new Error(
          `post-provision verification failed: ${report.shortfalls.length} shortfall(s).`,
        );
      }
      console.log("\n  ✓ verification passed — schema is complete.");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  // ---- Step 7 — baseline the migration ledger ------------------------------
  header("Step 7/8 — baseline public._dim_migrations (so db:migrate is a no-op)");
  if (DRY_RUN) {
    console.log("  WOULD run: pnpm db:migrate:baseline");
  } else if (!pnpmRun("db:migrate:baseline")) {
    console.error("FATAL: baseline of the migration ledger failed.");
    process.exit(1);
  }

  // ---- Step 8 — seed reference data + accounts -----------------------------
  if (NO_SEEDS) {
    console.log("\n--no-seeds / --schema-only: stopping after step 7.");
    return;
  }

  header("Step 8/8 — seed reference data + accounts");

  // seed-test-users reads NEXT_PUBLIC_SUPABASE_URL; accept SUPABASE_URL as an
  // alias so the operator only has to export one name.
  const seedEnv: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  };

  const seeds: { path: string; label: string }[] = [
    { path: "scripts/import-indec-localities.ts", label: "INDEC localities (~4k rows)" },
    { path: "scripts/import-caba-barrios.ts", label: "CABA barrios (48 rows)" },
  ];
  if (!REFERENCE_ONLY) {
    seeds.push({
      path: "scripts/seed-test-users.ts",
      label: "Test users (admin/owner/vet/orgadmin/govt)",
    });
  }

  let failed = 0;
  for (const { path: scriptPath, label } of seeds) {
    if (!existsSync(scriptPath)) {
      console.warn(`  SKIP: ${scriptPath} not present.`);
      continue;
    }
    console.log(`\n> ${label} (${scriptPath})`);
    if (DRY_RUN) {
      console.log(
        `  WOULD run: node --import ./scripts/register-server-only-stub.mjs --import tsx ${scriptPath} --allow-remote`,
      );
      continue;
    }
    // --allow-remote opts the seeds out of their local-only guard. Unknown to
    // the reference importers (they ignore it); required by seed-test-users.
    if (!seedRun(scriptPath, ["--allow-remote"], seedEnv)) {
      console.error(`WARN: ${scriptPath} exited non-zero.`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\nProvision finished with ${failed} seed failure(s).`);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log(`\n${DRY_RUN ? "Dry run complete — no changes made." : "Provision complete."}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
