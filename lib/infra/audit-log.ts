// Single write path for `audit_log` — the accountability spine.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// An invariant-escape audit (2026-08-16) ranked audit-log completeness as the
// largest structural gap in the system: 67 hand-written `db.insert(auditLog)`
// call sites, no helper, no fence, no test asserting that a mutating operator
// action leaves a trace. Unlike authorization — where an unguarded action is
// caught by `lint:authz` — omitting the audit row entirely was caught by
// NOTHING, and the absence of a row is permanently indistinguishable from the
// absence of the action it would have described.
//
// Two things this module fixes, and one it deliberately does not:
//
//   1. EXECUTOR-FIRST. `writeAuditLog(tx, …)` composes INSIDE the transaction
//      that performs the mutation, so a rollback takes the audit row with it
//      and a crash can never leave a mutation with no trace. The invariant's
//      "same transaction" clause was already violated in production code (e.g.
//      assignGovtLocalityForAuthority wrote the govt_assignments row and the
//      audit row as two separate autocommits — a crash between them left a
//      granted jurisdiction authority with no audit trail).
//
//   2. BEFORE/AFTER IS EXPLICIT. The invariant says the trail records
//      "previous/new state"; almost every existing payload carried only new
//      values. `before`/`after` are first-class fields here and land under the
//      conventional `before_values` / `after_values` payload keys (the shape
//      update-profile.ts had already invented on its own).
//
//   3. It does NOT change the row shape. Omit `before`/`after` and the row is
//      byte-identical to what a hand-written `db.insert(auditLog).values(…)`
//      produced, so the 67 existing call sites keep compiling and can migrate
//      one at a time. This module is ADDITIVE by design.
//
// NOT A SUBSTITUTE FOR THE FENCE. A helper only helps the call sites that call
// it; `scripts/check-audit-log-coverage.ts` (pnpm lint:audit-log) is what
// notices the ones that don't.

import { type AuditLogAction, auditLog, type db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Anything that can run the INSERT: the module-level `db` handle, or a drizzle
 * transaction handle. Executor-FIRST in the signature so the transactional
 * form reads as the default and `db` looks like the exception it should be.
 */
export type AuditExecutor = typeof db | Tx;

/**
 * One accountability record. Mirrors `audit_log`'s columns plus the
 * before/after pair the invariant asks for.
 */
export type AuditLogEntry = {
  /** Catalog action. Typed against AUDIT_LOG_ACTIONS and CHECK-constrained in the DB. */
  action: AuditLogAction;
  /** Who acted. Nullable: the FK is ON DELETE SET NULL (migration 0080), and a
   * few system writers (cron sweeps, triggers) genuinely have no user actor. */
  actorUserId?: string | null;
  approvalRequestId?: string | null;
  targetUserId?: string | null;
  targetOrganizationId?: string | null;
  targetGovtAssignmentId?: string | null;
  /** Free-form context. Never PII that the row's FK columns already carry. */
  payload?: Record<string, unknown>;
  /**
   * State BEFORE the mutation this row describes. Stored at
   * `payload.before_values`. Pass `null` only when the fact genuinely has no
   * prior state (a creation); omit it when you simply did not capture one.
   */
  before?: Record<string, unknown> | null;
  /** State AFTER the mutation. Stored at `payload.after_values`. */
  after?: Record<string, unknown> | null;
};

/**
 * Build the `values()` object for one audit row. Pure — exported so tests can
 * assert the payload contract without a database.
 *
 * `before`/`after` are folded into the payload rather than added as columns:
 * `audit_log` is append-only and heavily indexed, and two new nullable jsonb
 * columns would have to be backfilled across every historical row to mean
 * anything. Inside the payload, "absent" honestly reads as "not captured".
 */
export function buildAuditLogValues(entry: AuditLogEntry): typeof auditLog.$inferInsert {
  const payload: Record<string, unknown> = { ...(entry.payload ?? {}) };
  // `undefined` = not captured (key stays absent). `null` = captured as "no
  // prior state". The distinction is the whole point of the contract, so it
  // must survive into the stored jsonb.
  if (entry.before !== undefined) payload.before_values = entry.before;
  if (entry.after !== undefined) payload.after_values = entry.after;

  return {
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    approvalRequestId: entry.approvalRequestId ?? null,
    targetUserId: entry.targetUserId ?? null,
    targetOrganizationId: entry.targetOrganizationId ?? null,
    targetGovtAssignmentId: entry.targetGovtAssignmentId ?? null,
    payload,
  };
}

/**
 * Write one `audit_log` row through `executor`.
 *
 * PASS THE TRANSACTION whenever the row describes a mutation performed in one:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await tx.update(profiles).set({ role: "owner" }).where(eq(profiles.id, userId));
 *   await writeAuditLog(tx, {
 *     action: "self_resignation_vet",
 *     actorUserId: userId,
 *     targetUserId: userId,
 *     before: { role: "vet" },
 *     after: { role: "owner" },
 *   });
 * });
 * ```
 *
 * Passing `db` is correct ONLY when the audit row IS the entire fact (a read
 * trail such as `request_viewed`, an export receipt) or when the thing being
 * recorded is not a Postgres write at all (a Supabase Auth magic link, a
 * storage upload) and therefore cannot share a transaction with anything.
 *
 * Does NOT swallow errors. An audit write that fails silently is the exact
 * failure this module exists to end; a caller that must not be undone by a
 * failed audit row has to say so explicitly at its own call site.
 *
 * @returns the new row's id — useful for correlating a follow-up record.
 */
export async function writeAuditLog(
  executor: AuditExecutor,
  entry: AuditLogEntry,
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(auditLog)
    .values(buildAuditLogValues(entry))
    .returning({ id: auditLog.id });
  return row;
}
