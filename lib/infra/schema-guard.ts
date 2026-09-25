// Columns this code WRITES that a recent migration added — and a check that the
// database it runs against has them.
//
// WHY (R9 of the 2026-09-25 localities audit). Migrations are applied to remote
// environments by hand, after review, and code deploys on push. The two can
// arrive in either order. Migration 0246 added `govt_assignments.locality_id`
// and the C2b writers insert into it: an environment on this code WITHOUT 0246
// fails every govt account creation and every grant, and the first person to
// learn it is the one whose account could not be created. `localidades-por-id`
// adds more columns in its stage B, each with the same trap.
//
// `/api/health` runs `findMissingRequiredColumns` and answers 503 when any is
// missing, so the external poller (.github/workflows/staging-health.yml) emails
// the moment code is ahead of its schema — before a person hits it.
//
// ADD A ROW when a migration adds a column that code starts writing, in the
// same commit as the writer. `__tests__/db-required-columns.test.ts` checks the
// list against the local database.

import { sql } from "drizzle-orm";

export type RequiredColumn = {
  table: string;
  column: string;
  /** The migration that added it — where to look when it is missing. */
  migration: string;
};

export const REQUIRED_COLUMNS: readonly RequiredColumn[] = [
  { table: "pets", column: "locality_id", migration: "0147" },
  { table: "welfare_reports", column: "locality_id", migration: "0147" },
  { table: "cases", column: "locality_id", migration: "0147" },
  { table: "govt_assignments", column: "locality_id", migration: "0246" },
];

/**
 * The required columns absent from `present`, as `table.column`, in list order.
 * Pure: `present` is whatever `information_schema.columns` answered.
 */
export function missingRequiredColumns(
  present: ReadonlyArray<{ table: string; column: string }>,
): string[] {
  const have = new Set(present.map((c) => `${c.table}.${c.column}`));
  return REQUIRED_COLUMNS.map((c) => `${c.table}.${c.column}`).filter((key) => !have.has(key));
}

/** The minimal executor this check needs — `db` or a transaction. */
type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Ask the database which required columns it lacks. Reads only
 * `information_schema.columns` for the `public` schema; a table that does not
 * exist at all reports every required column on it as missing.
 */
export async function findMissingRequiredColumns(executor: SqlExecutor): Promise<string[]> {
  const tables = [...new Set(REQUIRED_COLUMNS.map((c) => c.table))];
  const rows = (await executor.execute(sql`
    select table_name as "table", column_name as "column"
      from information_schema.columns
     where table_schema = 'public'
       and table_name in (${sql.join(
         tables.map((t) => sql`${t}`),
         sql`, `,
       )})
  `)) as Array<{ table: string; column: string }>;
  return missingRequiredColumns(rows);
}
