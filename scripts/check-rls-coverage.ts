// RLS coverage CI gate — security guardrail (R10).
//
// Asserts that every table in the public schema that holds user, PII, or
// operational data has:
//   1. Row Level Security ENABLED  (pg_class.relrowsecurity = true)
//   2. At least one RLS policy     (pg_policies count > 0)
//        OR is in the explicit DENY_ALL_ALLOWLIST (deny-all is intentional).
//   3. Every policy names its ROLES explicitly — pg_policies.roles is not
//        `{public}` — unless allowlisted in PUBLIC_ROLE_ALLOWLIST with a reason.
//
// And, outside the public schema, one check on storage.objects:
//   4. No SELECT/ALL policy grants a caller role (anon/authenticated/public)
//        read access with a predicate that never references auth.uid() — that
//        is a bucket enumeration grant. See "check 4" below.
//
// WHY 3 EXISTS (2026-08-05). Checks 1 and 2 are existence checks: RLS on, at
// least one policy. That is a COUNT, and a count cannot tell you who the policy
// lets in. Ten live policies were found with no TO clause at all — across
// custody_disputes, custody_dispute_parties, cases, pet_service_dog,
// pet_achievement_views, cron_runs, ar_localities and its import-runs table. No
// TO clause means PUBLIC, which in Postgres means every role including `anon`,
// the key that ships in the client bundle. This fence counted all ten as
// coverage and printed "RLS coverage clean". They were safe only because each
// predicate resolves through auth.uid(), which is NULL for anon — one relaxed
// predicate away from an anonymous read. Migration 0168 narrowed all ten to
// `TO authenticated`; this check is what stops the eleventh.
//
// Source of truth: the local Supabase Docker DB (same DB that migrations run
// against). The script queries pg_class + pg_policies directly — it does NOT
// parse migrations, so it catches regressions where a new migration adds a
// table without calling ENABLE ROW LEVEL SECURITY.
//
// Tables NOT in db/schema.ts (e.g. Supabase-internal tables) are ignored
// unless they appear in the public schema pg_class result.
//
// DENY_ALL_ALLOWLIST — tables that legitimately have RLS ENABLED but zero
// policies (deny-all to PostgREST, which is the safe default). Every entry
// must include a one-line reason. See migration 0086 §PART 6 and §PART 7 and
// migration 0113 for the design rationale: the app connects via service-role
// (BYPASSRLS), so deny-all to PostgREST cannot lock the app out.
//
// WHICH DATABASE — this fence skips, loudly
// ---------------------------------------------------------------------------
// It judges whatever DATABASE_URL points at, so it must never guess which
// database that is. A non-local host is a SKIP (the cutover runbook leaves a
// staging pooler in the shell — readiness doc §B4 — and "fixing" RLS blind
// against the wrong database is worse than the lost half hour); an unreachable
// database is a SKIP with the reason quoted. Both name the host and say which
// checks did not run. Auditing a remote database on purpose: --allow-remote.
// The contract is shared with lint:scope-authz and lint:spine — see
// scripts/_db-target.ts.
//
// Run:  pnpm tsx scripts/check-rls-coverage.ts   (or: pnpm lint:rls)
// Exits 0 when every non-allowlisted table has RLS + at least one policy, and
//   when the run was skipped (remote or unreachable — a DB-less CI box is not
//   a failure).
// Exits 1 listing each violation.

import { globSync, readFileSync } from "node:fs";

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
import { normalize, stripSqlComments } from "./check-storage-write-policies";

// ---------------------------------------------------------------------------
// Allowlist — tables with RLS ENABLED and zero policies (intentional deny-all)
// ---------------------------------------------------------------------------
// Keyed by exact table name (public schema). Value = reason string.
export const DENY_ALL_ALLOWLIST: Record<string, string> = {
  // Internal migration-tracking table; Supabase CLI manages it, no app reads.
  _dim_migrations:
    "Internal Supabase migration tracker; app never reads via PostgREST. Deny-all is safe.",
  // alert_firings — admin-only inbox (migration 0111). Drizzle/service-role only.
  alert_firings:
    "Admin alert triage table; written and read exclusively via Drizzle (service-role). Deny-all to PostgREST is safe.",
  // case_events — case timeline (migration 0069). Server actions only.
  case_events:
    "Case timeline notes (PII-adjacent); accessed only by case server actions via Drizzle. Deny-all to PostgREST is safe.",
  // eno_processing_queue — internal work queue (migration 0053). Service role only.
  eno_processing_queue:
    "ENO zoonosis notification work queue; drained by cron via service-role only. Deny-all to PostgREST is safe.",
  // event_notification_outbox — payload snapshots (migration 0048). Service role only.
  event_notification_outbox:
    "Event notification outbox (may contain PII); drained by service-role. Deny-all to PostgREST is safe.",
  // notification_dead_letter — failed-notification payloads (migration 0125). Service role only.
  notification_dead_letter:
    "Recoverable failed-notification payloads (may contain PII); written by the createNotification service and drained by a retry cron, both via Drizzle/service-role. Deny-all to PostgREST is safe.",
  // govt_business_rules — jurisdiction policy reference (migration 0086 §PART 7).
  // Authority-published reference data, no personal data, writes are admin-only.
  govt_business_rules:
    "Jurisdiction policy reference (breed lists, weight thresholds); no personal data, admin-only writes. Deny-all to PostgREST is safe.",
  // jurisdictions_census — public provincial census figures (migration 0086 §PART 7).
  jurisdictions_census:
    "Public provincial census figures; no personal data. Deny-all to PostgREST is safe.",
  // organization_invitations — invitee email + token (migration 0071). Server actions only.
  organization_invitations:
    "Invitee email + invite token (PII); accept/list flows run via Drizzle server actions. Deny-all to PostgREST is safe.",
  // panorama_cube — precomputed choropleth aggregate (migration 0139). Service-role reads only.
  panorama_cube:
    "Precomputed panorama aggregate; k-anon'd at build, read only via analyticsDb service-role. Deny-all to PostgREST is safe.",
  // panorama_cube_meta — cube build metadata singleton (migration 0139). Service-role reads only.
  panorama_cube_meta:
    "Panorama cube build metadata singleton; read only via analyticsDb service-role. Deny-all to PostgREST is safe.",
  // panorama_kpi_cube — precomputed KPI-strip tiles (migration 0151). Service-role reads only.
  panorama_kpi_cube:
    "Precomputed KPI-strip tiles; built k-anon'd by the refresh-cube cron, read only via analyticsDb service-role. Deny-all to PostgREST is safe.",
  // panorama_kpi_cube_meta — KPI cube build metadata singleton (migration 0151). Service-role reads only.
  panorama_kpi_cube_meta:
    "KPI cube build metadata singleton; read only via analyticsDb service-role. Deny-all to PostgREST is safe.",
  // physical_tag_interest — demand signal (migration 0044). Owner server actions only.
  physical_tag_interest:
    "Physical-tag demand signal (tenant-scoped); toggled via owner server actions. Deny-all to PostgREST is safe.",
  // rate_limit_buckets — ephemeral counters (migration 0086 §PART 7). Drizzle only.
  rate_limit_buckets:
    "Ephemeral rate-limit counters keyed by opaque/hashed bucket; no user identity. Deny-all to PostgREST is safe.",
  // share_telemetry was here until migration 0167 dropped the table (TEL-1,
  // PO 2026-08-04 — collected with no reader). Nothing replaces the entry.
};

// Tables that are explicitly NOT in db/schema.ts and should be ignored by the
// coverage gate. Add here only if the table is a Supabase or extension internal
// that shows up in the public schema.
export const SCHEMA_IGNORE_LIST = new Set<string>([]);

export type TableRlsRow = {
  table_name: string;
  rls_enabled: boolean;
  policy_count: string; // postgres driver returns numeric as string
};

/**
 * The one query that reads REAL RLS state (pg_class + pg_policies) for every
 * public table. Exported so scripts/check-ledger-honesty.ts asks the database
 * the same question this fence does — one definition of "has RLS", not two that
 * can drift apart. Takes an open client; connection policy stays with the caller.
 */
export async function fetchRlsCoverage(client: postgres.Sql): Promise<TableRlsRow[]> {
  return await client<TableRlsRow[]>`
    SELECT
      c.relname        AS table_name,
      c.relrowsecurity AS rls_enabled,
      count(p.policyname)::text AS policy_count
    FROM pg_class c
    LEFT JOIN pg_policies p
      ON  p.tablename  = c.relname
      AND p.schemaname = 'public'
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind      = 'r'
    GROUP BY c.relname, c.relrowsecurity
    ORDER BY c.relname
  `;
}

// ---------------------------------------------------------------------------
// Policy ROLES — check 3
// ---------------------------------------------------------------------------

/**
 * Policies allowed to keep the PUBLIC default role set, keyed
 * `table:policyname`. Every entry needs a one-line reason naming the role that
 * is supposed to reach it. Empty is the goal: `TO public` includes `anon`, and
 * a policy that genuinely wants anonymous readers should say `TO anon` and be
 * read as such by the next person.
 */
export const PUBLIC_ROLE_ALLOWLIST: Record<string, string> = {};

export type PolicyRoleRow = {
  table_name: string;
  policy_name: string;
  roles: string[];
  cmd: string;
};

/**
 * Roles for every policy in the public schema. Deliberately a SECOND query
 * rather than a widening of fetchRlsCoverage: that one is shared with
 * scripts/check-ledger-honesty.ts (`pnpm db:doctor`), which consumes its exact
 * row shape and its exact violation kinds. One definition of "has RLS" stays
 * one definition; "who does this policy admit" is a different question and gets
 * its own.
 */
export async function fetchPolicyRoles(client: postgres.Sql): Promise<PolicyRoleRow[]> {
  return await client<PolicyRoleRow[]>`
    SELECT tablename  AS table_name,
           policyname AS policy_name,
           roles::text[] AS roles,
           cmd
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `;
}

export type PolicyRoleViolation = {
  table_name: string;
  policy_name: string;
  cmd: string;
};

/** Policies whose role set is the PUBLIC default and are not allowlisted. */
export function evaluatePolicyRoles(rows: PolicyRoleRow[]): {
  violations: PolicyRoleViolation[];
  allowlisted: string[];
} {
  const violations: PolicyRoleViolation[] = [];
  const allowlisted: string[] = [];

  for (const row of rows) {
    // pg_policies renders "no TO clause" as the single role `public`. Any other
    // value — {authenticated}, {anon,authenticated}, {service_role} — is an
    // explicit decision someone wrote down.
    if (row.roles.length !== 1 || row.roles[0] !== "public") continue;

    const key = `${row.table_name}:${row.policy_name}`;
    if (Object.hasOwn(PUBLIC_ROLE_ALLOWLIST, key)) {
      allowlisted.push(key);
    } else {
      violations.push({
        table_name: row.table_name,
        policy_name: row.policy_name,
        cmd: row.cmd.toUpperCase(),
      });
    }
  }

  return { violations, allowlisted };
}

// ---------------------------------------------------------------------------
// Storage bucket READ policies — check 4
// ---------------------------------------------------------------------------
//
// WHY 4 EXISTS (2026-08-12). Checks 1-3 sweep the PUBLIC schema. storage.objects
// lives in the `storage` schema, so every one of them — and rls-smoke.ts too —
// was structurally blind to it. Three separate incidents landed in that blind
// spot: migration 0123(B) (pet-photos public list), 0164 (welfare-evidence, the
// national cruelty-evidence corpus, anonymously listable) and 0172 (the three
// export buckets plus event-attachments and revocations). All five had a fully
// green gate at the time.
//
// The shared shape: a SELECT policy on storage.objects whose USING clause is
// `bucket_id = '<name>'` and nothing else. That predicate never mentions the
// caller, so it is TRUE for every object in the bucket — and Supabase's list
// endpoint (POST /storage/v1/object/list/{bucket}) is filtered by exactly this
// policy. Every one of them shipped with a comment claiming "discovery is gated
// by the SSR layer", which is false: SSR gates the PAGE, not the REST API.
//
// THE RULE: a SELECT (or ALL) policy on storage.objects that admits anon,
// authenticated or public must reference auth.uid() in its predicate. A read
// grant that cannot name the caller is an enumeration grant. Allowlist entries
// need a one-line reason.
//
// This check is row-independent — it reads pg_policies, not objects — so an
// empty bucket cannot make it pass vacuously.

/**
 * storage.objects read policies allowed to skip the auth.uid() requirement,
 * keyed by policy name. Every entry needs a one-line reason. Empty is the goal:
 * the durable fix for "the server needs to read this" is to sign as service
 * role behind a caller that has already authorized, not to grant the bucket to
 * every logged-in account.
 */
export const STORAGE_READ_POLICY_ALLOWLIST: Record<string, string> = {};

/** Roles that reach the client bundle or any logged-in account. */
const CALLER_ROLES = new Set(["anon", "authenticated", "public"]);

export type StoragePolicyRow = {
  policy_name: string;
  roles: string[];
  cmd: string;
  qual: string | null;
};

export async function fetchStoragePolicies(client: postgres.Sql): Promise<StoragePolicyRow[]> {
  return await client<StoragePolicyRow[]>`
    SELECT policyname AS policy_name,
           roles::text[] AS roles,
           cmd,
           qual
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
    ORDER BY policyname
  `;
}

export type StoragePolicyViolation = {
  policy_name: string;
  cmd: string;
  roles: string;
  qual: string;
};

/** Read policies that admit a caller role but cannot name the caller. */
export function evaluateStorageReadPolicies(rows: StoragePolicyRow[]): {
  violations: StoragePolicyViolation[];
  allowlisted: string[];
} {
  const violations: StoragePolicyViolation[] = [];
  const allowlisted: string[] = [];

  for (const row of rows) {
    const cmd = row.cmd.toUpperCase();
    // Only read paths enumerate. INSERT is a write grant and cannot list;
    // UPDATE/DELETE carry their own USING clause but do not expose content.
    //
    // THAT DECISION LEFT A BLIND SPOT, and it now has a fence of its own rather
    // than an unstated assumption. Not enumerating is not the same as being
    // scoped: `db/storage.sql` grants INSERT on pet-photos and on
    // event-attachments to every authenticated account with `bucket_id = '<name>'`
    // as the entire predicate, so anyone signed up may WRITE any object into
    // either bucket. Nothing here would have gone red if a third such grant
    // appeared. `scripts/check-storage-write-policies.ts` (pnpm
    // lint:storage-policies) covers the write commands statically, over the SQL
    // source, and freezes the two known grants exactly. The two are complements:
    // this fence guards what a database HAS, that one guards what the repo
    // DECLARES — and only one of them can fail a pull request before any
    // environment has the policy.
    if (cmd !== "SELECT" && cmd !== "ALL") continue;
    if (!row.roles.some((r) => CALLER_ROLES.has(r))) continue;

    // auth.uid() is the only way a storage policy can name who is asking.
    // `owner = auth.uid()`, `auth.uid() = owner`, or a subquery that joins
    // through auth.uid() all satisfy this; `bucket_id = 'x'` alone does not.
    if ((row.qual ?? "").includes("auth.uid()")) continue;

    if (Object.hasOwn(STORAGE_READ_POLICY_ALLOWLIST, row.policy_name)) {
      allowlisted.push(row.policy_name);
    } else {
      violations.push({
        policy_name: row.policy_name,
        cmd,
        roles: row.roles.join(", "),
        qual: row.qual ?? "(none)",
      });
    }
  }

  return { violations, allowlisted };
}

// ---------------------------------------------------------------------------
// Platform-admin predicates — check 5
// ---------------------------------------------------------------------------
//
// WHY 5 EXISTS (2026-09-09). `profiles` carries two lifecycle markers that mean
// different things: a deactivation sets `deactivated_at`; a Ley 25.326 art. 16
// erasure (`erase_subject_data`) sets `deleted_at`. Seventeen predicates in
// the live catalog decided "is this caller a platform admin" by testing
// `deactivated_at` — or nothing — and NEVER `deleted_at`, so an administrator
// who erased their own account kept administrative authority at the RLS
// layer, including over the access and erasure RPCs of every other person
// (`pii.caller_is_admin`, the guard those RPCs call). Migration 0215 closed all
// seventeen. This check is what stops the eighteenth.
//
// AND THE GOVT TWIN (migration 0216). 0215 left the `govt` branches alone on
// purpose, and they had the same hole: five policies and can_read_case decided
// "is this caller a govt operator in this jurisdiction" off `deactivated_at`
// or nothing. Deactivation revokes an operator's govt_assignments; erasure
// does not — so an erased govt kept reading every approval request in its
// jurisdiction, and every case there through can_read_case, on a bearer token
// already issued. The other four branches carried the same hole but were
// already unreachable through PostgREST for unrelated reasons (pets has no
// govt select policy; organization_memberships' peer policy recurses — see
// __tests__/rls/erased-admin-authority.test.ts). Since 0216 the rule below
// reads BOTH roles.
//
// THE RULE: wherever SQL tests `role = 'admin'` or `role = 'govt'` (or
// `role in ('admin', …)`, or `role = any(array['govt', …])`) against a row of
// `profiles`, the AND-group that test belongs to must also carry `deleted_at
// is null` AND `deactivated_at is null` for the same row. It bans the SUBJECT
// — platform authority read off an erased or deactivated profile — not a
// spelling, and not a list of files: a new policy, a new function, a new
// bootstrap file all fall under the same scan.
//
// WHAT IS NOT IN SUBJECT: `om.role = 'admin'` on organization_memberships is an
// ORGANIZATION role, a different concept on a table with no erasure marker. The
// scan decides by the FROM clause of the query the test sits in — a `role`
// test whose enclosing query does not read `profiles` (or reads it under a
// different alias than the one the test uses) is not a platform-admin test.
//
// HOW THE AND-GROUP IS FOUND. From the `role` test, climb the enclosing
// parentheses. At every level, keep the OR-alternative that contains the test
// and drop the child group already climbed through (a sibling branch — the
// `admin` alternative next to a `govt` one, or vice versa — must not lend its
// own `deleted_at` to the branch under test). Stop at the first level whose depth-0 text has a FROM; that
// is the query, and it names the profiles alias. The union of what was kept at
// each level is the text the two markers must appear in. Works on both forms
// the repo produces: the source files (`p.role = 'admin'`) and the catalog's
// deparsed rendering (`(p.role = 'admin'::user_role)`, every comparison in its
// own parentheses, `FROM (a JOIN profiles p ON …)`).
//
// TWO INPUTS, ONE RULE: the STATIC scan reads `db/*.sql` (the bootstrap files a
// pull request edits — caught before any environment has the policy; migrations
// are immutable history and legitimately contain the pre-0215 predicates, so
// they are not read) and the LIVE scan reads pg_policies + every repo-owned
// function body (what a database actually HAS, which is where a migration-only
// policy lives). __tests__/check-rls-coverage.test.ts runs the static half with
// no database; __tests__/rls/coverage.test.ts runs the live half.

/** The bootstrap sources the static scan reads. Not migrations — see above. */
export const ADMIN_PREDICATE_SQL_GLOB = "db/*.sql";

/**
 * Non-vacuity floors. Measured 2026-09-09 with both roles in the regex: 11
 * tests across db/*.sql (9 admin — rls.sql ×3, foster_rls.sql ×2,
 * welfare_rls.sql ×2, cases_rls.sql, revocations_storage.sql — plus the govt
 * branches of cases_rls.sql and rls.sql's approval_requests) and 25 in the
 * live catalog (19 admin + the govt branches of 5 policies and can_read_case).
 * Set below the measurements so a predicate can be retired without a false
 * alarm, and far above zero because zero is what a broken regex looks like —
 * the whole check would then pass by finding nothing.
 */
export const MIN_ADMIN_PREDICATES_IN_SOURCE = 8;
export const MIN_ADMIN_PREDICATES_IN_CATALOG = 18;

export type AdminPredicate = {
  /** A file path, or `policy <schema>.<table> "<name>"`, or `function <schema>.<name>`. */
  source: string;
  /** The role literal the test names. A test naming both (`role in ('admin', 'govt')`) reports the first. */
  role: "admin" | "govt";
  /** Alias the enclosing query reads profiles through; null when unaliased. */
  alias: string | null;
  /** The text the markers were looked for in — the effective AND-group, normalized. */
  conjunct: string;
  hasDeletedAt: boolean;
  hasDeactivatedAt: boolean;
};

/**
 * `role = 'admin'` / `'govt'`, `role in ('admin', …)`, `role = any(array['govt', …])` —
 * with or without an alias. Groups 2–4 capture the role literal, one per form
 * (lazy, so a list naming both reports the first). A fresh instance per scan:
 * a shared global regex carries lastIndex between calls.
 */
function adminRoleTest(): RegExp {
  return /(?:\b([a-z_][a-z0-9_]*)\.)?\brole\b\s*(?:=\s*'(admin|govt)'|in\s*\([^)]*?'(admin|govt)'|=\s*any\s*\(\s*array\s*\[[^\]]*?'(admin|govt)')/g;
}

/** `from profiles`, `join public.profiles p`, `from profiles as p` — the alias if any. */
const PROFILES_IN_FROM =
  /\b(?:from|join)\s+(?:public\.)?profiles\b(?:\s+(?:as\s+)?(?!(?:where|on|join|inner|left|right|full|cross|natural|using|group|order|limit|and|or|for)\b)([a-z_][a-z0-9_]*))?/;

type ParenIndex = {
  /** open index → close index. */
  matchOf: Map<number, number>;
  /** Paren depth before each character (string literals excluded). */
  depth: Int32Array;
  /** Whether each character sits inside a string literal. */
  inString: Uint8Array;
};

function indexParens(text: string): ParenIndex {
  const matchOf = new Map<number, number>();
  const depth = new Int32Array(text.length);
  const inString = new Uint8Array(text.length);
  const stack: number[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    depth[i] = stack.length;
    if (ch === "'") {
      quoted = !quoted;
      inString[i] = 1;
      continue;
    }
    inString[i] = quoted ? 1 : 0;
    if (quoted) continue;
    if (ch === "(") stack.push(i);
    else if (ch === ")") {
      const open = stack.pop();
      if (open !== undefined) matchOf.set(open, i);
    }
  }
  return { matchOf, depth, inString };
}

/** The innermost `(` before `pos` whose `)` is after `pos`, or -1. */
function enclosingOpen(index: ParenIndex, pos: number): number {
  let best = -1;
  for (const [open, close] of index.matchOf) {
    if (open < pos && close > pos && open > best) best = open;
  }
  return best;
}

/** [start, end) of the statement containing `pos` — between depth-0 semicolons. */
function statementBounds(text: string, index: ParenIndex, pos: number): [number, number] {
  let start = 0;
  for (let i = pos; i >= 0; i--) {
    if (text[i] === ";" && index.depth[i] === 0 && index.inString[i] === 0) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === ";" && index.depth[i] === 0 && index.inString[i] === 0) {
      end = i;
      break;
    }
  }
  return [start, end];
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9_]/.test(ch);
}

/** Depth-0 (relative to the scope) `or` token positions, and whether a depth-0 FROM exists. */
function scopeShape(
  text: string,
  index: ParenIndex,
  start: number,
  end: number,
): { orAt: number[]; hasFrom: boolean } {
  const base = index.depth[start] ?? 0;
  const orAt: number[] = [];
  let hasFrom = false;
  for (let i = start; i < end; i++) {
    if (index.depth[i] !== base || index.inString[i] === 1) continue;
    if (isWordChar(text[i - 1])) continue;
    if (text.startsWith("or", i) && !isWordChar(text[i + 2])) orAt.push(i);
    else if (text.startsWith("from", i) && !isWordChar(text[i + 4])) hasFrom = true;
  }
  return { orAt, hasFrom };
}

/** The OR-alternative of [start, end) that contains `pos`. */
function alternativeContaining(
  orAt: number[],
  start: number,
  end: number,
  pos: number,
): [number, number] {
  let s = start;
  let e = end;
  for (const at of orAt) {
    if (at < pos) s = at + 2;
    else {
      e = at;
      break;
    }
  }
  return [s, e];
}

/**
 * Every platform-admin test in `text`, with the AND-group it must satisfy.
 * `text` is raw SQL — source or catalog rendering — comments included.
 */
export function findPlatformAdminPredicates(text: string, source: string): AdminPredicate[] {
  const sql = normalize(stripSqlComments(text));
  const index = indexParens(sql);
  const found: AdminPredicate[] = [];
  const re = adminRoleTest();

  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    const pos = m.index;
    const roleAlias = m[1] ?? null;
    const role = (m[2] ?? m[3] ?? m[4]) as "admin" | "govt";

    const kept: string[] = [];
    let child: [number, number] | null = null;
    let open = enclosingOpen(index, pos);
    let query: [number, number] | null = null;
    // Climb until the query that owns the test (depth-0 FROM) or the statement.
    for (;;) {
      const atStatement = open === -1;
      const [s, e] = atStatement
        ? statementBounds(sql, index, pos)
        : [open + 1, index.matchOf.get(open) as number];
      const shape = scopeShape(sql, index, s, e);
      const [as, ae] = alternativeContaining(shape.orAt, s, e, pos);
      kept.push(
        child === null
          ? sql.slice(as, ae)
          : `${sql.slice(as, Math.max(as, child[0]))} ${sql.slice(Math.min(ae, child[1]), ae)}`,
      );
      if (shape.hasFrom || atStatement) {
        query = [s, e];
        break;
      }
      child = [open, (index.matchOf.get(open) as number) + 1];
      open = enclosingOpen(index, open);
    }

    const profiles = PROFILES_IN_FROM.exec(sql.slice(query[0], query[1]));
    if (profiles === null) continue; // the query does not read profiles — an org role, or unrelated
    const profilesAlias = profiles[1] ?? null;
    if (roleAlias !== null && roleAlias !== (profilesAlias ?? "profiles")) continue; // another table's role

    const conjunct = kept.join(" ");
    const prefix =
      profilesAlias === null
        ? "(?:\\bprofiles\\.|(?<![a-z0-9_.]))"
        : `(?:\\b(?:${profilesAlias}|profiles)\\.|(?<![a-z0-9_.]))`;
    const marker = (column: string) =>
      new RegExp(`${prefix}${column}\\s+is\\s+null`).test(conjunct);
    found.push({
      source,
      role,
      alias: profilesAlias,
      conjunct,
      hasDeletedAt: marker("deleted_at"),
      hasDeactivatedAt: marker("deactivated_at"),
    });
  }
  return found;
}

export function evaluatePlatformAdminPredicates(predicates: AdminPredicate[]): {
  violations: AdminPredicate[];
} {
  return {
    violations: predicates.filter((p) => !p.hasDeletedAt || !p.hasDeactivatedAt),
  };
}

/** The static half: every platform-admin test declared in db/*.sql. */
export function scanSourceSqlForAdminPredicates(cwd = process.cwd()): AdminPredicate[] {
  const files = globSync(ADMIN_PREDICATE_SQL_GLOB, { cwd }).sort();
  return files.flatMap((file) =>
    findPlatformAdminPredicates(readFileSync(`${cwd}/${file}`, "utf8"), file.replaceAll("\\", "/")),
  );
}

export type AuthorityTextRow = { source: string; text: string };

/** Every policy predicate PostgREST can reach, labelled. */
export const AUTHORITY_POLICY_TEXT_SQL = `
  SELECT format('policy %s.%s "%s"', schemaname, tablename, policyname) AS source,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') AS text
  FROM pg_policies
  WHERE schemaname IN ('public', 'storage')
  ORDER BY schemaname, tablename, policyname
`;

/** Every repo-owned SQL/plpgsql function body — the schemas migrations write to. */
export const AUTHORITY_FUNCTION_TEXT_SQL = `
  SELECT format('function %s.%s', n.nspname, p.proname) AS source,
         pg_get_functiondef(p.oid) AS text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE p.prokind = 'f'
    AND l.lanname IN ('sql', 'plpgsql')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND n.nspname NOT IN (
      'information_schema', 'auth', 'storage', 'extensions', 'graphql', 'graphql_public',
      'realtime', 'supabase_functions', 'supabase_migrations', 'vault', 'net', 'pgsodium',
      'pgsodium_masks', 'pgbouncer', 'cron'
    )
  ORDER BY n.nspname, p.proname
`;

/** The live half: policy predicates + function bodies, ready for the scanner. */
export async function fetchAuthorityTexts(client: postgres.Sql): Promise<AuthorityTextRow[]> {
  const policies = await client.unsafe<AuthorityTextRow[]>(AUTHORITY_POLICY_TEXT_SQL);
  const functions = await client.unsafe<AuthorityTextRow[]>(AUTHORITY_FUNCTION_TEXT_SQL);
  return [...policies, ...functions];
}

export function scanAuthorityTexts(rows: AuthorityTextRow[]): AdminPredicate[] {
  return rows.flatMap((row) => findPlatformAdminPredicates(row.text, row.source));
}

function describeAdminViolation(v: AdminPredicate): string {
  const missing = [
    v.hasDeletedAt ? null : "deleted_at is null",
    v.hasDeactivatedAt ? null : "deactivated_at is null",
  ]
    .filter((x): x is string => x !== null)
    .join(" and ");
  return `✗ ${v.source} — tests role = '${v.role}' on profiles${v.alias ? ` (alias ${v.alias})` : ""} without ${missing} in the same AND-group. An erased (art. 16) or deactivated profile is neither a platform administrator nor a govt operator — add the marker(s) to that branch (see migrations 0215 and 0216). Group seen: ${v.conjunct.slice(0, 160)}…`;
}

type Violation = {
  table_name: string;
  kind: "rls_disabled" | "no_policies";
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SKIPPED_CHECKS =
  "  NOT run: RLS-enabled, policy-count and policy-roles coverage over every public table, storage.objects bucket-read scoping, and the LIVE half of the platform-admin predicate check (the static half over db/*.sql still ran).";

/**
 * The static half of check 5 runs BEFORE the database is consulted and fails
 * on its own: it reads db/*.sql, so a DB-less box still judges the source.
 * Returns true when clean.
 */
function runStaticAdminPredicateCheck(): boolean {
  const predicates = scanSourceSqlForAdminPredicates();
  const { violations } = evaluatePlatformAdminPredicates(predicates);
  for (const v of violations) console.error(describeAdminViolation(v));
  if (predicates.length < MIN_ADMIN_PREDICATES_IN_SOURCE) {
    console.error(
      `✗ platform-admin predicate scan found only ${predicates.length} test(s) across ${ADMIN_PREDICATE_SQL_GLOB} (floor ${MIN_ADMIN_PREDICATES_IN_SOURCE}). An empty inventory reads exactly like a clean one — the scanner or the glob is broken, not the SQL.`,
    );
    return false;
  }
  if (violations.length > 0) return false;
  console.log(
    `✓ Platform-authority predicates (source) — ${predicates.length} role = 'admin' / 'govt' tests on profiles across ${ADMIN_PREDICATE_SQL_GLOB}, every one carries deleted_at + deactivated_at.`,
  );
  return true;
}

/**
 * Read RLS state and policy roles for every public table, or return null when
 * the run was skipped — remote host without the opt-in, or an unreachable
 * database. A null has ALREADY reported itself; the caller just stops.
 */
async function fetchCoverage(
  rawUrl: string,
  target: DbTarget,
): Promise<{
  tables: TableRlsRow[];
  policies: PolicyRoleRow[];
  storagePolicies: StoragePolicyRow[];
  authorityTexts: AuthorityTextRow[];
} | null> {
  const sql = postgres(rawUrl, { max: 1, connect_timeout: 5 });
  try {
    return {
      tables: await fetchRlsCoverage(sql),
      policies: await fetchPolicyRoles(sql),
      storagePolicies: await fetchStoragePolicies(sql),
      authorityTexts: await fetchAuthorityTexts(sql),
    };
  } catch (err) {
    // A DB-less box is not a failure — but it is not a pass either, and it has
    // to say which checks did not run. Same contract as lint:scope-authz and
    // lint:spine, so `pnpm verify` behaves one way, not three.
    reportDbSkip({
      fence: "check-rls-coverage",
      reason: `could not reach the database (${err instanceof Error ? err.message : String(err)}).`,
      target,
      skipped: SKIPPED_CHECKS,
      remedy: lines(
        "  Start the local stack with pnpm db:start, or set DATABASE_URL to a reachable database.",
        "  A DB-less CI box is not a failure — but this run proved nothing about RLS.",
      ),
    });
    return null;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** Split the tables into violations and intentional, allowlisted deny-alls. */
export function evaluateCoverage(rows: TableRlsRow[]): {
  violations: Violation[];
  allowlisted: string[];
} {
  const violations: Violation[] = [];
  const allowlisted: string[] = [];

  for (const row of rows) {
    if (SCHEMA_IGNORE_LIST.has(row.table_name)) continue;

    if (!row.rls_enabled) {
      violations.push({ table_name: row.table_name, kind: "rls_disabled" });
      continue;
    }

    if (Number.parseInt(row.policy_count, 10) !== 0) continue;

    if (Object.prototype.hasOwnProperty.call(DENY_ALL_ALLOWLIST, row.table_name)) {
      allowlisted.push(row.table_name);
    } else {
      violations.push({ table_name: row.table_name, kind: "no_policies" });
    }
  }

  return { violations, allowlisted };
}

export async function runCheck(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");

  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const usingDefault = process.env.DATABASE_URL === undefined;
  const target = describeTarget(rawUrl);

  const staticAdminClean = runStaticAdminPredicateCheck();

  // A staging pooler in DATABASE_URL is the readiness doc's §B4 trap. This
  // fence used to walk straight into it and print a wall of violations about a
  // database nobody meant to audit.
  const remoteSkip = remoteSkipReason(target, allowRemote);
  if (remoteSkip !== null) {
    reportDbSkip({
      fence: "check-rls-coverage",
      reason: remoteSkip,
      target,
      skipped: SKIPPED_CHECKS,
      remedy: remoteRemedy("SELECTs pg_class / pg_policies"),
    });
    if (!staticAdminClean) process.exit(1);
    return;
  }

  const fetched = await fetchCoverage(rawUrl, target);
  if (fetched === null) {
    if (!staticAdminClean) process.exit(1);
    return;
  }
  const rows = fetched.tables;

  // The database being judged is named on EVERY exit path, pass or fail.
  const origin = usingDefault ? "default local URL" : "DATABASE_URL";
  const remoteNote = target.isLocal ? "" : " [REMOTE — --allow-remote]";
  const dbLine = `  Database: ${target.label} (from ${origin})${remoteNote}`;

  const totalTables = rows.length;
  const { violations, allowlisted } = evaluateCoverage(rows);
  const roleCheck = evaluatePolicyRoles(fetched.policies);
  const storageCheck = evaluateStorageReadPolicies(fetched.storagePolicies);
  const livePredicates = scanAuthorityTexts(fetched.authorityTexts);
  const adminCheck = evaluatePlatformAdminPredicates(livePredicates);
  const adminScanVacuous = livePredicates.length < MIN_ADMIN_PREDICATES_IN_CATALOG;

  if (
    !staticAdminClean ||
    violations.length > 0 ||
    roleCheck.violations.length > 0 ||
    storageCheck.violations.length > 0 ||
    adminCheck.violations.length > 0 ||
    adminScanVacuous
  ) {
    for (const v of violations) {
      if (v.kind === "rls_disabled") {
        console.error(
          `✗ ${v.table_name} — RLS is DISABLED. Call ALTER TABLE public.${v.table_name} ENABLE ROW LEVEL SECURITY; in a migration, then add at least one policy (or add to DENY_ALL_ALLOWLIST with a documented reason if deny-all is intentional).`,
        );
      } else {
        console.error(
          `✗ ${v.table_name} — RLS is enabled but has ZERO policies. Add at least one policy to this table, or add it to DENY_ALL_ALLOWLIST in scripts/check-rls-coverage.ts with a one-line reason if deny-all is intentional (e.g. service-role-only access).`,
        );
      }
    }
    for (const v of roleCheck.violations) {
      console.error(
        `✗ ${v.table_name} — policy "${v.policy_name}" (${v.cmd}) has NO TO clause, so it applies to PUBLIC: every role, including anon (the key that ships in the client bundle). Name the roles in a forward-only migration — ALTER POLICY "${v.policy_name}" ON public.${v.table_name} TO authenticated; — or, with a reviewed reason, add "${v.table_name}:${v.policy_name}" to PUBLIC_ROLE_ALLOWLIST in scripts/check-rls-coverage.ts. A predicate that happens to reject anon today is not a role set.`,
      );
    }
    for (const v of storageCheck.violations) {
      console.error(
        `✗ storage.objects — policy "${v.policy_name}" (${v.cmd}, TO ${v.roles}) grants READ with a predicate that never names the caller: ${v.qual}. That is TRUE for every object in the bucket, and POST /storage/v1/object/list/{bucket} is filtered by this policy — so any account with that role can ENUMERATE and download the whole bucket. "Discovery is gated by the SSR layer" is not true of the Storage REST API. Fix: drop the policy in a forward-only migration and sign reads as service role behind a caller that has already authorized (see lib/infra/storage.ts, migrations 0164 and 0172) — or, with a reviewed reason, add "${v.policy_name}" to STORAGE_READ_POLICY_ALLOWLIST in scripts/check-rls-coverage.ts.`,
      );
    }
    for (const v of adminCheck.violations) console.error(describeAdminViolation(v));
    if (adminScanVacuous) {
      console.error(
        `✗ platform-admin predicate scan found only ${livePredicates.length} test(s) in the live catalog (floor ${MIN_ADMIN_PREDICATES_IN_CATALOG}). An empty inventory reads exactly like a clean one — the scanner or the catalog query is broken.`,
      );
    }
    console.error(
      lines(
        "",
        `✗ RLS coverage check FAILED — ${violations.length} table violation(s), ` +
          `${roleCheck.violations.length} PUBLIC-role policy violation(s), ` +
          `${storageCheck.violations.length} storage-bucket read violation(s) and ` +
          `${adminCheck.violations.length} platform-admin predicate violation(s) (live${staticAdminClean ? "" : "; the static db/*.sql scan failed too, see above"}) across ${totalTables} tables, ` +
          `${fetched.policies.length} public policies and ${fetched.storagePolicies.length} storage.objects policies. ` +
          `Allowlisted deny-all tables (excluded): ${allowlisted.length}.`,
        dbLine,
      ),
    );
    process.exit(1);
  }

  console.log(
    `✓ RLS coverage clean — ${totalTables} tables checked; ` +
      `${totalTables - allowlisted.length} have policies; ` +
      `${allowlisted.length} are intentional deny-all (allowlisted): ${allowlisted.join(", ")}.`,
  );
  console.log(
    `✓ Policy roles explicit — ${fetched.policies.length} policies checked, none default to PUBLIC` +
      `${roleCheck.allowlisted.length > 0 ? ` (${roleCheck.allowlisted.length} allowlisted: ${roleCheck.allowlisted.join(", ")})` : ""}.`,
  );
  const storageAllowNote =
    storageCheck.allowlisted.length > 0
      ? ` (${storageCheck.allowlisted.length} allowlisted: ${storageCheck.allowlisted.join(", ")})`
      : "";
  console.log(
    `✓ Storage bucket reads scoped — ${fetched.storagePolicies.length} storage.objects policies checked, no caller-role READ grant without auth.uid()${storageAllowNote}.`,
  );
  console.log(
    `✓ Platform-authority predicates (live) — ${livePredicates.length} role = 'admin' / 'govt' tests on profiles across ${fetched.authorityTexts.length} policy predicates + function bodies, every one carries deleted_at + deactivated_at.`,
  );
  console.log(dbLine);
}

// Guard: only run when invoked directly (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-rls-coverage.ts") ||
    process.argv[1].endsWith("check-rls-coverage.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runCheck(process.argv.slice(2)).catch((err) => {
    console.error("✗ check-rls-coverage: unexpected error:", err);
    process.exit(1);
  });
}
