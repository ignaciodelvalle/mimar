// Test helper for asserting on Postgres errors raised through Drizzle.
//
// WHY THIS EXISTS
// ---------------
// drizzle-orm 0.45 wraps thrown query errors in a `DrizzleQueryError` whose
// top-level `.message` is "Failed query: <sql>" and whose `.code` /
// `.constraint_name` are undefined. The real postgres-js error (with the
// SQLSTATE `code`, `constraint_name`, and a message mentioning the constraint)
// is now nested on `.cause`.
//
// As a result, `expect(promise).rejects.toThrow(/my_constraint/)` no longer
// works: `toThrow(regex)` matches only the top-level `.message`, which is now
// the SQL text — not the constraint name.
//
// `expectDbError` awaits the rejection, unwraps the `.cause` chain via the
// shared `lib/db-errors` helpers, and asserts the SQLSTATE code and/or the
// constraint, keeping the assertion NON-VACUOUS (a non-DB error or a wrong
// code/constraint fails the test).

import { expect } from "vitest";

import { matchesDbError, pgError } from "@/lib/infra/db-errors";

export interface ExpectDbErrorOptions {
  /** Exact SQLSTATE to assert (e.g. '23505', '23514', '23503'). */
  code?: string;
  /**
   * Constraint to assert. A string matches the constraint name by substring;
   * a RegExp is tested against the constraint name AND the pg error message
   * (CHECK / trigger violations name the constraint only in the message text).
   */
  constraint?: string | RegExp;
}

/**
 * Assert that `promise` rejects with a Postgres error matching `opts`.
 *
 * At least one of `code` / `constraint` must be provided so the assertion
 * stays meaningful. Returns the unwrapped pg error info for further assertions.
 */
export async function expectDbError(
  promise: Promise<unknown>,
  opts: ExpectDbErrorOptions,
): Promise<ReturnType<typeof pgError>> {
  if (opts.code === undefined && opts.constraint === undefined) {
    throw new Error("expectDbError: provide at least one of { code, constraint }");
  }

  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    rejected = true;
    caught = err;
  }

  // Non-vacuous: the promise MUST reject.
  expect(rejected, "expected the promise to reject with a DB error, but it resolved").toBe(true);

  const info = pgError(caught);
  // Surface the raw error when no pg error is found, so failures are debuggable.
  expect(
    info,
    `expected a Postgres error on the .cause chain, got: ${String(
      caught instanceof Error ? caught.message : caught,
    )}`,
  ).not.toBeNull();

  expect(
    matchesDbError(caught, opts),
    `expected DB error matching ${JSON.stringify({
      code: opts.code,
      constraint: String(opts.constraint),
    })}, got code=${info?.code} constraint=${info?.constraint}`,
  ).toBe(true);

  return info;
}
