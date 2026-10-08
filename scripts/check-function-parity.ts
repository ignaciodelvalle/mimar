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
// Each OVERLOAD is its own function: both sides key by `name(identity arg
// types)`, so two overloads of one name never compare against each other.
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

import { postgresTlsOption } from "../db/tls";
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
  /**
   * The overload's identity: `name(type, type)` with the input argument TYPES
   * only, spelled the way Postgres's `oidvectortypes(proargtypes)` spells them
   * (see `identityArgTypes`). Two overloads of one name are two functions —
   * keying by name alone compared one overload's body against the other's
   * (doctor red on `jurisdiction_admin_province` since 2026-09-27 with the
   * live bodies byte-identical to 0268).
   */
  key: string;
  /** The file whose definition is authoritative for this function. */
  source: string;
  /** The dollar-quoted body, verbatim (what pg_proc.prosrc stores). */
  body: string;
  /**
   * A tombstone: the authoritative statement for this overload is a DROP
   * FUNCTION (0271 drops two functions 0269 created). The live database must
   * NOT have it.
   */
  dropped?: true;
  /**
   * A DROP that named no argument list (`DROP FUNCTION f;`) with no known
   * overload to pin it to: the name as a whole must be absent live. Fails
   * closed — a surviving overload of that name reads as drift.
   */
  anyOverload?: true;
};

const CREATE_FN_HEAD_RE = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi;
const BODY_TAG_RE = /[\s\S]*?AS\s+(\$[a-zA-Z_]*\$)/iy;

/**
 * The text between the parenthesis at `open` and its balanced closing one, or
 * null when it never closes (argument lists nest: `numeric(10,2)`,
 * `DEFAULT now()`).
 */
function balancedParens(text: string, open: number): { inner: string; close: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, i), close: i };
    }
  }
  return null;
}

/** Split on commas that sit outside any parenthesis. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= list.length; i++) {
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if ((ch === "," && depth === 0) || ch === undefined) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return parts;
}

// Postgres's canonical spelling (format_type) for the aliases the repo writes.
const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  varchar: "character varying",
  char: "character",
  bpchar: "character",
  float8: "double precision",
  float4: "real",
  decimal: "numeric",
};

// Type spellings longer than one word; an argument that IS one of these (after
// typmod and array suffix are removed) has no parameter name.
const MULTIWORD_TYPES = [
  "timestamp with time zone",
  "timestamp without time zone",
  "time with time zone",
  "time without time zone",
  "double precision",
  "character varying",
  "bit varying",
];

function canonicalType(raw: string): string {
  let t = raw.toLowerCase().replace(/"/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:public|pg_catalog)\./, "");
  let arraySuffix = "";
  const arr = /(\s*\[\s*\d*\s*\])+$/.exec(t);
  if (arr !== null) {
    arraySuffix = "[]".repeat((arr[0].match(/\[/g) ?? []).length);
    t = t.slice(0, arr.index).trim();
  }
  // Typmods are not part of the identity (`numeric(10,2)` is `numeric`).
  t = t
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (TYPE_ALIASES[t] ?? t) + arraySuffix;
}

/**
 * The identity argument types of one CREATE/DROP FUNCTION argument list, in
 * Postgres's spelling: OUT parameters dropped (they are not part of the
 * identity), parameter names, modes and defaults dropped, aliases canonical.
 * Returns null when an argument cannot be read — the caller then refuses to
 * guess an overload.
 */
export function identityArgTypes(argList: string): string[] | null {
  if (argList.trim() === "") return [];
  const out: string[] = [];
  for (const rawArg of splitTopLevel(argList)) {
    // Defaults are not part of the identity: cut at a top-level DEFAULT or `=`.
    let arg = rawArg.replace(/--[^\n]*/g, " ").trim();
    const def = /\s+DEFAULT\s+|\s*=\s*/i.exec(arg);
    if (def !== null) arg = arg.slice(0, def.index).trim();
    let words = arg.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) return null;
    const mode = words[0].toUpperCase();
    if (mode === "OUT") continue;
    if (mode === "IN" || mode === "INOUT" || mode === "VARIADIC") words = words.slice(1);
    if (words.length === 0) return null;
    const whole = words.join(" ");
    const bare = canonicalType(whole).replace(/\[\]/g, "");
    const isUnnamed = words.length === 1 || MULTIWORD_TYPES.includes(bare);
    out.push(canonicalType(isUnnamed ? whole : words.slice(1).join(" ")));
  }
  return out;
}

function overloadKey(name: string, types: string[]): string {
  return `${name}(${types.join(", ")})`;
}

/**
 * Extract every `CREATE [OR REPLACE] FUNCTION public.<name>(<args>) ... AS
 * $tag$ ... $tag$` definition from one SQL source. Returns them in file order;
 * the CALLER applies the last-definition-wins rule across files.
 */
export function extractFunctionBodies(source: string, contents: string): RepoFunction[] {
  return extractIndexedBodies(source, contents).map(({ fn }) => fn);
}

function extractIndexedBodies(
  source: string,
  contents: string,
): Array<{ fn: RepoFunction; index: number }> {
  const out: Array<{ fn: RepoFunction; index: number }> = [];
  for (const m of contents.matchAll(CREATE_FN_HEAD_RE)) {
    const name = m[1];
    const start = m.index ?? 0;
    const args = balancedParens(contents, start + m[0].length - 1);
    if (args === null) continue; // malformed — never guess a body
    const types = identityArgTypes(args.inner);
    if (types === null) continue; // unreadable signature — never guess an overload
    BODY_TAG_RE.lastIndex = args.close + 1;
    const tagMatch = BODY_TAG_RE.exec(contents);
    if (tagMatch === null) continue;
    const tag = tagMatch[1];
    const bodyStart = args.close + 1 + tagMatch[0].length;
    const end = contents.indexOf(tag, bodyStart);
    if (end === -1) continue; // malformed — never guess a body
    out.push({
      fn: { name, key: overloadKey(name, types), source, body: contents.slice(bodyStart, end) },
      index: start,
    });
  }
  return out;
}

const DROP_FN_RE = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([^;]+);/gi;

/**
 * Every function a `DROP FUNCTION [IF EXISTS] a(...), b(...);` statement names,
 * with the statement's offset so the caller can order it against CREATEs in
 * the same file (a drop-then-recreate must end up live, not tombstoned).
 * `key` is the overload when the target carries an argument list, null when
 * it names the function alone.
 */
export function extractFunctionDrops(
  contents: string,
): Array<{ name: string; key: string | null; index: number }> {
  const out: Array<{ name: string; key: string | null; index: number }> = [];
  for (const m of contents.matchAll(DROP_FN_RE)) {
    // Split the target list on TOP-LEVEL commas only — argument lists nest.
    const list = m[1].replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, "");
    for (const target of splitTopLevel(list)) {
      const head = /^\s*(?:public\.)?(\w+)\s*(\(|$)/i.exec(target);
      if (head === null) continue;
      const name = head[1];
      let key: string | null = null;
      if (head[2] === "(") {
        const args = balancedParens(target, head[0].length - 1);
        const types = args === null ? null : identityArgTypes(args.inner);
        if (types === null) continue; // unreadable — never guess an overload
        key = overloadKey(name, types);
      }
      out.push({ name, key, index: m.index ?? 0 });
    }
  }
  return out;
}

/**
 * The authoritative body per OVERLOAD (`name(arg types)`): db/triggers.sql
 * wins for the overloads it defines (hand-applied source of truth — see
 * header); otherwise the last defining migration wins. A later DROP FUNCTION
 * (in file order, then statement order) leaves a tombstone instead: the
 * overload must be absent live. A DROP with no argument list tombstones every
 * overload of that name known so far (or, if none is known, the name itself).
 */
export function collectRepoFunctions(
  migrationFiles: Array<{ name: string; contents: string }>,
  triggersContents: string | null,
): Map<string, RepoFunction> {
  const byKey = new Map<string, RepoFunction>();
  for (const f of migrationFiles) {
    type Ev =
      | { kind: "create"; fn: RepoFunction; index: number }
      | { kind: "drop"; name: string; key: string | null; index: number };
    const events: Ev[] = [
      ...extractIndexedBodies(f.name, f.contents).map(
        ({ fn, index }) => ({ kind: "create", fn, index }) as Ev,
      ),
      ...extractFunctionDrops(f.contents).map((d) => ({ kind: "drop", ...d }) as Ev),
    ].sort((a, b) => a.index - b.index);
    for (const ev of events) {
      // Files arrive sorted — later overwrites earlier.
      if (ev.kind === "create") {
        byKey.delete(ev.fn.name); // a CREATE supersedes a name-level tombstone
        byKey.set(ev.fn.key, ev.fn);
        continue;
      }
      const tomb = (key: string, anyOverload?: true): RepoFunction => ({
        name: ev.name,
        key,
        source: f.name,
        body: "",
        dropped: true,
        ...(anyOverload ? { anyOverload } : {}),
      });
      if (ev.key !== null) {
        byKey.set(ev.key, tomb(ev.key));
        continue;
      }
      const known = [...byKey.values()].filter((fn) => fn.name === ev.name && !fn.anyOverload);
      if (known.length === 0) byKey.set(ev.name, tomb(ev.name, true));
      for (const fn of known) byKey.set(fn.key, tomb(fn.key));
    }
  }
  if (triggersContents !== null) {
    for (const fn of extractFunctionBodies(TRIGGERS_FILE, triggersContents)) {
      byKey.set(fn.key, fn); // triggers.sql OVERRIDES — see authority rule
    }
  }
  return byKey;
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
  const names = [...new Set([...repoFns.values()].map((fn) => fn.name))];
  const failures: string[] = [];

  if (names.length === 0) {
    return {
      name: "D. Function parity",
      failures: ["no CREATE FUNCTION statements found in db/ — the scanner is broken, not the DB"],
      note: "",
    };
  }

  // oidvectortypes(proargtypes) = the identity argument types, format_type
  // spelling, no parameter names — the same shape identityArgTypes produces.
  const rows = (await client`
    select p.proname as name,
           p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as key,
           p.prosrc as prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(${names})
  `) as Array<{ name: string; key: string; prosrc: string }>;
  const live = new Map(rows.map((r) => [r.key, r.prosrc]));
  const liveKeysByName = (name: string) => rows.filter((r) => r.name === name).map((r) => r.key);

  for (const [key, fn] of repoFns) {
    if (fn.anyOverload) {
      const survivors = liveKeysByName(fn.name);
      if (survivors.length > 0) {
        failures.push(
          `${fn.name}: dropped by ${fn.source} but still PRESENT in the live database (${survivors.join("; ")})`,
        );
      }
      continue;
    }
    const deployed = live.get(key);
    if (fn.dropped) {
      if (deployed !== undefined) {
        failures.push(`${key}: dropped by ${fn.source} but still PRESENT in the live database`);
      }
      continue;
    }
    if (deployed === undefined) {
      const others = liveKeysByName(fn.name);
      failures.push(
        `${key}: defined in ${fn.source} but MISSING from the live database${
          others.length > 0 ? ` (live overloads of that name: ${others.join("; ")})` : ""
        }`,
      );
      continue;
    }
    if (normalizeBody(deployed) !== normalizeBody(fn.body)) {
      failures.push(
        `${key}: live body DIFFERS from ${fn.source} — the E-3 drift class. Re-apply that source (and find out how the drift happened).`,
      );
    }
  }

  return {
    name: "D. Function parity",
    failures,
    note: `${repoFns.size} repo-owned function overload(s) compared against pg_proc.prosrc.`,
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

  const client = postgres(rawUrl, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
    ssl: postgresTlsOption(rawUrl),
  });
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
