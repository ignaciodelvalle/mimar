// The custody-lock predicate fence (T4-D1, PO decision 2A of 2026-09-22).
//
// THE QUESTION THIS ASKS
// ---------------------------------------------------------------------------
// "This code is deciding whether a custody dispute is live. Did it ask the
// question about the DISPUTE, or about the literal string 'open'?"
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// `custody_disputes.status` has FOUR values and TWO of them mean the animal is
// locked: 'open' and 'escalated'. Escalation moves the matter to judicial
// channels; it is not an outcome and it does not release anything. A reader
// that spells the question `status = 'open'` is therefore not narrower than the
// rule — it is WRONG, and wrong in the direction that unlocks a contested
// animal: the pet becomes transferable, adoption finalize opens, a second
// dispute can be raised over it, and the file disappears from the authority's
// queue. Nothing goes red. There is no error to read.
//
// That state shipped, briefly and on purpose: migration 0235 made 'escalated'
// representable so the dispute row could follow its case, and wrote in its own
// header that every reader still keyed on 'open' and that moving them was a
// change of its own. This fence is the second half of that sentence — the part
// that keeps it from happening again in a file nobody has written yet.
//
// WHY THE SUBJECT IS THE COMPARISON, NOT THE FILE OR THE FEATURE
// ---------------------------------------------------------------------------
// The candidates were: (a) an allowlist of the files that read disputes;
// (b) every caller of the dispute repository; (c) every comparison against
// `custody_disputes.status`.
//
//   (a) is a list, and the whole failure mode here is the reader that is NOT
//       on the list. The eleven readers fixed in this change were found by
//       hand; the twelfth will be written next quarter by someone who greps
//       for `status, "open"` and copies what they find.
//   (b) is a naming convention. A dashboard that joins the table directly —
//       which is what `lib/analytics/dashboards/analytics.ts` and
//       `lib/analytics/owner-dashboard.ts` both do — touches no repository.
//   (c) is the act itself. You cannot decide whether a dispute is live without
//       comparing its status, and every such comparison is either right or is
//       this bug.
//
// So the rule is: a comparison against `custody_disputes.status` that names
// 'open' must also name 'escalated'. The honest way to satisfy it is not to
// add the literal — it is to call `disputeHoldsCustodyLock()` (SQL predicate)
// or `isInDisputeStatus()` (TS guard), both derived from IN_DISPUTE_STATUSES in
// db/schema.ts, which is the single place a future third in-dispute state has
// to land.
//
// WHAT IS DELIBERATELY NOT A VIOLATION
// ---------------------------------------------------------------------------
//   - `status === "escalated"` and `status === "resolved"` and friends. Asking
//     WHICH live state a dispute is in is a legitimate question (the /gob queue
//     renders an escalated row with its own badge). Only 'open' standing in for
//     the whole live set is the bug.
//   - Migrations numbered below this change. They are immutable history and
//     0025 / 0096 contain the old predicate by definition. The floor is
//     derived from this fence's own migration (0242), so a NEW migration that
//     reintroduces the bare predicate IS caught.
//   - Comments. This repo has been bitten by a fence that punished the comment
//     explaining why a symbol is not used; every source is stripped first.
//
// Run:  pnpm tsx scripts/check-dispute-lock-predicate.ts   (pnpm lint:dispute-lock)
// Exits 0 when every comparison names both states; 1 listing the ones that do not.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Source globs scanned for TypeScript comparisons.
 *
 * `db/**` JOINED THIS LIST AFTER A SECURITY REVIEW (2026-09-22), and its
 * absence was the fence's worst hole. The ORIGINAL bug lived in db/schema.ts,
 * spelled ``.where(sql`${table.status} = 'open'`)`` on the partial indexes —
 * and that file was read by this script for exactly one purpose: counting
 * predicate uses for the non-vacuity floor. Its violations were never
 * collected. A fence that cannot see the place the bug came from is a fence
 * about somewhere else.
 */
const TS_GLOBS = [
  "app/**/*.ts",
  "app/**/*.tsx",
  "db/**/*.ts",
  "lib/**/*.ts",
  "src/**/*.ts",
  "scripts/**/*.ts",
];

/** Path fragments excluded from every scan. */
const EXCLUDED_SEGMENTS = ["node_modules/", ".next/", ".claude/", "apps/", "e2e/"];

/**
 * Files that DEFINE the predicate rather than consult it. They are scanned for
 * violations like everything else; they just do not COUNT toward the
 * non-vacuity floor, because the floor is asking "does this fence still see
 * real call sites?" and a definition is not a call site. Before the review the
 * floor was met by db/schema.ts plus this script's own source alone — it would
 * have passed with every consumer deleted.
 */
const PREDICATE_DEFINITION_FILES = ["db/schema.ts", "scripts/check-dispute-lock-predicate.ts"];

/**
 * First migration that carries the widened predicate. Everything below it is
 * immutable history and is not scanned; this number is the fence's own
 * migration, so it moves only when the predicate itself does.
 */
const MIGRATION_FLOOR = 242;

/** The two states that mean "this dispute still holds the custody lock". */
const LOCK_STATES = ["open", "escalated"] as const;

/**
 * Minimum number of in-dispute predicate CALL SITES the scan must see, counted
 * over files that are not in PREDICATE_DEFINITION_FILES.
 *
 * THIS FLOOR USED TO BE A FLOOR AGAINST NOTHING. It was 6, and db/schema.ts
 * alone carries 7 occurrences of the names — so emptying TS_GLOBS entirely
 * still exited 0, which is precisely the vacuous pass the floor exists to
 * prevent. Counting only real consumers, and asserting separately that files
 * were actually scanned, is what makes it bite. Set a little below the real
 * count (measured ~20) so ordinary refactoring does not trip it: it is a floor
 * against vacuity, not a ratchet on the count.
 */
const MIN_PREDICATE_USES = 15;

export type Violation = {
  file: string;
  line: number;
  snippet: string;
  why: string;
};

// ---------------------------------------------------------------------------
// TypeScript rules
// ---------------------------------------------------------------------------

/**
 * A drizzle comparison helper applied to `custodyDisputes.status`, with its
 * argument list captured up to the closing paren. Covers eq / ne / inArray /
 * notInArray — the four spellings that can express the predicate in a query.
 */
const DRIZZLE_STATUS_RE =
  /\b(eq|ne|inArray|notInArray)\s*\(\s*custodyDisputes\.status\s*,([^;]*?)\)\s*[,)\]]/g;

/**
 * A plain JS/TS comparison of some dispute-ish value's `.status` against a
 * string literal. The receiver must END in "dispute" (case-insensitive) so this
 * does not collide with cases, welfare reports, organizations or pets, all of
 * which have their own `status` with their own value sets. The prefix is
 * OPTIONAL: the first draft of this regex required at least one character
 * before "dispute" and therefore missed the commonest spelling of all — the
 * bare local `dispute.status !== "open"` that resolve-dispute.ts and
 * withdraw-dispute.ts both used. That hole was found by MUTATING this fence,
 * not by reading it, which is the whole argument for mutating fences.
 *
 * KNOWN REACH: a destructured `const { status } = dispute` loses the receiver
 * and is not matched. That gap is named here rather than papered over — the
 * drizzle rule above covers every QUERY, which is where the lock is actually
 * enforced, and an in-memory guard alone cannot unlock a pet.
 */
const PLAIN_STATUS_RE = /\b([\w$]*[Dd]ispute)\s*\.\s*status\s*(===|!==|==|!=)\s*(["'])([a-z_]+)\3/g;

/**
 * RULE 3 — a drizzle `sql` template that predicates on status, inside the
 * custodyDisputes table definition.
 *
 * THIS IS THE SHAPE THE ORIGINAL BUG WAS WRITTEN IN, and neither rule above
 * sees it: there is no eq/ne/inArray call, and the receiver is `table`, not
 * something ending in "dispute". The two partial indexes that ARE the custody
 * lock in the database were spelled ``sql`${table.status} = 'open'` `` and
 * would have sailed through a fence that claimed to cover this rule.
 *
 * Scoped to the custodyDisputes BLOCK on purpose. db/schema.ts is full of
 * `${table.status} = 'open'` for other tables — `cases`, `welfare_reports` and
 * friends all have a status column with their own value set and their own
 * correct meaning of 'open'. Flagging those would make the fence wrong in a way
 * that gets it deleted. `custodyDisputeParties` does not match the block regex
 * (the token is `custodyDisputes`, with the s), and has no status column.
 */
const SQL_TEMPLATE_STATUS_RE = /sql`([^`]*\bstatus\b[^`]*)`/g;

/**
 * Regions of a TS source that belong to the custodyDisputes table definition:
 * from `custodyDisputes = pgTable(` to the next top-level `export`.
 */
export function custodyDisputesRegions(source: string): Array<{ start: number; text: string }> {
  const regions: Array<{ start: number; text: string }> = [];
  const startRe = /\bcustodyDisputes\s*=\s*pgTable\s*\(/g;
  for (const m of source.matchAll(startRe)) {
    const start = m.index ?? 0;
    const rest = source.slice(start);
    // The next top-level declaration ends the block. `\nexport ` is the repo's
    // own convention for every table in this file, so it is a reliable fence
    // post; falling back to end-of-file is safe (it over-scans, never under).
    const endRel = rest.search(/\nexport\s/);
    regions.push({ start, text: endRel === -1 ? rest : rest.slice(0, endRel) });
  }
  return regions;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function namesBothLockStates(fragment: string): boolean {
  return LOCK_STATES.every((s) => fragment.includes(`"${s}"`) || fragment.includes(`'${s}'`));
}

function namesOpen(fragment: string): boolean {
  return fragment.includes('"open"') || fragment.includes("'open'");
}

export function scanTypeScript(file: string, rawSource: string): Violation[] {
  const source = stripComments(rawSource);
  const out: Violation[] = [];

  for (const m of source.matchAll(DRIZZLE_STATUS_RE)) {
    const args = m[2] ?? "";
    if (!namesOpen(args) || namesBothLockStates(args)) continue;
    out.push({
      file,
      line: lineOf(source, m.index ?? 0),
      snippet: m[0].trim().replace(/\s+/g, " ").slice(0, 120),
      why: `\`${m[1]}(custodyDisputes.status, …'open'…)\` treats 'open' as the whole live set. An escalated dispute still holds the custody lock.`,
    });
  }

  for (const m of source.matchAll(PLAIN_STATUS_RE)) {
    if (m[4] !== "open") continue;
    out.push({
      file,
      line: lineOf(source, m.index ?? 0),
      snippet: m[0].trim().slice(0, 120),
      why: `\`${m[1]}.status ${m[2]} "open"\` asks about one live state, not about the lock. Use isInDisputeStatus().`,
    });
  }

  for (const region of custodyDisputesRegions(source)) {
    for (const m of region.text.matchAll(SQL_TEMPLATE_STATUS_RE)) {
      const body = m[1] ?? "";
      if (!body.includes("'open'")) continue;
      if (body.includes("'escalated'")) continue;
      // The honest spelling interpolates the shared list instead of literals.
      if (body.includes("IN_DISPUTE_STATUS_SQL_LIST")) continue;
      out.push({
        file,
        line: lineOf(source, region.start + (m.index ?? 0)),
        snippet: m[0].trim().replace(/\s+/g, " ").slice(0, 120),
        why: "a drizzle sql`` predicate on custody_disputes.status naming 'open' alone. This is the shape the partial indexes are written in — interpolate IN_DISPUTE_STATUS_SQL_LIST instead of the literal.",
      });
    }
  }

  return out;
}

/** Counts the honest spellings, for the non-vacuity floor. */
export function countPredicateUses(rawSource: string): number {
  const source = stripComments(rawSource);
  return [
    ...source.matchAll(/\b(disputeHoldsCustodyLock|isInDisputeStatus|IN_DISPUTE_STATUSES)\b/g),
  ].length;
}

// ---------------------------------------------------------------------------
// SQL rule
// ---------------------------------------------------------------------------

/**
 * `status = 'open'`, `status != 'open'`, `status <> 'open'`, `status in (…)`,
 * `status not in (…)`, with the literal list captured.
 *
 * THE NEGATED OPERATORS WERE MISSING until the security review. That is not a
 * pedantic gap: the /gob/disputas "closed" tab is the COMPLEMENT of the live
 * set, and the spelling it used to have was `ne(status, 'open')` — a predicate
 * that, left alone, files every escalated dispute under "closed" for the
 * authority reading the queue. A rule that only understands the positive form
 * is blind to exactly half of its own subject.
 */
const SQL_STATUS_RE = /\bstatus\s*(?:=|!=|<>|(?:not\s+)?in)\s*(\(?[^()]*?\)|'[a-z_]+')/gi;

/**
 * Strips `--` line comments. Block comments are not used in this repo's SQL and
 * a literal `--` inside a string would only ever UNDER-report, never invent a
 * violation.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Splits SQL into statements on `;`, EXCEPT inside a dollar-quoted body.
 *
 * A `do $$ … $$` block is one statement that contains semicolons. Splitting
 * naively shreds it, and the fragments lose the `custody_disputes` token that
 * the statement-scoping test keys on — so the whole body becomes invisible.
 * Migration 0242's pre-flight guard is exactly such a block, and it names the
 * table and the states. The fence must be able to read its own migration.
 *
 * Returns each statement with the offset it started at, so line numbers stay
 * true to the original text.
 */
export function splitSqlStatements(sql: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  const dollarTag = /\$([A-Za-z_]\w*)?\$/g;
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "$") {
      dollarTag.lastIndex = i;
      const open = dollarTag.exec(sql);
      if (open && open.index === i) {
        const close = sql.indexOf(open[0], i + open[0].length);
        i = close === -1 ? sql.length : close + open[0].length;
        continue;
      }
    }
    if (sql[i] === ";") {
      out.push({ start, text: sql.slice(start, i) });
      start = i + 1;
    }
    i += 1;
  }
  if (start < sql.length) out.push({ start, text: sql.slice(start) });
  return out;
}

export function scanSql(file: string, rawSql: string): Violation[] {
  const sql = stripSqlComments(rawSql);
  const out: Violation[] = [];

  // Statement-scoped: only a statement that actually names the table is our
  // business. `cases`, `appointments` and `welfare_reports` all carry a
  // `status = 'open'` of their own and mean something different by it.
  for (const { start: base, text: statement } of splitSqlStatements(sql)) {
    if (!statement.includes("custody_disputes")) continue;

    for (const m of statement.matchAll(SQL_STATUS_RE)) {
      const literals = m[1] ?? "";
      if (!literals.includes("'open'")) continue;
      if (literals.includes("'escalated'")) continue;
      out.push({
        file,
        line: lineOf(sql, base + (m.index ?? 0)),
        snippet: m[0].trim().replace(/\s+/g, " ").slice(0, 120),
        why: "a custody_disputes predicate on 'open' alone. The partial indexes and any RLS clause must cover ('open','escalated') — an escalated dispute keeps the lock.",
      });
    }
  }

  return out;
}

/** Migration files at or above the floor, plus the standing .sql sources. */
export function sqlFilesToScan(): string[] {
  const migrations = globSync("db/migrations/*.sql").filter((f) => {
    const n = Number.parseInt(f.replace(/\\/g, "/").split("/").pop()?.slice(0, 4) ?? "", 10);
    return Number.isFinite(n) && n >= MIGRATION_FLOOR;
  });
  const standing = globSync("db/*.sql");
  return [...migrations, ...standing].sort();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function included(file: string): boolean {
  const p = file.replaceAll("\\", "/");
  return !EXCLUDED_SEGMENTS.some((seg) => p.includes(seg));
}

export function runScan(): void {
  const tsFiles = [...new Set(TS_GLOBS.flatMap((g) => globSync(g)))].filter(included).sort();
  const sqlFiles = sqlFilesToScan().filter(included);

  const violations: Violation[] = [];
  let callSiteUses = 0;

  for (const file of tsFiles) {
    const posix = file.replaceAll("\\", "/");
    const src = readFileSync(file, "utf8");
    violations.push(...scanTypeScript(posix, src));
    // Only CONSUMERS count toward the floor. db/schema.ts is now scanned for
    // violations like every other file, but counting its definitions would put
    // the floor back where the review found it: satisfiable with zero callers.
    if (!PREDICATE_DEFINITION_FILES.includes(posix)) callSiteUses += countPredicateUses(src);
  }

  for (const file of sqlFiles) {
    violations.push(...scanSql(file.replaceAll("\\", "/"), readFileSync(file, "utf8")));
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: ${v.snippet}\n    → ${v.why}`);
    }
    console.error(
      `\n✗ ${violations.length} bare-'open' custody-dispute comparison(s). Route them through disputeHoldsCustodyLock() (SQL) or isInDisputeStatus() (TS), both derived from IN_DISPUTE_STATUSES in db/schema.ts. Do NOT satisfy this by pasting 'escalated' next to 'open' — the next state would miss it the same way.`,
    );
    process.exit(1);
  }

  // Two separate vacuity guards, because they fail for different reasons and a
  // combined one would let each hide the other.
  if (tsFiles.length === 0 || sqlFiles.length === 0) {
    console.error(
      `✗ the scan read ${tsFiles.length} TS file(s) and ${sqlFiles.length} SQL file(s). A fence that opened no files cannot have found anything — check TS_GLOBS, EXCLUDED_SEGMENTS and the working directory.`,
    );
    process.exit(1);
  }

  if (callSiteUses < MIN_PREDICATE_USES) {
    console.error(
      `✗ non-vacuity floor: saw ${callSiteUses} predicate CALL SITE(s) outside ${PREDICATE_DEFINITION_FILES.join(", ")}, expected at least ${MIN_PREDICATE_USES}. Either the readers stopped using the shared predicate, or the scan stopped seeing them — both mean this pass proves nothing.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ custody-lock predicate clean — ${tsFiles.length} TS file(s) + ${sqlFiles.length} SQL file(s) scanned; ` +
      `${callSiteUses} predicate call site(s) outside the definition files; no comparison treats 'open' as the whole in-dispute set.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-dispute-lock-predicate.ts") ||
    process.argv[1].endsWith("check-dispute-lock-predicate.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
