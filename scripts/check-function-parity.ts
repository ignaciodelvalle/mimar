// check-function-parity — does the LIVE body of every repo-owned Postgres
// function match the source that claims to define it?
//
// WHY (errata E-3, docs/db/migration-errata.md): staging once ran a PRE-0085
// body of enforce_audit_log_append_only() while the migration ledger said 0085
// was applied — "aplicada" no es "cerrada". The ledger checks that migration
// FILES ran; nothing checked that the function BODIES the migrations created
// are the ones actually deployed. A `drizzle-kit push` + baseline, a hand
// patch, or a partially-applied migration all produce exactly this drift.
//
// WHAT IT COMPARES: pg_proc.prosrc (the verbatim dollar-quoted body Postgres
// stores) against the body extracted from the source that OWNS each function:
//   1. db/triggers.sql wins for every function it defines — its own header
//      declares it the hand-applied source of truth, and the live DB agrees
//      (measured 2026-08-16: enforce_pet_events_append_only's live body
//      matches triggers.sql, not its older migration snapshot 0127);
//   2. otherwise the LAST defining migration in db/migrations/*.sql
//      (lexically sorted — the same rule E-3 used to name 0085 as canonical).
// Consequence, deliberate: a future migration that patches a triggers-owned
// function WITHOUT updating triggers.sql gets flagged — the two sources are
// forced to reconcile instead of silently forking.
// Comparing prosrc (not pg_get_functiondef) sidesteps Postgres's header
// reformatting: prosrc is stored exactly as the source supplied it.
//
// REFUSAL DISCIPLINE (same as db:doctor): an unreachable database or a remote
// one without --allow-remote is a FAILURE, never a silent skip — this script
// exists to examine one specific environment.
//
// Usage:
//   pnpm check:function-parity                     (local stack)
//   DATABASE_URL=... pnpm check:function-parity -- --allow-remote
// Also runs as section D of `pnpm db:doctor` (check-ledger-honesty.ts).

import { readFileSync } from "node:fs";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import postgres from "postgres";

import {
  DEFAULT_LOCAL_URL,
  type DbTarget,
  describeTarget,
  lines,
  remoteSkipReason,
} from "./_db-target";
import { listMigrationFiles } from "./migrate";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const MIGRATIONS_DIR = "db/migrations";
const TRIGGERS_FILE = "db/triggers.sql";

// ---------------------------------------------------------------------------
// Pure scanning logic (unit-tested without a DB)
// ---------------------------------------------------------------------------

export type RepoFunction = {
  name: string;
  /** The file whose definition is authoritative for this function. */
  source: string;
  /** The dollar-quoted body, verbatim (what pg_proc.prosrc stores). */
  body: string;
};

const CREATE_FN_RE =
  /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:public\.)?(\w+)\s*\([^)]*\)[\s\S]*?AS\s+(\$[a-zA-Z_]*\$)/gi;

/**
 * Extract every `CREATE [OR REPLACE] FUNCTION public.<name> ... AS $tag$ ...
 * $tag$` definition from one SQL source. Returns them in file order; the
 * CALLER applies the last-definition-wins rule across files.
 */
export function extractFunctionBodies(source: string, contents: string): RepoFunction[] {
  const out: RepoFunction[] = [];
  for (const m of contents.matchAll(CREATE_FN_RE)) {
    const name = m[1];
    const tag = m[2];
    const bodyStart = (m.index ?? 0) + m[0].length;
    const end = contents.indexOf(tag, bodyStart);
    if (end === -1) continue; // malformed — never guess a body
    out.push({ name, source, body: contents.slice(bodyStart, end) });
  }
  return out;
}

/**
 * The authoritative body per function name: db/triggers.sql wins for the
 * functions it defines (hand-applied source of truth — see header); otherwise
 * the last defining migration wins.
 */
export function collectRepoFunctions(
  migrationFiles: Array<{ name: string; contents: string }>,
  triggersContents: string | null,
): Map<string, RepoFunction> {
  const byName = new Map<string, RepoFunction>();
  for (const f of migrationFiles) {
    for (const fn of extractFunctionBodies(f.name, f.contents)) {
      byName.set(fn.name, fn); // files arrive sorted — later overwrites earlier
    }
  }
  if (triggersContents !== null) {
    for (const fn of extractFunctionBodies(TRIGGERS_FILE, triggersContents)) {
      byName.set(fn.name, fn); // triggers.sql OVERRIDES — see authority rule
    }
  }
  return byName;
}

/** Line-ending + edge-whitespace normalization; the body text itself must match. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// DB comparison
// ---------------------------------------------------------------------------

type Client = ReturnType<typeof postgres>;
type Section = { name: string; failures: string[]; note: string };

export async function checkFunctionParity(client: Client): Promise<Section> {
  const migrationFiles = listMigrationFiles(MIGRATIONS_DIR).map((name) => ({
    name,
    contents: readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
  }));
  let triggers: string | null = null;
  try {
    triggers = readFileSync(TRIGGERS_FILE, "utf8");
  } catch {
    triggers = null; // triggers.sql absent — migrations-only scope
  }

  const repoFns = collectRepoFunctions(migrationFiles, triggers);
  const names = [...repoFns.keys()];
  const failures: string[] = [];

  if (names.length === 0) {
    return {
      name: "D. Function parity",
      failures: ["no CREATE FUNCTION statements found in db/ — the scanner is broken, not the DB"],
      note: "",
    };
  }

  const rows = (await client`
    select p.proname as name, p.prosrc as prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${names})
  `) as Array<{ name: string; prosrc: string }>;
  const live = new Map(rows.map((r) => [r.name, r.prosrc]));

  for (const [name, fn] of repoFns) {
    const deployed = live.get(name);
    if (deployed === undefined) {
      failures.push(`${name}: defined in ${fn.source} but MISSING from the live database`);
      continue;
    }
    if (normalizeBody(deployed) !== normalizeBody(fn.body)) {
      failures.push(
        `${name}: live body DIFFERS from ${fn.source} — the E-3 drift class. Re-apply that source (and find out how the drift happened).`,
      );
    }
  }

  return {
    name: "D. Function parity",
    failures,
    note: `${names.length} repo-owned function(s) compared against pg_proc.prosrc.`,
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

function refuse(reason: string, remedy: string, target: DbTarget): never {
  console.error(`✗ check-function-parity refused: ${reason}`);
  console.error(`  Database looked at: ${target.label}`);
  console.error(remedy);
  process.exit(2);
}

export async function runFunctionParity(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");
  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const target = describeTarget(rawUrl);

  const remote = remoteSkipReason(target, allowRemote);
  if (remote !== null) {
    refuse(
      remote,
      lines(
        "  Auditing a remote database has to be deliberate, not a side effect of a stale shell.",
        "  This script is strictly read-only (SELECTs against pg_proc/pg_namespace).",
        "  To audit staging on purpose:",
        "    DATABASE_URL=... pnpm check:function-parity -- --allow-remote",
      ),
      target,
    );
  }

  const client = postgres(rawUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    let section: Section;
    try {
      section = await checkFunctionParity(client);
    } catch (err) {
      refuse(
        `Could not reach the database (${err instanceof Error ? err.message : String(err)}).`,
        lines(
          "  Start the local stack with pnpm db:start, or point DATABASE_URL at a reachable database.",
          "  An unreachable database is a FAILURE here: this script examines one specific environment.",
        ),
        target,
      );
    }

    console.log(`\ncheck-function-parity — ${target.label}\n`);
    if (section.failures.length === 0) {
      console.log(`✓ ${section.name} — ${section.note}`);
    } else {
      console.error(`✗ ${section.name} — ${section.failures.length} function(s) drifted:`);
      for (const f of section.failures) console.error(`    ${f}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("check-function-parity.ts");
if (isMain) {
  runFunctionParity(process.argv.slice(2));
}
