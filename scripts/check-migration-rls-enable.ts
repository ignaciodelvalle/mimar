// Migration RLS-enable fence (A02-7, T3-F1).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// 0124 created `notification_dead_letter` — a table whose `payload` jsonb can
// carry owner-facing PII — and did not enable Row Level Security. 0125 did, one
// migration later. An environment where 0124 applied and 0125 did not (a
// partial apply, a failed deploy halfway through a batch) had the table open at
// `GET /rest/v1/notification_dead_letter` with nothing but the publishable key,
// because Supabase's default privileges grant every new public table to `anon`
// and `authenticated`.
//
// `lint:rls` and `__tests__/rls/coverage.test.ts` DO catch that state — against
// a live database, on the next run, after the fact. This fence catches it where
// it is written: a migration that creates a public table must enable RLS on it
// IN THE SAME FILE, so there is no apply boundary at which the table exists
// without it. Migrations are forward-only and immutable, so the historical
// offenders cannot be fixed in place; they are frozen below by filename.
//
// WHAT COUNTS
//   - `CREATE TABLE [IF NOT EXISTS] <name>` where <name> is unqualified or
//     `public.`-qualified. Other schemas (`pii`, `ref`, …) are not exposed by
//     PostgREST and are out of scope. TEMP / UNLOGGED-temp tables are skipped.
//   - A matching `ALTER TABLE [IF EXISTS] [ONLY] <name> ENABLE ROW LEVEL
//     SECURITY` for THAT table, anywhere in the same file. Per table, not per
//     file: a file that creates two tables and enables RLS on one is a hit.
//   - SQL comments are stripped first, so a commented-out ENABLE is not one.
//
// WHAT THIS CANNOT SEE (documented, not fixed — fresh-context review,
// pre-push, item 9; a text-based fence over `CREATE TABLE`/`ENABLE ROW LEVEL
// SECURITY` literals, not a SQL parser):
//   - `ALTER TABLE <name> SET SCHEMA public` — a table created in another
//     schema (out of scope by design, see WHAT COUNTS above) and later moved
//     INTO `public` never matches this fence's `CREATE TABLE` pattern, so it
//     is invisible on the migration that actually exposes it via PostgREST.
//   - `SELECT … INTO <name>` — creates a new public table with no `CREATE
//     TABLE` keyword at all; this fence only ever looks for that keyword.
//   - Dynamic `EXECUTE format('CREATE TABLE %I …', …)` (or any other
//     string-built DDL) — the table name and the statement itself are not
//     literal source text, so neither the CREATE nor a same-file ENABLE next
//     to it can be matched by a text scan.
//   - A LATER migration that runs `ALTER TABLE <name> DISABLE ROW LEVEL
//     SECURITY` — this fence only checks that RLS was enabled in the file
//     that creates the table; it does not track whether a subsequent
//     migration turns it back off.
//
// Run:  pnpm tsx scripts/check-migration-rls-enable.ts   (or: pnpm lint:migration-rls)
// Exits 1 listing each file:table without RLS, or any stale allowlist entry.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = "db/migrations";

/**
 * Historical offenders, frozen. FILE → the exact tables it creates without
 * enabling RLS in the same file, each enabled by a LATER migration (named in
 * the comment). EXACT, not a ceiling: an entry that no longer matches is a
 * failure too, so this list can only be read as the truth.
 *
 * Never add a new migration here. A new table enables RLS in its own file —
 * deny-all (no policies) is a perfectly good posture for a server-only table.
 */
//
// Measured 2026-09-22: 27 tables in 19 files, every one enabled later — most
// by 0086 (RLS moved into migrations), the rest by 0004, 0094, 0113 and 0125.
// None is still RLS-off in a fully migrated database; the exposure was the
// window between the two files.
export const HISTORICAL_OFFENDERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "0000_orgs_foundation.sql": [
    "organizations",
    "organization_coverage",
    "organization_memberships",
  ], // 0086
  "0003_org_capability_grants.sql": ["organization_capability_grants"], // 0004
  "0008_libreta_share_tokens.sql": ["libreta_share_tokens"], // 0086
  "0010_admin_fase_0.sql": ["govt_assignments", "approval_requests", "audit_log"], // 0086
  "0013_scheduling_foundation.sql": [
    "service_offerings",
    "service_schedule_rules",
    "time_slots",
    "appointments",
  ], // 0086
  "0022_foster_volunteers_pool.sql": ["foster_volunteers", "foster_proposals"], // 0086
  "0027_rate_limit_buckets.sql": ["rate_limit_buckets"], // 0113
  "0032_share_telemetry.sql": ["share_telemetry"], // 0086
  "0033_cases.sql": ["cases"], // 0094
  "0037_govt_business_rules.sql": ["govt_business_rules"], // 0113
  "0044_physical_tag_interest.sql": ["physical_tag_interest"], // 0086
  "0048_event_notification_outbox.sql": ["event_notification_outbox"], // 0086
  "0053_eno_processing_queue.sql": ["eno_processing_queue"], // 0086
  "0054_pet_transfers.sql": ["pet_transfers"], // 0086
  "0056_pet_identifications_polymorphic.sql": ["pet_identifications"], // 0086
  "0067_jurisdictions_census.sql": ["jurisdictions_census"], // 0113
  "0069_case_events.sql": ["case_events"], // 0086
  "0071_organization_invitations.sql": ["organization_invitations"], // 0086
  "0124_notifications_dedupe_key_and_dead_letter.sql": ["notification_dead_letter"], // 0125 (A02-7)
};

/**
 * Non-vacuity floor: how many public CREATE TABLE statements the scan must see.
 * 46 on 2026-09-22 (plus 4 in `ref`, 1 TEMP and 6 in comments, all correctly
 * skipped — 57 raw matches). A regex that stopped matching would report
 * "clean" over zero tables; this makes it report broken instead. Migrations
 * are append-only, so the real count can only grow.
 */
export const MIN_CREATE_TABLES_SEEN = 46;

export type CreatedTable = { table: string; line: number };
export type Hit = { file: string; table: string; line: number };

/** Strip `-- …` line comments and `/* … *\/` block comments, preserving newlines. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:(${IDENT})\s*\.\s*)?(${IDENT})`;

const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`,
  "gi",
);

const ENABLE_RLS = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b`,
  "gi",
);

function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1) : ident.toLowerCase();
}

function isPublic(schema: string | undefined): boolean {
  return schema === undefined || unquote(schema) === "public";
}

/** Every public, non-temporary table the file creates, with its line number. */
export function createdPublicTables(sql: string): CreatedTable[] {
  const clean = stripSqlComments(sql);
  const out: CreatedTable[] = [];
  for (const m of clean.matchAll(CREATE_TABLE)) {
    const [, modifier, schema, name] = m;
    if (modifier && /^TEMP/i.test(modifier.trim())) continue;
    if (!isPublic(schema)) continue;
    out.push({ table: unquote(name), line: clean.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Every public table the file enables RLS on. */
export function rlsEnabledTables(sql: string): Set<string> {
  const clean = stripSqlComments(sql);
  const out = new Set<string>();
  for (const m of clean.matchAll(ENABLE_RLS)) {
    const [, schema, name] = m;
    if (isPublic(schema)) out.add(unquote(name));
  }
  return out;
}

/** Tables a single migration creates in public without enabling RLS on them. */
export function scanMigration(file: string, sql: string): Hit[] {
  const enabled = rlsEnabledTables(sql);
  return createdPublicTables(sql)
    .filter((t) => !enabled.has(t.table))
    .map((t) => ({ file, table: t.table, line: t.line }));
}

export type Verdict = {
  violations: Hit[];
  stale: string[];
  tablesSeen: number;
};

/**
 * Compare every file's hits against the frozen allowlist. A hit not in the
 * allowlist is a violation; an allowlist entry with no matching hit is stale.
 */
export function evaluate(
  files: ReadonlyArray<{ file: string; sql: string }>,
  allowlist: Readonly<Record<string, ReadonlyArray<string>>> = HISTORICAL_OFFENDERS,
): Verdict {
  const violations: Hit[] = [];
  const matched = new Set<string>();
  let tablesSeen = 0;
  for (const { file, sql } of files) {
    tablesSeen += createdPublicTables(sql).length;
    const allowed = new Set(allowlist[file] ?? []);
    for (const hit of scanMigration(file, sql)) {
      if (allowed.has(hit.table)) matched.add(`${file}:${hit.table}`);
      else violations.push(hit);
    }
  }
  const stale = Object.entries(allowlist)
    .flatMap(([file, tables]) => tables.map((t) => `${file}:${t}`))
    .filter((key) => !matched.has(key));
  return { violations, stale, tablesSeen };
}

export function readMigrations(dir: string = MIGRATIONS_DIR): Array<{ file: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), "utf8") }));
}

function main(): void {
  const files = readMigrations();
  const { violations, stale, tablesSeen } = evaluate(files);

  if (tablesSeen < MIN_CREATE_TABLES_SEEN) {
    console.error(
      `\n✗ only ${tablesSeen} public CREATE TABLE statement(s) seen across ${files.length} migrations (floor ${MIN_CREATE_TABLES_SEEN}). The scanner is broken, not the migrations.`,
    );
    process.exit(1);
  }

  let failed = false;
  if (violations.length > 0) {
    failed = true;
    console.error(
      "\n✗ migrations that create a public table without enabling RLS on it in the same file:",
    );
    for (const v of violations)
      console.error(`  ${MIGRATIONS_DIR}/${v.file}:${v.line}  ${v.table}`);
    console.error(
      "\n  Add `ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;` to the SAME migration. Deny-all (no policies) is fine for a server-only table; a table without RLS is readable by anon through PostgREST in any environment where this file applied and the next one did not (A02-7, 0124/0125).",
    );
  }
  if (stale.length > 0) {
    failed = true;
    console.error(
      "\n✗ HISTORICAL_OFFENDERS entries that no longer match a hit (the list is exact — remove them):",
    );
    for (const s of stale) console.error(`  ${s}`);
  }
  if (failed) process.exit(1);

  console.log(
    `✓ migration RLS fence clean — ${files.length} migrations, ${tablesSeen} public CREATE TABLE statements, ${Object.keys(HISTORICAL_OFFENDERS).length} frozen historical file(s).`,
  );
}

if (process.argv[1]?.includes("check-migration-rls-enable")) {
  main();
}
