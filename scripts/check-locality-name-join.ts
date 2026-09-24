// Locality name-join fence (L4·3 of the locality plan, T3-J1).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// PO decision 2026-09-08: a display name is never a join key or an
// authorization key. Postgres breaks that rule on its own, below every
// TypeScript read gate: RLS policies and a SECURITY DEFINER function decide who
// sees a row by comparing `govt_assignments.jurisdiction_locality` with the
// row's `jurisdiction_locality` AS STRINGS. No `resolveJurisdictionScope`, no
// `jurisdictionPairClause` reaches them, so any promise that "one fold cannot
// contradict itself" is false while they exist. The live inventory, what each
// one guards and how it fails is docs/architecture/locality-name-match-inventory.md.
//
// This fence does not fix them — that is L4·2, gated on a product decision about
// what an authority unit IS. It stops the count from GROWING while that decision
// is pending: a new migration (or an edit to a db/*.sql source) that joins two
// locality NAMES fails here, before any database has it.
//
// WHAT COUNTS
//   - `<alias>.jurisdiction_locality = <alias>.jurisdiction_locality` (or
//     `IS NOT DISTINCT FROM`), both sides qualified: the shape of a name used
//     as a join/authorization key between two tables. SQL comments are stripped
//     first, so prose that QUOTES the predicate is not a hit.
//   - NOT `SET jurisdiction_locality = …` (a write: the erasure sweeps, the
//     0117/0237 canonicalizations) and NOT `jurisdiction_locality = NULL`.
//   - Scanned: db/migrations/*.sql and the db/*.sql sources.
//
// This enumerates a FORM, and a form is narrower than the concept (a name
// compared inside `IN (SELECT …)`, or through a helper, would pass). The
// SUBJECT is pinned against the live catalog by
// __tests__/locality-name-match-live-inventory.test.ts, which fails when any
// policy, function or view that touches the column appears or disappears.
//
// Run:  pnpm tsx scripts/check-locality-name-join.ts   (or: pnpm lint:locality-name-join)
// Exits 1 on a hit outside the frozen list, on a count that no longer matches
// (the list is exact), or when the scan finds fewer hits than the floor.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file that joins locality names today, with its exact number of hits,
 * measured 2026-09-22. Migrations are immutable, so these cannot be fixed in
 * place; the LIVE state they add up to is five policies and `can_read_case`
 * (see the inventory doc). Never add an entry to make a new file pass: a new
 * predicate keys on an id, or waits for L4·2.
 */
export const FROZEN_NAME_JOINS: Readonly<Record<string, number>> = {
  "db/cases_rls.sql": 1, // can_read_case (source file, superseded by 0241)
  "db/rls.sql": 1, // approval_requests policy (source file, superseded by 0241)
  "db/migrations/0025_custody_disputes.sql": 2,
  "db/migrations/0034_cases_rls_expanded.sql": 1,
  "db/migrations/0086_track_rls_in_migrations.sql": 1,
  "db/migrations/0137_rls_initplan_auth_subselect.sql": 3,
  "db/migrations/0140_rls_scope_govt_pii_reads.sql": 2,
  "db/migrations/0215_platform_admin_requires_not_erased.sql": 5,
  "db/migrations/0216_govt_operator_requires_not_erased.sql": 6,
  // 0241 re-defines the SAME six predicates (whole-province branch, T3-J1b):
  // no new name comparison, the live set is unchanged. The 7th hit is the
  // expected can_read_case text inside its post-condition DO block (a LIKE
  // pattern asserting the predicate, not a join).
  "db/migrations/0241_govt_whole_province_rls.sql": 7,
};

/** Non-vacuity floor: the sum of the frozen list. A broken regex reads 0. */
export const MIN_HITS = Object.values(FROZEN_NAME_JOINS).reduce((a, b) => a + b, 0);

const NAME_JOIN =
  /\b[a-z_][a-z0-9_]*\.jurisdiction_locality\s*(?:=|is\s+not\s+distinct\s+from)\s*\(?\s*[a-z_][a-z0-9_]*\.jurisdiction_locality\b/gi;

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

export function countNameJoins(sql: string): number {
  return (stripSqlComments(sql).match(NAME_JOIN) ?? []).length;
}

export type SqlFile = { file: string; sql: string };

export function evaluate(files: readonly SqlFile[]): {
  violations: Array<{ file: string; hits: number; frozen: number }>;
  total: number;
} {
  const violations: Array<{ file: string; hits: number; frozen: number }> = [];
  let total = 0;
  const seen = new Set<string>();
  for (const { file, sql } of files) {
    const hits = countNameJoins(sql);
    total += hits;
    seen.add(file);
    const frozen = FROZEN_NAME_JOINS[file] ?? 0;
    if (hits !== frozen) violations.push({ file, hits, frozen });
  }
  // A frozen file that vanished is a stale entry: the list is exact.
  for (const [file, frozen] of Object.entries(FROZEN_NAME_JOINS)) {
    if (!seen.has(file)) violations.push({ file, hits: 0, frozen });
  }
  return { violations, total };
}

export function readSqlSources(root = "."): SqlFile[] {
  const read = (dir: string) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: `${dir}/${f}`, sql: readFileSync(join(root, dir, f), "utf8") }));
  return [...read("db"), ...read("db/migrations")];
}

function main(): void {
  const files = readSqlSources();
  const { violations, total } = evaluate(files);

  if (total < MIN_HITS) {
    console.error(
      `\n✗ only ${total} locality name-join(s) seen across ${files.length} SQL files (floor ${MIN_HITS}). The scanner is broken, not the SQL.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("\n✗ locality NAME used as a join/authorization key outside the frozen list:");
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.hits} hit(s), frozen at ${v.frozen}`);
    }
    console.error(
      "\n  A display name is never a join or authorization key (PO 2026-09-08). Key the predicate on an id, or leave the decision to L4·2 — see docs/architecture/locality-name-match-inventory.md. A frozen count that dropped means a predicate was fixed: lower the entry.",
    );
    process.exit(1);
  }
  console.log(
    `✓ locality name-join fence clean — ${files.length} SQL files, ${total} frozen historical hit(s) in ${Object.keys(FROZEN_NAME_JOINS).length} file(s), none new.`,
  );
}

if (process.argv[1]?.includes("check-locality-name-join")) {
  main();
}
