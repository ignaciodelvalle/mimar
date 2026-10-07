// Replay check before state, INSIDE the write (plan A5c) — for both denuncia
// writers (citizen and org).
//
// The action asks the ledger before it inserts the report row
// (`findBridgedReportReplay`), which answers a retry that arrives AFTER the
// first submit committed. It cannot answer two copies in flight at once: both
// miss, both insert a report, and both would open a welfare_denuncia case — a
// kind exempt from the one-open-case index, so nothing in the database refuses
// the second. `claimReportKey` runs first inside the write transaction, takes
// the (reporter, key) lock and asks again; the second copy waits for the first
// to commit, finds its bridge event, and throws `ConcurrentReportReplay` so its
// own transaction writes nothing. The action then discards the report row it
// inserted and lands on the original.
//
// Same scope as the lookup: a reporter's key on a registered pet. Anonymous
// reports, reports with no pet, and kinds that write no bridge event (e.g.
// `other` with no symptoms) have no ledger to ask — that needs the key on
// welfare_reports, a migration.

import type { WelfareRepository } from "../infrastructure/welfare-repository";

export type WelfareReplay = { reportId: string; referenceCode: string };

export class ConcurrentReportReplay extends Error {
  constructor(readonly original: WelfareReplay) {
    super("concurrent replay of a denuncia already filed under this key");
  }
}

/** Throws ConcurrentReportReplay (rolling the write back) when a twin already filed it. */
export async function claimReportKey(
  repo: Pick<WelfareRepository, "lockAndFindBridgedReportReplay">,
  scope: {
    subjectPetId: string | null;
    clientIdempotencyKey: string | null;
    reporterUserId: string | null;
  },
  tx: unknown,
): Promise<void> {
  const { subjectPetId, clientIdempotencyKey, reporterUserId } = scope;
  if (!subjectPetId || !clientIdempotencyKey || !reporterUserId) return;
  const original = await repo.lockAndFindBridgedReportReplay(
    subjectPetId,
    clientIdempotencyKey,
    reporterUserId,
    tx as Parameters<typeof repo.lockAndFindBridgedReportReplay>[3],
  );
  if (original) throw new ConcurrentReportReplay(original);
}

/**
 * A failed write's answer: the ORIGINAL report when the failure was a
 * concurrent twin's replay (`discardInserted` tells the action to remove the
 * row it inserted), otherwise the writer's own failure.
 */
export function replayOrFailure<F>(
  err: unknown,
  redirectFor: (referenceCode: string) => string,
  failure: F,
):
  | { ok: true; reportId: string; referenceCode: string; redirectTo: string; discardInserted: true }
  | F {
  if (!(err instanceof ConcurrentReportReplay)) return failure;
  return {
    ok: true,
    reportId: err.original.reportId,
    referenceCode: err.original.referenceCode,
    redirectTo: redirectFor(err.original.referenceCode),
    discardInserted: true,
  };
}
