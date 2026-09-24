// Storage WRITE-policy tripwire — B24.
//
// WHY THIS EXISTS, AND WHY IT IS NOT check-rls-coverage
// ---------------------------------------------------------------------------
// `scripts/check-rls-coverage.ts` inspects `storage.objects` policies against a
// live database and refuses any policy that admits a caller role but cannot name
// the caller. It considers only SELECT and ALL, deliberately, and says so:
//
//     // Only read paths enumerate. INSERT is a write grant and cannot list;
//     // UPDATE/DELETE carry their own USING clause but do not expose content.
//
// That was a real decision and its reasoning is sound as far as it goes. What it
// leaves open is a blind spot with a name: `db/storage.sql` grants INSERT on
// `pet-photos` and on `event-attachments` to EVERY authenticated account, with
// `bucket_id = '<name>'` as the entire predicate. Any signed-up account can
// write objects into either bucket, at any path, as many as it likes. Uploads
// are supposed to be gated by the server action that verifies pet ownership —
// but the grant does not know that, and nothing stops a client from calling the
// storage API directly with its own token.
//
// The point of THIS file is narrower than fixing that, and the difference
// matters: closing those two grants needs every upload site to stop running as
// the signed-in user (~30 of them do), which is a later work unit. What must not
// happen in the meantime is the pattern SPREADING, silently, because the fence
// that would have noticed reads only SELECT. So the two known grants are frozen
// — named, with their exact predicates pinned — and anything NEW of the same
// shape, or any widening of these two, fails.
//
// PROGRESS, 2026-08-28, stated so the frozen entries are not read as stalled:
// the primitive those entries wait on now exists. `uploads-staging` (migration
// 0206) is a bucket with NO caller-facing policy at all — writes reach it only
// through a service-role-minted signed upload URL, which does not consult RLS —
// and `lib/infra/pet-photo-upload.ts` validates what lands there before any of
// it becomes a photo. That is the "server mints a scoped URL, bucket goes
// deny-all to callers" end state, demonstrated on one destination.
//
// A BUCKET WITH NO POLICY IS INVISIBLE TO THIS FENCE, which only reports
// policies that exist. So `uploads-staging` contributes nothing to any count
// here and this scan cannot notice if a caller-facing grant is added to it
// later — it would notice a bucket-name-only one (the `unfrozen` rule catches
// that on ANY bucket) but not one carrying `auth.uid()`. Migration 0206 carries
// its own replay-time DO-block assertion for the rest, and says out loud that
// it is the weaker half.
//
// This is a tripwire, not an absolution. A frozen allowlist entry is a debt with
// a ticket on it, not a policy that is fine.
//
// WHAT IT CHECKS
//   1. Every `create policy` AND every `alter policy` … `on storage.objects` in
//      `db/**/*.sql` is parsed: name, command, roles, and the full text of its
//      `using` / `with check` predicates.
//   2. WRITE commands only (insert / update / delete / all). SELECT is
//      check-rls-coverage's job and stays there.
//   3. Policies granted to a CALLER role (`authenticated`, `anon`, `public`, or
//      no `to` clause at all, which is PUBLIC by SQL default). A grant to
//      `service_role` alone is not a caller-facing grant.
//   4. A policy is PERMISSIVE when its predicate never mentions `auth.uid()` —
//      i.e. it cannot name who is asking, so `bucket_id = 'x'` is the whole of
//      it and it is true for every caller and every object.
//   5. A permissive write policy must appear in FROZEN_WRITE_GRANTS by name AND
//      its predicate must match the pinned text exactly. A new name fails. A
//      changed predicate fails — widening and narrowing alike, because both are
//      decisions that belong in this file rather than in a diff nobody reads.
//   6. Every FROZEN_WRITE_GRANTS entry must still be FOUND. An allowlist that
//      names a policy the scan cannot see is either a lie (the grant was closed
//      and nobody said so) or a broken parser, and both must be loud.
//   7. Non-vacuity: fewer than MIN_WRITE_POLICIES write policies discovered is a
//      FAILURE. A glob or a regex that stops matching produces an empty
//      inventory, an empty inventory produces no offenders, and no offenders
//      reads exactly like a clean run.
//
// WHY STATIC AND NOT AGAINST THE DATABASE
// ---------------------------------------------------------------------------
// It reads SQL text, so it runs in CI's offline `check` job with no Postgres —
// and, more importantly, it guards the SOURCE. `check-rls-coverage` can only see
// an environment that has been bootstrapped; a permissive grant added to
// `db/storage.sql` in a pull request is caught here, before any environment has
// it. The two are complements: this one guards what the repo DECLARES, that one
// guards what a database actually HAS.
//
// THE THIRD EVASION: `ALTER POLICY` (fixed 2026-08-25)
// ---------------------------------------------------------------------------
// Two legal SQL forms already had to be taught to this parser (an unquoted name,
// an omitted `FOR` clause — see parsePolicy). This is the third, and it is the
// worst of the three, because it is not a spelling: it is a whole STATEMENT the
// scan never entered. The scan's only entry point was `/create\s+policy/`, so
//
//     ALTER POLICY "pet_photos_authenticated_upload" ON storage.objects
//       WITH CHECK (bucket_id = 'pet-photos' OR bucket_id = 'anything-else');
//
// widened a FROZEN grant and the tripwire printed green over it. And the idiom
// is not hypothetical here: 80 `ALTER POLICY` statements live in `db/`, almost
// all of them in migrations 0137 and 0168 — it is the repo's normal way of
// changing a predicate, precisely
// because `ALTER POLICY` only replaces the USING / WITH CHECK expression (and
// optionally the `TO` roles) and so is the smallest safe edit.
//
// It is now a FIRST-CLASS statement, not a special case. Two consequences worth
// stating because they are deliberately conservative:
//
//   · `ALTER POLICY` cannot change a policy's COMMAND (Postgres does not allow
//     it), so an ALTER never carries a `FOR` clause. This scan reads an absent
//     command as `all` — the widest — which for an ALTER means every one of them
//     is treated as a WRITE policy. That over-reports rather than under-reports,
//     which is the only acceptable direction here.
//   · An `ALTER` with no `TO` clause leaves the roles unchanged, which this scan
//     cannot know because it does not model replay. It reads absent roles as
//     PUBLIC, again the widest reading. A narrowing ALTER (one that ADDS
//     auth.uid()) is not permissive and passes; a widening one fails, which is
//     the whole point.
//
// KNOWN LIMIT, NAMED RATHER THAN PARSED: dynamic SQL. A policy created or
// altered inside `EXECUTE format(…)` — or any `DO $$ … $$` block that builds the
// statement out of variables — is not read by this scan and cannot be, because
// the statement does not exist until runtime. There is none in `db/` today
// (measured 2026-08-25: zero `EXECUTE format` touching storage.objects). If one
// is ever needed, the honest fix is to write the policy literally and keep the
// dynamic part out of the grant, not to teach a regex to interpolate.
//
// A NOTE ON MIGRATIONS, WHICH ARE IMMUTABLE
// ---------------------------------------------------------------------------
// A `create policy` inside `db/migrations/NNNN_*.sql` stays in history forever,
// even after a later migration drops it. Today no migration creates a permissive
// write policy (the storage lockdowns — 0123, 0164, 0172, 0176 — only DROP), so
// this scan does not model drop/create replay and does not need to. If a
// historical migration ever has to be exempted, give it a FROZEN_WRITE_GRANTS
// entry whose reason says which migration retired it. Modelling replay would
// mean this fence's verdict depended on file ordering, and a fence whose answer
// depends on how you sort the inputs is not one to trust.
//
// Run: pnpm tsx scripts/check-storage-write-policies.ts  (or: pnpm lint:storage-policies)
// Exits 0 when clean; exits 1 naming each offender.

import { globSync, readFileSync } from "node:fs";
import postgres from "postgres";
import {
  DEFAULT_LOCAL_URL,
  type DbTarget,
  describeTarget,
  lines,
  remoteRemedy,
  remoteSkipReason,
  reportSkip,
} from "./_db-target";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Everywhere the repo can declare a storage policy. */
export const SQL_GLOBS = ["db/*.sql", "db/migrations/*.sql"];

/** Commands that WRITE. `all` is included because it contains all four. */
const WRITE_COMMANDS = new Set(["insert", "update", "delete", "all"]);

/** Roles that reach the client bundle or any logged-in account. */
const CALLER_ROLES = new Set(["anon", "authenticated", "public"]);

/**
 * Non-vacuity floor. Measured 2026-08-25: 11 caller-facing write policies
 * across db/*.sql and db/migrations/*.sql. Set below the measurement so a
 * policy can be added or retired without a false alarm, and far above zero
 * because zero is what a broken scan looks like.
 */
export const MIN_WRITE_POLICIES = 8;

/**
 * Non-vacuity floor for the ALTER path specifically, and it needs its own number
 * for a reason MIN_WRITE_POLICIES cannot cover.
 *
 * Today there is NO `alter policy … on storage.objects` in the repo — the 80
 * ALTER POLICY statements in `db/` (almost all in migrations 0137 and 0168) all
 * target `public.*` tables and are correctly skipped. So the ALTER branch
 * contributes ZERO to every other count in this file, and a regression that
 * silently stopped matching `alter policy` would move nothing: the fence would
 * keep printing the same green line it prints today, with the third evasion
 * reopened.
 *
 * This floor is measured BEFORE the storage.objects filter, over every policy
 * statement of either kind the scan can see. Measured 2026-08-25: 80 alter, 158
 * create. It is the only check that fails when the ALTER regex dies.
 */
export const MIN_ALTER_STATEMENTS = 50;

export type FrozenGrant = {
  /** The predicate, normalized: lower-cased, whitespace collapsed. */
  readonly predicate: string;
  /** Why it is still here, and what closes it. */
  readonly reason: string;
};

/**
 * THE FROZEN SET — the bucket-name-only write grants that exist TODAY.
 *
 * Two entries. Neither is acceptable; both are load-bearing until signed uploads
 * land, and pinning them exactly is what makes the third one impossible to add
 * by accident.
 */
export const FROZEN_WRITE_GRANTS: Record<string, FrozenGrant> = {
  pet_photos_authenticated_upload: {
    predicate: "bucket_id = 'pet-photos'",
    reason:
      "B24 — every authenticated account may write any object into pet-photos. Uploads are supposed to be gated by the server action that verifies pet ownership; the GRANT does not know that, and a client can call the storage API directly with its own token. CLOSED BY: moving the ~30 Server-Action upload sites onto the signed upload primitive, after which this grant goes away and so does this entry. THE PRIMITIVE NOW EXISTS (2026-08-28): lib/infra/pet-photo-upload.ts mints a scoped URL into the deny-all `uploads-staging` bucket (migration 0206) and validates the bytes in a second, re-authorized step. What has not happened is the migration of the callers — that is the work this entry is still waiting on, and it is bigger than the primitive was.",
  },
  event_attachments_authenticated_upload: {
    predicate: "bucket_id = 'event-attachments'",
    reason:
      "B24 — same shape, Tier-3 data. db/storage.sql argues INSERT is safe here because 'an insert-only policy cannot enumerate', which is true and is not the whole question: it can still WRITE, into any path of a bucket holding vaccine cards and vet receipts. The read side was already closed (migration 0172 removed event_attachments_authenticated_read). CLOSED BY: the same caller migration as pet-photos, onto the same signed upload primitive, plus one thing pet-photos did not need — an event attachment's confirm step has to know which event it is claiming for, so the primitive grows a parent argument before this bucket can use it.",
  },
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `create policy …` or `alter policy …`. Both are in subject. */
export type PolicyStatementKind = "create" | "alter";

export type StoragePolicy = {
  file: string;
  name: string;
  kind: PolicyStatementKind;
  command: string;
  roles: string[];
  /** Every `using` / `with check` predicate, normalized and joined. */
  predicate: string;
};

/** Drop `--` line comments without touching string literals. */
export function stripSqlComments(sql: string): string {
  const out: string[] = [];
  for (const line of sql.split("\n")) {
    let inString = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'") {
        inString = !inString;
        continue;
      }
      if (!inString && ch === "-" && line[i + 1] === "-") {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join("\n");
}

/** Lower-case and collapse runs of whitespace — the comparison form. */
export function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export type PolicyStatement = { kind: PolicyStatementKind; text: string };

/**
 * The full text of every `create policy` AND `alter policy` statement,
 * terminated by the `;` that closes it at paren-depth zero and outside any
 * string literal.
 *
 * Statement-aware rather than line-aware because these policies are written
 * across many lines and one of them (`revocations_admin_govt_upload`) carries a
 * nested `EXISTS (SELECT …)` with its own parentheses and its own semicolon-free
 * body. A line regex would have taken the first `)` it found.
 *
 * IT WAS `createPolicyStatements` UNTIL 2026-08-25, and the rename is the fix
 * rather than a tidy-up: the old name was an accurate description of a scan that
 * could not see a widening written as an ALTER — the repo's own normal idiom for
 * changing a predicate. See the header.
 */
export function policyStatements(sql: string): PolicyStatement[] {
  const statements: PolicyStatement[] = [];
  const re = /\b(create|alter)\s+policy\b/gi;
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    const kind = m[1].toLowerCase() as PolicyStatementKind;
    let depth = 0;
    let inString = false;
    let end = sql.length;
    for (let i = m.index; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "'") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    statements.push({ kind, text: sql.slice(m.index, end) });
  }
  return statements;
}

/** Every parenthesised group at depth 1, in order — the predicates. */
function predicateGroups(statement: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    if (ch === "'") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push(statement.slice(start, i));
        start = -1;
      }
    }
  }
  return groups;
}

/**
 * A `create policy … on storage.objects` this parser could not read.
 *
 * It exists because "could not parse" and "not a storage policy" used to be the
 * same answer — `null` — and `inventory` skipped both. See parsePolicy.
 */
export type UnparseablePolicy = { file: string; statement: string };

/** Distinguishes the three outcomes a `create policy` statement can have. */
export type ParseResult =
  | { kind: "policy"; policy: StoragePolicy }
  /** Not on storage.objects — genuinely none of this fence's business. */
  | { kind: "skip" }
  /** On storage.objects and unreadable. An OFFENDER, never a skip. */
  | { kind: "unparseable" };

/**
 * One `create policy` statement → a StoragePolicy, a skip, or an offender.
 *
 * A statement with no `to` clause is PUBLIC by SQL default, and is reported as
 * such rather than skipped: failing closed is the only safe direction here.
 *
 * ===========================================================================
 * THIS PARSER FAILED OPEN ON TWO LEGAL SQL FORMS (fixed 2026-08-25)
 * ===========================================================================
 * The header above promises "failing closed is the only safe direction". It was
 * not true of the parser itself. Both of these are valid Postgres, both appear
 * in this repo's own SQL, and both made `parsePolicy` return null — after which
 * `inventory` silently dropped the statement and the fence printed green:
 *
 *   1. AN UNQUOTED POLICY NAME. `create policy cases_select_visible on …` is the
 *      style used by db/cases_rls.sql:142 and by two migrations. The old regex
 *      was `create\s+policy\s+"([^"]+)"` — double quotes REQUIRED. A permissive
 *      write grant written in the repo's own prevailing style was invisible to
 *      the tripwire meant to catch it.
 *
 *   2. AN OMITTED `FOR` CLAUSE. Postgres defaults to `FOR ALL`, which is the
 *      WIDEST grant there is — SELECT, INSERT, UPDATE and DELETE at once. The
 *      old code required a `for` match and skipped the statement without one,
 *      so the single most dangerous form was the one form guaranteed to pass.
 *
 * Both are now read: names may be quoted or bare, and an absent command means
 * `all`, exactly as the SQL does.
 *
 * And the residue is handled the way the header always claimed: a statement that
 * says `on storage.objects` and that this parser still cannot read is returned
 * as `unparseable` and reported as an OFFENDER. A parser that cannot see a
 * policy is not evidence that the policy is safe. That is the general fix; the
 * two regexes above are the specific ones, and only the general fix survives the
 * next SQL form nobody anticipated.
 */
export function parsePolicy(file: string, statement: PolicyStatement): ParseResult {
  const text = statement.text;

  // WHITESPACE AROUND THE DOT. `storage . objects` and `storage.objects` are the
  // same identifier to Postgres and were two different answers to this fence
  // until 2026-08-25 — one statement in subject, the other silently skipped as
  // "not a storage policy". Nobody writes it with spaces on purpose, which is
  // exactly why it would work: an evasion nobody would suspect costs one
  // keystroke. Same reasoning as the unquoted-name and omitted-FOR fixes above —
  // a parser that fails open on a legal spelling is not a parser, it is a
  // suggestion.
  if (!/\bon\s+storage\s*\.\s*objects\b/i.test(text)) return { kind: "skip" };

  // Quoted ("my policy", which may contain spaces) or bare (my_policy), after
  // either verb. `IF NOT EXISTS` is CREATE-only; ALTER has no such clause.
  const name =
    text.match(/(?:create|alter)\s+policy\s+"([^"]+)"/i)?.[1] ??
    text.match(/(?:create|alter)\s+policy\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_$]*)/i)?.[1];
  if (!name) return { kind: "unparseable" };

  // ABSENT MEANS `all`, per the SQL default — not "skip this statement". On an
  // ALTER the clause is absent ALWAYS (Postgres does not let ALTER POLICY change
  // the command), so every ALTER is read as the widest. Over-reporting, on
  // purpose: see the header.
  const command =
    text.match(/\bfor\s+(insert|update|delete|select|all)\b/i)?.[1]?.toLowerCase() ?? "all";

  const rolesRaw = text.match(/\bto\s+([a-z_,\s]+?)\s*(?:\busing\b|\bwith\s+check\b|$)/i)?.[1];
  const roles = rolesRaw
    ? rolesRaw
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter((r) => r !== "")
    : ["public"];

  return {
    kind: "policy",
    policy: {
      file,
      name,
      kind: statement.kind,
      command,
      roles,
      predicate: normalize(predicateGroups(text).join(" and ")),
    },
  };
}

/**
 * Every storage.objects policy the repo declares, plus the ones it could not
 * read.
 *
 * The second half is the point: an unreadable `create policy … on
 * storage.objects` is carried out of here instead of being dropped on the floor,
 * so `runCheck` can fail on it. See parsePolicy for the two legal forms that
 * used to be dropped silently.
 */
export function inventory(files: readonly string[]): {
  policies: StoragePolicy[];
  unparseable: UnparseablePolicy[];
  /**
   * Every policy statement SEEN, of either kind, before the storage.objects
   * filter. It exists so MIN_ALTER_STATEMENTS has something to count: the ALTER
   * branch contributes zero to every other number in this file today, so a dead
   * ALTER regex would be invisible to all of them.
   */
  statementCounts: Record<PolicyStatementKind, number>;
} {
  const policies: StoragePolicy[] = [];
  const unparseable: UnparseablePolicy[] = [];
  const statementCounts: Record<PolicyStatementKind, number> = { create: 0, alter: 0 };
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(file, "utf8"));
    const normalizedFile = file.replaceAll("\\", "/");
    for (const statement of policyStatements(sql)) {
      statementCounts[statement.kind]++;
      const result = parsePolicy(normalizedFile, statement);
      if (result.kind === "policy") policies.push(result.policy);
      else if (result.kind === "unparseable") {
        unparseable.push({ file: normalizedFile, statement: normalize(statement.text) });
      }
    }
  }
  return { policies, unparseable, statementCounts };
}

/** Write policies granted to a role a client can actually hold. */
export function callerFacingWrites(policies: readonly StoragePolicy[]): StoragePolicy[] {
  return policies.filter(
    (p) => WRITE_COMMANDS.has(p.command) && p.roles.some((r) => CALLER_ROLES.has(r)),
  );
}

/**
 * A policy that cannot name who is asking.
 *
 * `auth.uid()` is the only way a storage policy can identify the caller, bare or
 * inside a subquery (`(select auth.uid())`, the 0137 convention). Without it the
 * predicate is a property of the OBJECT — its bucket, its path — and is true for
 * everybody who can reach the endpoint.
 */
export function isPermissive(policy: StoragePolicy): boolean {
  return !policy.predicate.includes("auth.uid()");
}

export type Verdict = {
  writes: StoragePolicy[];
  permissive: StoragePolicy[];
  /** New bucket-name-only write grants — the thing this fence exists to stop. */
  unfrozen: StoragePolicy[];
  /** Frozen grants whose predicate no longer matches the pinned text. */
  changed: Array<{ policy: StoragePolicy; expected: string }>;
  /** Allowlist entries the scan never saw. */
  missing: string[];
  /**
   * `create policy … on storage.objects` statements the parser could not read.
   * Offenders, not skips — a policy this fence cannot see is not a safe one.
   */
  unparseable: UnparseablePolicy[];
};

export function evaluate(
  policies: readonly StoragePolicy[],
  unparseable: readonly UnparseablePolicy[] = [],
): Verdict {
  const writes = callerFacingWrites(policies);
  const permissive = writes.filter(isPermissive);

  const unfrozen: StoragePolicy[] = [];
  const changed: Array<{ policy: StoragePolicy; expected: string }> = [];
  const seen = new Set<string>();

  for (const policy of permissive) {
    const frozen = FROZEN_WRITE_GRANTS[policy.name];
    if (!frozen) {
      unfrozen.push(policy);
      continue;
    }
    seen.add(policy.name);
    if (policy.predicate !== normalize(frozen.predicate)) {
      changed.push({ policy, expected: normalize(frozen.predicate) });
    }
  }

  const missing = Object.keys(FROZEN_WRITE_GRANTS).filter((name) => !seen.has(name));
  return { writes, permissive, unfrozen, changed, missing, unparseable: [...unparseable] };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function listSqlFiles(): string[] {
  const seen = new Set<string>();
  for (const pattern of SQL_GLOBS) {
    for (const file of globSync(pattern)) {
      const p = file.replaceAll("\\", "/");
      if (p.includes("node_modules/")) continue;
      seen.add(p);
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// THE LIVE HALF - what the CATALOG says, against what the tree declares
// ---------------------------------------------------------------------------
//
// WHY A SECOND HALF AT ALL, when the static one already reads every policy the
// repo can declare: because it reads every policy the repo CAN declare, and a
// policy does not have to come from the repo. `create policy` typed into the
// Supabase SQL editor against staging leaves no file behind. Every fence in
// this repo that reads `db/**/*.sql` is blind to it, by construction, forever.
//
// This repo has already been bitten by the same shape from the other side: a
// `drop policy` by name reports success and does nothing when the environment
// was patched by hand, so the migration "applied" and the hole stayed open.
// Inventory BEFORE, fence AFTER - and this is the fence after.
//
// It was also already NAMED as missing, in a workflow that runs every night:
// `dim-interno:.github/workflows/authz-audit-staging.yml` audits three sibling fences
// against staging and prints, in its own verdict, "storage policies : not run -
// check-storage-write-policies.ts has no --allow-remote". That line was a note
// to whoever came next. This is that work.
//
// WHAT THIS HALF DOES NOT DO, and the distinction is the whole design: it does
// NOT re-run the static rules against a second source. The static half already
// answers "is a new blanket grant being added to the tree" and answers it
// before a pull request merges, which is earlier and therefore better. This
// half answers a question the static one CANNOT ask no matter how good it gets:
// "is there a caller-facing write grant in that database that nobody wrote
// down?" A green here is not "the policies are good"; it is "the catalog and
// the tree agree about which policies exist".
//
// WHY IT SKIPS GREEN INSTEAD OF REFUSING RED. This fence is inside `pnpm
// verify`, which a developer runs with Docker stopped several times a day. The
// repo has two established contracts for "no database": the verify-chain fences
// skip and exit 0 (`_db-target.ts`'s `reportSkip`), and `db:doctor`, which is
// NOT in verify, refuses with exit 2. A fence in verify that refuses would
// teach everybody to stop running verify. The skip is loud, names the database
// it would have looked at, and says outright that the run proved nothing about
// the live catalog - which is the honest form of a check that did not happen.

/** One row of `pg_policies`, narrowed to storage.objects. */
export type LiveStoragePolicy = {
  readonly name: string;
  /** Lower-cased on read, to compare against the parser's own lower-case form. */
  readonly command: string;
  readonly roles: readonly string[];
  readonly qual: string | null;
  readonly withCheck: string | null;
  /**
   * False only for a RESTRICTIVE policy, which NARROWS rather than grants.
   *
   * Optional, and absent means permissive - the fail-CLOSED default, because a
   * row this fence assumes is permissive gets judged, while one it assumes is
   * restrictive gets waved through. Read from the catalog's `permissive`
   * column; today no `as restrictive` exists in db/**, so this only matters for
   * a future hardening, which without it would be reported as a blanket grant
   * and turn the nightly red on somebody CLOSING a hole.
   */
  readonly permissive?: boolean;
};

/**
 * `pg_policies` is the VIEW, not `pg_policy` the catalog table, so the columns
 * are the readable ones (`policyname`, `cmd`, `roles`, `qual`, `with_check`)
 * rather than `polcmd`/`polroles`. Both `qual` and `with_check` are selected:
 * an INSERT policy carries its predicate in `with_check` and has no `qual` at
 * all, so a scan that read only `qual` would see every upload grant in this
 * repo as having no predicate - i.e. would see the two known holes as
 * something far worse, and be wrong.
 */
export const STORAGE_POLICY_SQL = `
  select policyname::text  as name,
         cmd::text         as cmd,
         permissive::text  as permissive,
         roles::text[]     as roles,
         qual,
         with_check
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
  order by policyname
`;

/**
 * Strip one or more layers of balanced enclosing parentheses.
 *
 * Postgres does not hand back the text that was typed; it hands back its own
 * deparse of the parsed tree, which wraps predicates in parens the author never
 * wrote. Known limitation, stated rather than hidden: a string literal
 * containing an unbalanced parenthesis would confuse the depth count. No
 * storage predicate in this repo contains one, and a wrong answer here can only
 * produce a FALSE ALARM (a predicate that fails to match and is reported as
 * drift), never a false green.
 */
export function stripOuterParens(text: string): string {
  let out = text.trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")") {
        depth--;
        if (depth === 0 && i < out.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps || depth !== 0) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * The catalog's rendering of a predicate, reduced to the static side's
 * comparison form.
 *
 * WITHOUT THIS THE FENCE IS A PERMANENT RED, and a permanent red is worse than
 * no fence: `bucket_id = 'pet-photos'` in db/storage.sql comes back from
 * `pg_policies` as `(bucket_id = 'pet-photos'::text)`. Same predicate, three
 * differences - wrapping parens, an explicit cast, and sometimes quoted
 * identifiers. Comparing those two strings raw reports drift on a tree that is
 * correct, every single night, until somebody turns the fence off.
 *
 * Only the renderings Postgres actually produces are stripped. This is
 * deliberately NOT a SQL parser: a normaliser that tries to prove two arbitrary
 * predicates equivalent will eventually say yes to two that are not, and this
 * fence is the one that must not do that.
 */
export function normalizeCatalogPredicate(qual: string | null, withCheck: string | null): string {
  const parts = [qual, withCheck]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) =>
      stripOuterParens(
        p
          // `'pet-photos'::text`, `id::uuid` - the deparser's explicit casts.
          .replace(
            /::\s*(?:character varying|double precision|timestamp with time zone|timestamp without time zone|text|uuid|bytea|bigint|integer|smallint|numeric|boolean|jsonb|json|date)\b/gi,
            "",
          )
          // `"bucket_id"` - quoting the deparser adds and the author did not.
          .replace(/"([a-z_][a-z0-9_]*)"/gi, "$1"),
      ),
    );
  // Joined with " and " to match `parsePolicy`, which joins a statement's
  // `using` and `with check` groups the same way and in the same order.
  return normalize(parts.join(" and "));
}

export type LiveVerdict = {
  /**
   * A caller-facing write grant in the catalog that NO file in the tree
   * declares. The defect this whole half exists for: somebody typed `create
   * policy` into a SQL console and it left no file behind.
   */
  undeclared: LiveStoragePolicy[];
  /**
   * Live, caller-facing, writes, and CANNOT NAME WHO IS ASKING - the same
   * definition `isPermissive` applies to the source - and is not one of the two
   * frozen holes. A blanket write grant sitting in that database.
   */
  unfrozen: LiveStoragePolicy[];
  /**
   * Names the caller but NOT a bucket, so it reaches every bucket on the
   * instance. `using (auth.uid() is not null)` is the shape.
   */
  crossBucket: LiveStoragePolicy[];
  /** A frozen hole whose live predicate is not the pinned one. Widened in place. */
  changed: Array<{ live: LiveStoragePolicy; livePredicate: string; expected: string }>;
  /**
   * Declared in the tree, absent from the catalog. REPORTED, NOT FAILED - see
   * the note in `runCheck`.
   */
  absent: string[];
  /** Caller-facing write policies seen live. */
  liveWrites: LiveStoragePolicy[];
  /**
   * Live caller-facing writes that mention BOTH `auth.uid()` and `bucket_id`.
   * Counted, never compared - see the header on `liveWriteVerdict` for why, and
   * for what that leaves uncovered.
   */
  scoped: LiveStoragePolicy[];
  /** Every storage.objects policy of any command. The non-vacuity number. */
  seen: number;
};

/**
 * The catalog, judged by the SAME rule the static half applies to the source.
 *
 * THIS WAS DESIGNED TWICE AND THE FIRST DESIGN IS WORTH RECORDING, because it
 * is the obvious one and it does not work. The first version compared each live
 * predicate against the text the tree declares, by normalized string equality.
 * Run against the local catalog on 2026-09-17 it reported EIGHT drifted grants
 * on a tree that was correct, and zero real findings. Postgres does not hand
 * back what was typed; it hands back its own deparse of the parsed tree:
 *
 *     declared:  bucket_id = 'avatars' and auth.uid() = owner
 *     catalog:  (bucket_id = 'avatars') and (auth.uid() = owner)
 *
 *     declared:  p.role in ('admin', 'govt')
 *     catalog:   p.role = any (array['admin'::user_role, 'govt'::user_role])
 *
 * Seven of the eight were the first shape - parentheses around each conjunct.
 * The eighth needed IN-to-ANY, schema qualification, and a subselect alias
 * undone. Chasing them means writing a SQL equivalence prover, and a prover
 * that gets it wrong in the OTHER direction says two different predicates are
 * the same, which is the one mistake this fence may not make.
 *
 * The tell was in the result itself: the only two grants that did NOT report as
 * drift were the two frozen ones, whose predicate is a single term with no
 * `and` and therefore no inner parens. Textual comparison works for exactly the
 * trivial case and fails everywhere else.
 *
 * SO THE RULE HERE IS THE FENCE'S OWN THESIS, not a new one. `isPermissive`
 * already says that a policy which cannot say `auth.uid()` is a property of the
 * OBJECT and true for everybody. That test is a substring, immune to every
 * deparse difference above. A live grant that names the caller is counted and
 * left alone; a live grant that does not must be one of the two frozen holes,
 * with the pinned predicate - and those predicates are precisely the trivial
 * ones that normalize cleanly.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH, stated so nobody reads the green as
 * more than it is. A NON-FROZEN policy that keeps both `auth.uid()` and a
 * `bucket_id` and is widened some other way - `p.role in ('admin','govt')`
 * quietly becoming `p.role is not null` - passes here. Catching that needs the
 * prover this function refuses to be, and the honest place for it is a
 * migration's own assertion, next to the change, not a fence guessing after the
 * fact.
 *
 * The TWO FROZEN grants are not in that gap: their predicate is compared to its
 * pin on every run, whatever it contains. That is the fix for a false green
 * this file shipped in review and not in production - the first version checked
 * for `auth.uid()` before the frozen lookup, which made the comparison dead
 * code exactly where it mattered most.
 *
 * And one limit that is easy to misread as covered: `undeclared` is a NAME
 * test. `alter policy` never changes a name, and an ALTER is this repo's normal
 * idiom for changing a predicate - 80 of them live in `db/`. So the name check
 * can never see a widening; the predicate rules above are the only thing that
 * can, which is why their order is load-bearing.
 */
export function liveWriteVerdict(
  live: readonly LiveStoragePolicy[],
  declared: readonly StoragePolicy[],
): LiveVerdict {
  const liveWrites = live.filter(
    (p) =>
      WRITE_COMMANDS.has(p.command) &&
      p.roles.some((r) => CALLER_ROLES.has(r)) &&
      // A RESTRICTIVE policy cannot grant anything - it only narrows what a
      // permissive one already allows - so judging it by the rules below would
      // report somebody CLOSING a hole as opening one.
      p.permissive !== false,
  );

  // Names only. A name the tree never mentions is the hand-applied grant, and
  // no amount of deparse difference can disguise a name.
  //
  // AND A NAME IS ALL IT IS, which is worth saying out loud because it bounds
  // the check: `alter policy` never changes a name, and this repo's normal
  // idiom for changing a predicate IS an ALTER - 80 of them live in `db/`, and
  // the static half has a thirty-line section and a red control about exactly
  // that evasion. So `undeclared` cannot see a widening; the two loops below
  // are what has to.
  const declaredNames = new Set(declared.map((p) => p.name));
  const undeclared = liveWrites.filter((p) => !declaredNames.has(p.name));

  const unfrozen: LiveStoragePolicy[] = [];
  const crossBucket: LiveStoragePolicy[] = [];
  const changed: LiveVerdict["changed"] = [];
  const scoped: LiveStoragePolicy[] = [];

  for (const policy of liveWrites) {
    const predicate = normalizeCatalogPredicate(policy.qual, policy.withCheck);

    // THE FROZEN LOOKUP COMES FIRST, AND THE ORDER IS THE WHOLE POINT.
    //
    // The first version of this loop checked for `auth.uid()` before checking
    // the frozen set, which made the comparison below DEAD CODE for any
    // predicate containing that substring - including the two grants this
    // entire file exists to pin. One ALTER reopened it:
    //
    //     alter policy "event_attachments_authenticated_upload" on storage.objects
    //       with check (bucket_id = 'event-attachments' or auth.uid() is not null);
    //
    // That widens an INSERT grant from one bucket to EVERY bucket - revocations,
    // welfare evidence, the export buckets - and the old order filed it under
    // "names the caller, leave it alone" and printed a checkmark. Caught in
    // adversarial review before this shipped, not in production.
    //
    // The asymmetry that made it worse: the STATIC half fails closed on the
    // same edit. A frozen grant that gains `auth.uid()` drops out of
    // `permissive`, never reaches `seen`, and fires `verdict.missing`. The live
    // half had no counterpart and failed OPEN, silently, on the harder-to-see
    // side of the same rule.
    //
    // It costs nothing in false alarms: the file's own argument is that the two
    // pinned predicates are the trivial ones that normalize cleanly, and the
    // measurement backs it - they were the ONLY two grants the abandoned
    // text-comparison design did not report as drift.
    const frozen = FROZEN_WRITE_GRANTS[policy.name];
    if (frozen !== undefined) {
      const expected = normalize(frozen.predicate);
      if (predicate !== expected) {
        changed.push({ live: policy, livePredicate: predicate, expected });
      }
      continue;
    }

    // Not frozen, so it has to clear BOTH bars.
    //
    // `auth.uid()` says it can name WHO is asking. `bucket_id` says it can name
    // WHERE - and without that a grant reaches every bucket on the instance
    // whatever else its predicate says. All ten caller-facing write grants this
    // tree declares name their bucket (db/storage.sql, db/revocations_storage.sql,
    // db/migrations/0171), so requiring it costs nothing today and closes the
    // sibling of the hole above: `using (auth.uid() is not null)` names the
    // caller and authorises every object in the instance.
    const namesCaller = predicate.includes("auth.uid()");
    const namesBucket = predicate.includes("bucket_id");
    if (namesCaller && namesBucket) {
      scoped.push(policy);
    } else if (namesCaller) {
      crossBucket.push(policy);
    } else {
      unfrozen.push(policy);
    }
  }

  const liveNames = new Set(live.map((p) => p.name));
  const absent = [
    ...new Set(
      callerFacingWrites(declared)
        .map((d) => d.name)
        .filter((name) => !liveNames.has(name)),
    ),
  ].sort();

  return {
    undeclared,
    unfrozen,
    crossBucket,
    changed,
    absent,
    liveWrites,
    scoped,
    seen: live.length,
  };
}

/** Read the catalog. Returns null when the database could not be reached. */
/**
 * A connection failure in a form an operator can act on.
 *
 * Exported so the offline test can pin the empty-message case: a skip message
 * that says nothing is a skip nobody investigates.
 */
export function describeConnectionError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const parts = [typeof code === "string" ? code : "", err.message].filter((p) => p !== "");
  return parts.length > 0 ? parts.join(": ") : err.name;
}

type RawPolicyRow = {
  name: string;
  cmd: string;
  permissive: string | null;
  roles: string[] | null;
  qual: string | null;
  with_check: string | null;
};

async function fetchLivePolicies(
  rawUrl: string,
  target: DbTarget,
  allowRemote: boolean,
): Promise<LiveStoragePolicy[] | null> {
  const sql = postgres(rawUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  let rows: RawPolicyRow[];
  // ONLY THE QUERY IS INSIDE THE TRY, and the narrowing is deliberate. When the
  // row mapping was in here too, a renamed pg_policies column or a null `cmd`
  // came out as "could not reach the database" and exited 0 - a defect wearing
  // an outage's clothes, on the one fence whose job is to notice. Mapping now
  // throws past this and reaches the CLI handler, which exits 1.
  try {
    rows = (await sql.unsafe(STORAGE_POLICY_SQL)) as unknown as RawPolicyRow[];
  } catch (err) {
    // AN EXPLICIT --allow-remote MAKES THIS RED, and that is the whole
    // difference between the two callers. A developer with Docker stopped never
    // passes the flag: they get the skip, verify stays green, nobody is taught
    // to ignore it. The nightly staging job DOES pass it - it was told to audit
    // that database - so a run that connected to nothing is a failed audit, not
    // a pass. Without this the workflow's verdict prints "all four authz fences
    // agree with the live database" over a connection that never happened.
    if (allowRemote) {
      console.error(
        lines(
          "",
          "\u2717 check-storage-write-policies: --allow-remote was passed and the database could not be read.",
          `  Database looked at: ${target.label}`,
          `  ${describeConnectionError(err)}`,
          "  This run was told to audit that catalog and did not. Reporting it as a pass would",
          "  claim an audit that never happened.",
        ),
      );
      await sql.end({ timeout: 1 }).catch(() => {});
      process.exit(1);
    }
    reportSkip({
      fence: "check-storage-write-policies",
      // `code` BEFORE `message`, and it is not a preference: postgres.js raises
      // a connection failure with an EMPTY message and the reason in `code`, so
      // reading `message` first prints "could not reach the database ()" and
      // tells an operator nothing about whether the stack is down, the port is
      // wrong, or the password is stale. Measured 2026-09-17 against a closed
      // port: message "", code "ECONNREFUSED".
      reason: `could not reach the database (${describeConnectionError(err)}).`,
      target,
      skipped:
        "  The STATIC half ran and its verdict above stands. What did NOT run: the comparison\n  against the live catalog, so this run says nothing about whether that database carries a\n  write grant nobody wrote down.",
      remedy: lines(
        "  Start the local stack with pnpm db:start, or set DATABASE_URL to a reachable database.",
        "  A DB-less CI box is not a failure - but this run proved nothing about the live catalog.",
      ),
    });
    await sql.end({ timeout: 1 }).catch(() => {});
    return null;
  }
  await sql.end({ timeout: 1 }).catch(() => {});

  return rows.map((r) => ({
    name: r.name,
    command: r.cmd.toLowerCase(),
    // Absent or unrecognised reads as PERMISSIVE - see the field's doc.
    permissive: (r.permissive ?? "").toUpperCase() !== "RESTRICTIVE",
    roles: (r.roles ?? []).map((role) => role.toLowerCase()),
    qual: r.qual,
    withCheck: r.with_check,
  }));
}

export async function runCheck(argv: string[] = []): Promise<void> {
  const files = listSqlFiles();
  const { policies, unparseable, statementCounts } = inventory(files);
  const verdict = evaluate(policies, unparseable);

  // Rule 7b — the ALTER path is alive. Checked first because it is the only
  // failure that leaves every other number in this file unchanged.
  if (statementCounts.alter < MIN_ALTER_STATEMENTS) {
    console.error(
      [
        "",
        `✗ check-storage-write-policies: saw only ${statementCounts.alter} \`alter policy\` statement(s) (floor ${MIN_ALTER_STATEMENTS}).`,
        `  Scanned ${files.length} file(s) matching ${SQL_GLOBS.join(", ")}.`,
        "  No `alter policy` targets storage.objects today, so this branch adds",
        "  nothing to any other count here — which means a regex that stopped",
        "  matching it would leave this fence printing the same green line while",
        "  a widening written as an ALTER walked straight through. See",
        "  MIN_ALTER_STATEMENTS.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  // Rule 7 — non-vacuity, checked BEFORE any verdict is reported.
  if (verdict.writes.length < MIN_WRITE_POLICIES) {
    console.error(
      [
        "",
        `✗ check-storage-write-policies: found only ${verdict.writes.length} caller-facing storage WRITE policy/policies (floor ${MIN_WRITE_POLICIES}).`,
        `  Scanned ${files.length} file(s) matching ${SQL_GLOBS.join(", ")}.`,
        "  That is not a pass. An empty inventory produces no offenders, and no",
        "  offenders reads exactly like a clean run — see MIN_WRITE_POLICIES.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const problems: string[] = [];

  // FIRST, because it is the failure that invalidates every other answer below:
  // if a statement could not be read, the inventory is incomplete and "no
  // offenders" means nothing.
  for (const { file, statement } of verdict.unparseable) {
    problems.push(
      [
        `  UNREADABLE storage.objects policy  (${file})`,
        `      ${statement.slice(0, 200)}${statement.length > 200 ? " …" : ""}`,
        "      This statement creates a policy on storage.objects and this fence could not",
        "      parse its name. It is reported as an offender rather than skipped: a policy",
        "      the tripwire cannot see is not a policy the tripwire has cleared. Until",
        "      2026-08-25 two LEGAL forms — an unquoted policy name, and an omitted FOR",
        "      clause (which Postgres reads as FOR ALL, the widest grant) — landed here and",
        "      were dropped silently, so the fence printed green over them.",
        "      Fix the statement, or teach parsePolicy the form it uses.",
      ].join("\n"),
    );
  }

  for (const policy of verdict.unfrozen) {
    problems.push(
      [
        `  NEW bucket-name-only write grant (${policy.kind} policy): "${policy.name}"  (${policy.file})`,
        `      for ${policy.command} to ${policy.roles.join(", ")}`,
        `      predicate: ${policy.predicate || "(none)"}`,
        "      It grants a write to every caller holding that role, for every object in the",
        "      bucket, because the predicate never names who is asking (no auth.uid()).",
        "      Scope it with auth.uid(), or move the write behind a signed URL minted by",
        "      the server. If it genuinely must be permissive, that is a decision that gets",
        "      written into FROZEN_WRITE_GRANTS with a reason and a ticket — not merged.",
      ].join("\n"),
    );
  }

  for (const { policy, expected } of verdict.changed) {
    problems.push(
      [
        `  FROZEN grant changed by an ${policy.kind.toUpperCase()} POLICY: "${policy.name}"  (${policy.file})`,
        `      pinned:  ${expected}`,
        `      found:   ${policy.predicate || "(none)"}`,
        "      These two grants are frozen exactly, not approximately. If this is the B24",
        "      fix, remove the entry from FROZEN_WRITE_GRANTS in the same commit; if it is",
        "      a widening, it is the thing this fence exists to stop.",
        "      An ALTER POLICY replaces the USING / WITH CHECK expression in place, which is",
        "      this repo's normal idiom (80 of them live in db/) and was invisible to this",
        "      scan until 2026-08-25.",
      ].join("\n"),
    );
  }

  for (const name of verdict.missing) {
    problems.push(
      [
        `  FROZEN grant not found: "${name}"`,
        "      The allowlist names a policy the scan cannot see. Either the grant was closed",
        "      and the entry was left behind (delete it — that is good news worth recording),",
        "      or the parser stopped seeing it, which means this fence is measuring nothing.",
      ].join("\n"),
    );
  }

  if (problems.length > 0) {
    console.error("");
    console.error("✗ storage write-policy tripwire FAILED");
    console.error("");
    console.error(problems.join("\n\n"));
    console.error("");
    process.exit(1);
  }

  console.log(
    `✓ storage write-policy tripwire — ${verdict.writes.length} caller-facing write policy/policies across ${files.length} SQL file(s) (${statementCounts.create} create + ${statementCounts.alter} alter policy statements read); ${verdict.permissive.length} bucket-name-only, all frozen and unchanged (${Object.keys(FROZEN_WRITE_GRANTS).join(", ")}).`,
  );

  // --- the live half -------------------------------------------------------
  // Runs AFTER the static verdict, never instead of it. The static half is the
  // one that blocks a pull request; nothing about a database should be able to
  // stop it from reporting.
  const allowRemote = argv.includes("--allow-remote");
  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const target = describeTarget(rawUrl);

  const remoteSkip = remoteSkipReason(target, allowRemote);
  if (remoteSkip !== null) {
    reportSkip({
      fence: "check-storage-write-policies",
      reason: remoteSkip,
      target,
      skipped:
        "  The STATIC half ran and its verdict above stands. What did NOT run: the comparison\n  against the live catalog.",
      remedy: remoteRemedy("reads pg_policies for storage.objects"),
    });
    return;
  }

  const live = await fetchLivePolicies(rawUrl, target, allowRemote);
  if (live === null) return;

  const liveVerdict = liveWriteVerdict(live, policies);
  const liveProblems: string[] = [];

  // NON-VACUITY, and it is not decoration. Every other number below is a
  // comparison against this list; an empty list makes all of them agree
  // perfectly and print a checkmark. storage.objects has policies in every
  // environment this fence is pointed at, so zero means the query is wrong or
  // the stack is not seeded - either way the run judged nothing.
  if (liveVerdict.seen === 0) {
    console.error(
      lines(
        "",
        "\u2717 check-storage-write-policies: the catalog reports ZERO policies on storage.objects.",
        `  Database looked at: ${target.label}`,
        "  Every comparison below would pass against an empty list, so this is not a green:",
        "  either the stack is not seeded (pnpm db:bootstrap) or STORAGE_POLICY_SQL no longer",
        "  matches this Postgres version's pg_policies view.",
      ),
    );
    process.exit(1);
  }

  for (const policy of liveVerdict.undeclared) {
    liveProblems.push(
      lines(
        `UNDECLARED caller-facing write grant live on storage.objects: "${policy.name}"`,
        `  command: ${policy.command}   roles: ${policy.roles.join(", ")}`,
        `  predicate: ${normalizeCatalogPredicate(policy.qual, policy.withCheck) || "(none - true for everybody)"}`,
        "  No file under db/*.sql or db/migrations/*.sql declares a policy by this name.",
        "  A grant that exists in the database and in no migration was applied by hand. It will",
        "  survive every rebuild of this tree and be invisible to every review of it.",
      ),
    );
  }

  for (const policy of liveVerdict.unfrozen) {
    liveProblems.push(
      lines(
        `BLANKET write grant live on storage.objects: "${policy.name}"`,
        `  command: ${policy.command}   roles: ${policy.roles.join(", ")}`,
        `  predicate: ${normalizeCatalogPredicate(policy.qual, policy.withCheck) || "(none - true for everybody)"}`,
        "  It cannot name who is asking, so it is true for every caller and every object in",
        "  that bucket, and it is not one of the two grants this fence freezes.",
      ),
    );
  }

  for (const policy of liveVerdict.crossBucket) {
    liveProblems.push(
      lines(
        `CROSS-BUCKET write grant live on storage.objects: "${policy.name}"`,
        `  command: ${policy.command}   roles: ${policy.roles.join(", ")}`,
        `  predicate: ${normalizeCatalogPredicate(policy.qual, policy.withCheck)}`,
        "  It names who is asking but never names a bucket, so it authorises writes into EVERY",
        "  bucket on the instance - revocations, welfare evidence, the export buckets.",
      ),
    );
  }

  for (const { live: policy, livePredicate, expected } of liveVerdict.changed) {
    liveProblems.push(
      lines(
        `FROZEN grant widened in the database: "${policy.name}"`,
        `  live:   ${livePredicate || "(none - true for everybody)"}`,
        `  pinned: ${expected}`,
        "  These two are the known holes and they are load-bearing. Growing one in place, in a",
        "  database, without a migration, is how a measured debt becomes an unmeasured one.",
      ),
    );
  }

  if (liveProblems.length > 0) {
    console.error(
      lines(
        "",
        "\u2717 storage write-policy tripwire FAILED against the live catalog",
        `  Database looked at: ${target.label}`,
        "",
        liveProblems.join("\n\n"),
        "",
        "  This is NOT a code defect. It means that database carries storage write grants the",
        "  migration chain does not account for. Fix it in the database, then write the migration",
        "  that makes the tree say so - in that order, because the hole is open right now.",
      ),
    );
    process.exit(1);
  }

  // `absent` is REPORTED AND NOT FAILED, deliberately, and the reason is worth
  // the three lines: this scan reads `create policy` and `alter policy` and does
  // NOT read `drop policy`. A policy created in an early migration and dropped
  // in a later one is therefore "declared" here and correctly missing from the
  // catalog. Failing on that would put this fence in the red on a healthy tree
  // every night, and a fence that cries wolf gets switched off. The count is
  // printed so a human reading the nightly summary still sees it.
  const absentNote =
    liveVerdict.absent.length > 0
      ? `; ${liveVerdict.absent.length} declared name(s) not in the catalog (${liveVerdict.absent.join(", ")}) - expected for any grant a later migration dropped, since this scan does not read \`drop policy\``
      : "";

  console.log(
    `\u2713 live catalog \u2014 ${liveVerdict.liveWrites.length} caller-facing write policy/policies on storage.objects out of ${liveVerdict.seen} total. ${liveVerdict.scoped.length} mention both auth.uid() and bucket_id (counted, NOT compared - see the header on liveWriteVerdict for what that does not prove); ${Object.keys(FROZEN_WRITE_GRANTS).length} are the frozen grants and match their pinned predicate exactly; every name is declared somewhere in this tree (${target.label})${absentNote}.`,
  );
}

// Only run when invoked as a CLI; importing from tests must not exit.
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-storage-write-policies.ts") ||
    process.argv[1].endsWith("check-storage-write-policies.js"));

if (isMain) {
  runCheck(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
