// Generic unique-token wrapper for short prefixed IDs (DIM, LBR, APR, INV, ...).
//
// Two helpers:
//
//   generateUniqueToken(table, column, generator) — pre-INSERT advisory
//     check that the generated value doesn't already exist. Retries up
//     to 5 times. Each retry calls `generator()` fresh. The DB unique
//     index remains the source of truth — callers should still trap
//     `isUniqueViolation(err)` from the INSERT and retry if they care
//     about the TOCTOU window between SELECT and INSERT.
//
//   isUniqueViolation(err) — narrows an unknown error to a Postgres
//     unique-constraint violation (SQLSTATE 23505). Use in a try/catch
//     around INSERTs that depend on a freshly-allocated token.
//
// The pre-check approach mirrors `generateUniqueCasePublicCode` in
// lib/case-helpers.ts. For new code, prefer using BOTH helpers
// together: pre-check to keep happy-path traffic cheap, isUniqueViolation
// to handle the race that pre-check leaves open.

import { eq } from "drizzle-orm";
import type { AnyPgTable, PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db } from "@/db";
// isUniqueViolation now lives in lib/db-errors.ts (single source of truth that
// walks drizzle 0.45's `.cause` chain). Re-exported here for back-compat with
// existing importers.
import { isUniqueViolation } from "@/lib/infra/db-errors";

export { isUniqueViolation };

const DEFAULT_MAX_RETRIES = 5;

type Executor = Pick<typeof db, "select">;

export interface UniqueTokenOptions {
  maxRetries?: number;
  /** Pass `tx` here when calling from inside `db.transaction(async (tx) => …)`. */
  executor?: Executor;
}

/**
 * Generate a token and verify it isn't already present in `(table, column)`.
 *
 * Returns the first candidate that passes the existence check. Throws
 * after `maxRetries` (default 5) consecutive collisions.
 *
 * NOTE: This check is *advisory* — another transaction can insert
 * between this SELECT and the caller's INSERT. The DB's unique index
 * is the real guard. Pair with `isUniqueViolation` for defense in depth.
 */
export async function generateUniqueToken<TTable extends AnyPgTable>(
  table: TTable,
  column: PgColumn,
  generator: () => string,
  options: UniqueTokenOptions = {},
): Promise<string> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const executor = options.executor ?? db;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const candidate = generator();
    // drizzle 0.45 tightened `.from()` generics (TableLikeHasEmptySelection);
    // a generic `AnyPgTable` can't be proven non-empty, so cast to the concrete
    // PgTable the runtime always receives. Behavior is unchanged.
    const [existing] = await executor
      .select({ marker: column })
      .from(table as PgTable)
      .where(eq(column, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  throw new Error(`generateUniqueToken: exhausted ${maxRetries} retries`);
}
