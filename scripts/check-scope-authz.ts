// Scope ↔ authorization coherence fence (V1).
//
// THE FAILURE THIS EXISTS TO CATCH
// ---------------------------------------------------------------------------
// Staging ran for weeks with RLS disabled on 27 of 53 `public` tables — `pets`,
// `profiles`, `pet_events`, `ownerships`, `audit_log` among them — and the anon
// REST key returned full rows including a real user's email. NO SCREEN NOTICED,
// because nothing in the system ever compares the two claims:
//
//   (a) what the APPLICATION narrows to — the jurisdiction scope clauses in
//       lib/analytics/dashboards/_scope.ts and lib/metrics/scope.ts, which are
//       what every /gob dashboard says it is showing; and
//   (b) what the DATABASE would actually hand to a direct client.
//
// Today those two agree by discipline. This fence makes them agree by
// construction: every table the scope layer gates in SQL must also be gated by
// the database itself. A table the app narrows while `relrowsecurity = false`
// is a table where the app's promise is decoration.
//
// WHAT IT CHECKS
// ---------------------------------------------------------------------------
//   1. DERIVATION (offline, always runs) — the set of scope-gated tables is
//      derived MECHANICALLY from the scope-clause layer: the Drizzle table
//      identifiers each SCOPE_LAYER_FILE imports from `@/db` and actually
//      references. No hand-maintained table list to drift. Every identifier
//      must resolve to a `pgTable("…")` declaration in db/schema.ts.
//
//   2. RLS ENABLED (needs a DB) — `pg_class.relrowsecurity` must be true for
//      every scope-gated table. This is the exact staging failure class.
//
//   3. TABLE EXISTS (needs a DB) — a scope-gated identifier whose table is
//      absent from `public` means the scope layer and the schema have drifted
//      apart; the clause is being built against something that isn't there.
//
//   4. NO UNCONDITIONAL READ POLICY (needs a DB) — RLS enabled but with a
//      PERMISSIVE SELECT/ALL policy for `public` / `anon` / `authenticated`
//      whose USING clause is absent or literally `true` is RLS with the safety
//      off: every row still reaches every caller while the app narrows. This
//      is the same divergence wearing a policy as a disguise, and it is
//      invisible to lint:rls, which only COUNTS policies.
//
// RELATIONSHIP TO lint:rls (scripts/check-rls-coverage.ts)
// ---------------------------------------------------------------------------
// lint:rls asks a schema-wide question ("does every table have RLS and at
// least one policy?"). This fence asks a coherence question about a much
// smaller set ("do the tables the application CLAIMS to narrow actually get
// narrowed by the database?") and holds them to a stricter bar — a counted
// policy is not enough here, it has to be a policy that can say no. The two
// overlap on check 2 by design: coherence is worth asserting from the side
// that would notice.
//
// WHY IT SKIPS, LOUDLY
// ---------------------------------------------------------------------------
// `pnpm verify` already runs four lints that open a DATABASE_URL connection,
// and lint:rls has no graceful skip. An operator whose DATABASE_URL points at
// staging gets a wall of violations that have nothing to do with the code they
// just wrote — and the worst outcome is not the lost half hour, it is
// "fixing" RLS blind against the wrong database.
//
// So this fence NEVER guesses which database it is talking to:
//   * it prints the host/port/database on EVERY run, pass, fail, or skip;
//   * a NON-LOCAL host is a skip, not a failure — with the host named and the
//     opt-in spelled out;
//   * an unreachable database is a skip, with the reason quoted;
//   * a skip always states which checks did NOT run.
// Checks 1 is offline and runs regardless, so a skipped run still fails on a
// broken derivation. Silence is never the answer: every exit path prints.
//
// Auditing a REMOTE database on purpose: pass --allow-remote. The fence is
// strictly read-only (it SELECTs from pg_class / pg_policies and nothing else),
// but it must be an explicit, typed act — never a side effect of a stale shell.
//
// Run:  pnpm tsx scripts/check-scope-authz.ts   (or: pnpm lint:scope-authz)
// Exits 0 clean or skipped; exits 1 listing each incoherence.

import { readFileSync } from "node:fs";

import postgres from "postgres";

import {
  DEFAULT_LOCAL_URL,
  type DbTarget,
  describeTarget,
  lines,
  remoteRemedy,
  remoteSkipReason,
  reportSkip as reportDbSkip,
} from "./_db-target";
import { stripComments } from "./check-scope-discipline";

// ---------------------------------------------------------------------------
// The scope-clause layer
// ---------------------------------------------------------------------------

/**
 * The files that ARE the jurisdiction scope layer. Every Drizzle table these
 * import from `@/db` and reference is, by definition, a table the application
 * narrows before showing it to an operator.
 *
 * `_scope.ts` is the C3 consolidation home (54 raw references collapsed to 2
 * files); `lib/metrics/scope.ts` holds the canonical helpers `_scope.ts`
 * delegates to (petsScopeClause / petEventsScopeClause), so `pet_events` —
 * gated only through that delegation — is not missed.
 *
 * Adding a file here WIDENS the fence, which is always safe. Removing one
 * needs a reviewed reason.
 */
export const SCOPE_LAYER_FILES = [
  "lib/analytics/dashboards/_scope.ts",
  "lib/metrics/scope.ts",
] as const;

/** Where the Drizzle identifier → SQL table name mapping is read from. */
export const SCHEMA_FILE = "db/schema.ts";

/** Module specifiers that re-export the Drizzle table objects. */
const DB_MODULE_SPECIFIERS = new Set(["@/db", "@/db/schema", "../db", "../../db"]);

/**
 * Roles for which an unconditional read policy is a leak. `service_role` is
 * deliberately absent: the app connects with BYPASSRLS by design (see
 * check-rls-coverage.ts's header), so its access is not a divergence.
 */
export const UNTRUSTED_POLICY_ROLES = new Set(["public", "anon", "authenticated"]);

/**
 * Policies allowed to be unconditional on a scope-gated table, keyed
 * `table:policyname`. Every entry needs a one-line reason. Empty today, and
 * the bar for adding one is a reviewed decision — an unconditional read on a
 * scope-gated table is precisely what this fence exists to notice.
 */
export const UNCONDITIONAL_POLICY_ALLOWLIST: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Pure core — derivation and evaluation (unit-testable without a database)
// ---------------------------------------------------------------------------

export type ScopeSource = { file: string; content: string };

export type GatedTable = {
  /** Drizzle export name, e.g. `custodyDisputes`. */
  ident: string;
  /** SQL table name, e.g. `custody_disputes`. Null when unresolvable. */
  sqlName: string | null;
  /** Scope-layer files that gate it. */
  files: string[];
};

export type TableRlsRow = { table_name: string; rls_enabled: boolean };

export type PolicyRow = {
  table_name: string;
  policy_name: string;
  permissive: string; // "PERMISSIVE" | "RESTRICTIVE"
  roles: string[];
  cmd: string; // "SELECT" | "ALL" | "INSERT" | …
  qual: string | null;
};

export type Violation =
  | { kind: "unresolved_ident"; ident: string; files: string[] }
  | { kind: "missing_table"; ident: string; sqlName: string; files: string[] }
  | { kind: "rls_disabled"; ident: string; sqlName: string; files: string[] }
  | {
      kind: "unconditional_read_policy";
      ident: string;
      sqlName: string;
      files: string[];
      policyName: string;
      roles: string[];
      cmd: string;
    };

/**
 * Identifiers a source file imports from a `@/db` module.
 * Handles multi-line import lists; ignores `import type` (a type-only import
 * is not a table reference).
 */
export function importedDbIdents(strippedSource: string): Set<string> {
  const idents = new Set<string>();
  const importRe = /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null = importRe.exec(strippedSource);
  while (match !== null) {
    const isTypeOnly = match[1] !== undefined;
    const specifier = match[3];
    if (!isTypeOnly && DB_MODULE_SPECIFIERS.has(specifier)) {
      for (const raw of match[2].split(",")) {
        const clause = raw.trim();
        if (clause.length === 0) continue;
        // Skip per-specifier `type X` and take the local name of `X as Y`.
        if (/^type\s/.test(clause)) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
        idents.add(asMatch === null ? clause : asMatch[2]);
      }
    }
    match = importRe.exec(strippedSource);
  }
  return idents;
}

/** Drizzle export name → SQL table name, read from db/schema.ts. */
export function parseSchemaTableNames(schemaSource: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\(\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null = re.exec(schemaSource);
  while (match !== null) {
    map.set(match[1], match[2]);
    match = re.exec(schemaSource);
  }
  return map;
}

/**
 * Derive the scope-gated table set from the scope-layer sources.
 * An identifier counts only when it is BOTH imported from `@/db` AND actually
 * referenced as `ident.` in code — an unused import gates nothing.
 */
export function extractGatedTables(
  sources: ScopeSource[],
  schemaTables: Map<string, string>,
): GatedTable[] {
  const byIdent = new Map<string, Set<string>>();

  for (const { file, content } of sources) {
    const stripped = stripComments(content);
    for (const ident of importedDbIdents(stripped)) {
      // Referenced as a table (`pets.jurisdictionProvince`, `${pets.id}`)?
      const usageRe = new RegExp(`\\b${ident.replace(/\$/g, "\\$")}\\s*\\.`);
      if (!usageRe.test(stripped)) continue;
      const files = byIdent.get(ident) ?? new Set<string>();
      files.add(file);
      byIdent.set(ident, files);
    }
  }

  return [...byIdent.entries()]
    .map(([ident, files]) => ({
      ident,
      sqlName: schemaTables.get(ident) ?? null,
      files: [...files].sort(),
    }))
    .sort((a, b) => a.ident.localeCompare(b.ident));
}

/** True when a policy lets every row through for an untrusted role. */
export function isUnconditionalRead(policy: PolicyRow): boolean {
  if (policy.permissive.toUpperCase() !== "PERMISSIVE") return false;
  const cmd = policy.cmd.toUpperCase();
  if (cmd !== "SELECT" && cmd !== "ALL") return false;
  if (!policy.roles.some((r) => UNTRUSTED_POLICY_ROLES.has(r))) return false;
  // A SELECT/ALL policy with no USING clause permits every row.
  const qual = policy.qual?.trim().toLowerCase() ?? "";
  return qual === "" || qual === "true" || qual === "(true)";
}

/** Compare what the application gates against what the database enforces. */
export function evaluateCoherence(input: {
  gated: GatedTable[];
  tables: TableRlsRow[];
  policies: PolicyRow[];
}): Violation[] {
  const rlsByTable = new Map(input.tables.map((t) => [t.table_name, t.rls_enabled]));
  const violations: Violation[] = [];

  for (const g of input.gated) {
    if (g.sqlName === null) {
      violations.push({ kind: "unresolved_ident", ident: g.ident, files: g.files });
      continue;
    }
    const sqlName = g.sqlName;
    if (!rlsByTable.has(sqlName)) {
      violations.push({ kind: "missing_table", ident: g.ident, sqlName, files: g.files });
      continue;
    }
    if (rlsByTable.get(sqlName) !== true) {
      violations.push({ kind: "rls_disabled", ident: g.ident, sqlName, files: g.files });
      continue;
    }
    for (const p of input.policies) {
      if (p.table_name !== sqlName) continue;
      if (!isUnconditionalRead(p)) continue;
      const key = `${sqlName}:${p.policy_name}`;
      if (Object.hasOwn(UNCONDITIONAL_POLICY_ALLOWLIST, key)) continue;
      violations.push({
        kind: "unconditional_read_policy",
        ident: g.ident,
        sqlName,
        files: g.files,
        policyName: p.policy_name,
        roles: p.roles,
        cmd: p.cmd.toUpperCase(),
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Which database am I looking at?
// ---------------------------------------------------------------------------
//
// This fence wrote the local-vs-remote doctrine; its two DB-backed sisters
// (lint:rls, lint:spine) now answer the same question the same way, so the
// answer lives in scripts/_db-target.ts. Re-exported here because that is the
// import path the fence's own tests have always used.

export {
  DEFAULT_LOCAL_URL,
  LOCAL_HOSTS,
  type DbTarget,
  describeTarget,
} from "./_db-target";

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const SKIPPED_CHECKS = lines(
  "  NOT run: RLS-enabled, table-exists, unconditional-read-policy (checks 2-4).",
  "  Still run: the offline derivation of the scope-gated table set (check 1).",
);

function reportSkip(reason: string, target: DbTarget, remedy: string): void {
  reportDbSkip({
    fence: "check-scope-authz",
    reason,
    target,
    skipped: SKIPPED_CHECKS,
    remedy,
  });
}

function describeViolation(v: Violation): string {
  const where = v.files.join(", ");
  switch (v.kind) {
    case "unresolved_ident":
      return lines(
        `✗ ${v.ident} — gated by the scope layer (${where}) but has no pgTable("…") declaration`,
        `  in ${SCHEMA_FILE}.`,
        "  The scope layer is building a clause against something this fence cannot map to a real",
        "  table. Either the identifier was renamed in the schema, or it is not a table at all.",
      );
    case "missing_table":
      return lines(
        `✗ ${v.sqlName} (${v.ident}) — gated by the scope layer (${where}) but the table does`,
        "  not exist in the public schema of this database. The scope layer and the schema have",
        "  drifted apart; re-run migrations, or fix the scope layer.",
      );
    case "rls_disabled":
      return lines(
        `✗ ${v.sqlName} (${v.ident}) — the application NARROWS this table (${where}) but the`,
        "  database has RLS DISABLED (pg_class.relrowsecurity = false). A direct PostgREST client",
        "  with the anon key gets EVERY row, while the screens claim a jurisdiction view.",
        `  Fix: ALTER TABLE public.${v.sqlName} ENABLE ROW LEVEL SECURITY; in a new forward-only`,
        "  migration, plus at least one policy (or an intentional deny-all — see",
        "  DENY_ALL_ALLOWLIST in scripts/check-rls-coverage.ts).",
      );
    case "unconditional_read_policy":
      return lines(
        `✗ ${v.sqlName} (${v.ident}) — RLS is enabled, but policy "${v.policyName}" is a`,
        `  PERMISSIVE ${v.cmd} for [${v.roles.join(", ")}] with no USING clause (or USING (true)).`,
        `  Every row passes for those roles, so the narrowing the scope layer applies (${where})`,
        "  is not backed by the database at all. lint:rls counts this policy as coverage; it is not.",
        "  Fix: give the policy a real predicate, or — with a reviewed reason — add",
        `  "${v.sqlName}:${v.policyName}" to UNCONDITIONAL_POLICY_ALLOWLIST in this file.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCheck(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");

  // ---- Check 1: derivation (offline, always runs) -------------------------
  const sources: ScopeSource[] = SCOPE_LAYER_FILES.map((file) => {
    try {
      return { file, content: readFileSync(file, "utf8") };
    } catch {
      console.error(
        lines(
          `✗ check-scope-authz: scope-layer file ${file} does not exist.`,
          "  SCOPE_LAYER_FILES in scripts/check-scope-authz.ts is the fence's definition of",
          "  'what the application narrows'. If the file moved, update the list — do not delete",
          "  the entry, or the tables it gated silently stop being checked.",
        ),
      );
      process.exit(1);
      throw new Error("unreachable");
    }
  });

  const schemaTables = parseSchemaTableNames(readFileSync(SCHEMA_FILE, "utf8"));
  const gated = extractGatedTables(sources, schemaTables);

  if (gated.length === 0) {
    console.error(
      lines(
        `✗ check-scope-authz: derived ZERO scope-gated tables from ${SCOPE_LAYER_FILES.join(", ")}.`,
        "  That is not a pass — it means the derivation broke (import shape changed, file",
        "  refactored) and this fence would wave everything through.",
      ),
    );
    process.exit(1);
  }

  const gatedLabel = gated
    .map((g) => `${g.sqlName ?? `${g.ident}(unresolved)`}`)
    .sort()
    .join(", ");

  // ---- Target the database ------------------------------------------------
  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const usingDefault = process.env.DATABASE_URL === undefined;
  const target = describeTarget(rawUrl);

  const remoteSkip = remoteSkipReason(target, allowRemote);
  if (remoteSkip !== null) {
    reportSkip(remoteSkip, target, remoteRemedy("SELECTs pg_class / pg_policies"));
    console.log(
      `  Scope-gated tables derived offline (${gated.length}): ${gatedLabel} — derivation OK.`,
    );
    return;
  }

  const sql = postgres(rawUrl, { max: 1, connect_timeout: 5 });
  let tables: TableRlsRow[];
  let policies: PolicyRow[];
  try {
    tables = await sql<TableRlsRow[]>`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    `;
    policies = await sql<PolicyRow[]>`
      SELECT tablename AS table_name,
             policyname AS policy_name,
             permissive,
             roles::text[] AS roles,
             cmd,
             qual
      FROM pg_policies
      WHERE schemaname = 'public'
    `;
  } catch (err) {
    reportSkip(
      `could not reach the database (${err instanceof Error ? err.message : String(err)}).`,
      target,
      lines(
        "  Start the local stack with pnpm db:start, or set DATABASE_URL to a reachable database.",
        "  A DB-less CI box is not a failure — but this run proved nothing about RLS.",
      ),
    );
    console.log(
      `  Scope-gated tables derived offline (${gated.length}): ${gatedLabel} — derivation OK.`,
    );
    await sql.end({ timeout: 1 }).catch(() => {});
    return;
  }
  await sql.end({ timeout: 1 }).catch(() => {});

  const violations = evaluateCoherence({ gated, tables, policies });

  // The database being judged is named on EVERY exit path, pass or fail.
  const origin = usingDefault ? "default local URL" : "DATABASE_URL";
  const remoteNote = target.isLocal ? "" : " [REMOTE — --allow-remote]";
  const header = `  Database: ${target.label} (from ${origin})${remoteNote}`;

  if (violations.length > 0) {
    for (const v of violations) console.error(describeViolation(v));
    console.error(
      lines(
        "",
        `✗ Scope ↔ authorization coherence FAILED — ${violations.length} violation(s) across ${gated.length} scope-gated table(s).`,
        header,
        "  Scope-gated means: the application builds a jurisdiction WHERE-clause for this table,",
        "  so a screen claims to be showing a narrowed view of it. The database has to agree.",
      ),
    );
    process.exit(1);
  }

  console.log(
    `✓ Scope ↔ authorization coherent — ${gated.length} scope-gated table(s) all have RLS enabled and no unconditional read policy.`,
  );
  console.log(header);
  console.log(`  Gated (derived from ${SCOPE_LAYER_FILES.join(" + ")}): ${gatedLabel}`);
}

// Guard: only run when invoked directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-scope-authz.ts") ||
    process.argv[1].endsWith("check-scope-authz.js"));

if (isMain) {
  runCheck(process.argv.slice(2)).catch((err) => {
    console.error("✗ check-scope-authz: unexpected error:", err);
    process.exit(1);
  });
}
