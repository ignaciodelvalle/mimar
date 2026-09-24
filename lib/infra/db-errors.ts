// Shared Postgres-error inspection helpers — single source of truth.
//
// WHY THIS EXISTS
// ---------------
// drizzle-orm 0.45 changed how query errors are thrown. A failed query now
// rejects with a `DrizzleQueryError` wrapper whose TOP-LEVEL fields are NOT
// the postgres-js error:
//   - `err.message`         === "Failed query: insert into ..." (the SQL text)
//   - `err.code`            === undefined
//   - `err.constraint_name` === undefined
//
// The real postgres-js error — the one that actually carries the SQLSTATE
// `code` (e.g. '23505', '23514'), the `constraint_name`, the `detail`, and a
// message mentioning the constraint — is now nested on `err.cause` (and can be
// nested one or two more levels deep depending on the driver path).
//
// Consequences if you read the error directly:
//   - `err.code === '23514'` is now ALWAYS false → capacity / unique / FK
//     violations bubble raw to the user instead of the friendly message.
//   - `expect(promise).rejects.toThrow(/constraint_name/)` matches only
//     `err.message`, which is now "Failed query: ..." → the assertion fails.
//
// These helpers walk the `.cause` chain (depth-guarded) and return the first
// object that looks like a postgres-js error so call sites keep working
// regardless of how many wrapper layers drizzle adds.

/** Max `.cause` levels to walk before giving up (guards against cycles). */
const MAX_CAUSE_DEPTH = 5;

/**
 * Shape of the unwrapped postgres-js error fields we care about.
 *
 * `code` is the SQLSTATE class (5 chars, digits + letters), e.g. '23505'.
 * `constraint` mirrors `constraint_name` for layers that rename the field.
 */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message?: string;
  /** The raw error object that carried the SQLSTATE code (for `detail`, `column_name`, …). */
  raw: Record<string, unknown>;
}

/** A non-null object that may carry a postgres `code` and a `cause`. */
type ErrorLike = Record<string, unknown> & { cause?: unknown };

function isObject(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

/**
 * A postgres-js error carries `code` as a SQLSTATE string: exactly five
 * characters whose FIRST char is a digit (the SQLSTATE class always starts
 * with 0-9, e.g. '23505', '40P01', '42P01', '08006'). Subclass positions may
 * hold letters. Anchoring the first char to a digit avoids false positives on
 * any all-uppercase app-layer sentinel like 'TOKEN' or 'NOKEY'.
 */
function looksLikeSqlState(code: unknown): code is string {
  return typeof code === "string" && /^[0-9][0-9A-Z]{4}$/.test(code);
}

/**
 * Walk the `.cause` chain (depth-guarded) and return the first object carrying
 * a postgres SQLSTATE `code`. Returns `null` if no such object is found.
 *
 * See the file header for WHY drizzle 0.45 makes this necessary.
 */
export function pgError(err: unknown): PgErrorInfo | null {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && isObject(current); depth++) {
    const code = current.code;
    if (looksLikeSqlState(code)) {
      const constraintName = current.constraint_name ?? current.constraint;
      return {
        code,
        constraint: typeof constraintName === "string" ? constraintName : undefined,
        message: typeof current.message === "string" ? current.message : undefined,
        raw: current,
      };
    }
    current = current.cause;
  }
  return null;
}

/** The SQLSTATE code of the underlying pg error, or `null` if none found. */
export function pgErrorCode(err: unknown): string | null {
  return pgError(err)?.code ?? null;
}

/**
 * The constraint name of the underlying pg error, or `null`.
 *
 * postgres-js exposes it as `constraint_name`; some layers use `constraint`.
 * `pgError` already normalises both into `.constraint`.
 */
export function pgConstraintName(err: unknown): string | null {
  return pgError(err)?.constraint ?? null;
}

export interface DbErrorMatch {
  /** Exact SQLSTATE to match (e.g. '23505'). */
  code?: string;
  /**
   * Constraint to match. A string matches by `includes` (so a partial name
   * works); a RegExp tests the constraint name AND the pg error message
   * (the constraint name appears in the message text for CHECK/trigger errors).
   */
  constraint?: string | RegExp;
}

/**
 * True when the underlying pg error matches the given code and/or constraint.
 *
 * - `code`: exact SQLSTATE equality.
 * - `constraint` as string: substring match against the constraint name.
 * - `constraint` as RegExp: tested against the constraint name first, then
 *   against the pg error message (covers CHECK/trigger violations where the
 *   constraint name only appears in the message text).
 */
export function matchesDbError(err: unknown, opts: DbErrorMatch): boolean {
  const info = pgError(err);
  if (!info) return false;

  if (opts.code !== undefined && info.code !== opts.code) return false;

  if (opts.constraint !== undefined) {
    const name = info.constraint ?? "";
    const message = info.message ?? "";
    if (typeof opts.constraint === "string") {
      if (!name.includes(opts.constraint)) return false;
    } else {
      if (!opts.constraint.test(name) && !opts.constraint.test(message)) return false;
    }
  }

  return true;
}

/** SQLSTATE 23505 = unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}
