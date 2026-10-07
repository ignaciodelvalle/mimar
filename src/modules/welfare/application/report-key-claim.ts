// Replay check before state, INSIDE the write (plans A5c and A5f) — for both
// denuncia writers (citizen and org).
//
// The action asks the ledgers before it inserts the report row, which answers
// a retry that arrives AFTER the first submit committed. It cannot answer two
// copies in flight at once: both miss, both insert a report, and both would
// open a welfare_denuncia case — a kind exempt from the one-open-case index, so
// nothing in the database refuses the second. `claimReportKey` runs first
// inside the write transaction, takes the lock and asks again; the second copy
// waits for the first to commit, finds it, and throws `ConcurrentReportReplay`
// so its own transaction writes nothing. The action then discards the report
// row it inserted and lands on the original.
//
// Two ledgers, asked in a fixed order (so two writers never take the two locks
// in opposite orders):
//   1. The report itself (A5f, migration 0289): `welfare_reports.client_key_digest`,
//      for EVERY submit whose key is long enough (domain/report-key-digest.ts) —
//      anonymous ones, reports with no pet, kinds that write no bridge event.
//      The claim returns the digest, and the writer stamps it with the case
//      (`linkCase`) in this same transaction.
//   2. The pet-event bridge (A5c): an identified reporter's key on a registered
//      pet. Still asked, because a report filed before 0289 carries no digest.
//
// AN ANONYMOUS REPLAY CARRIES NOTHING. The key is the anonymous scope's only
// proof (there is no identity to scope by), so its replay answers "ya la
// recibimos" and never the original's reference code — which would let a
// stolen key mint a reporter session for someone else's denuncia.

import { reportKeyDigest } from "../domain/report-key-digest";
import type { WelfareRepository } from "../infrastructure/welfare-repository";

export type WelfareReplay = { reportId: string; referenceCode: string };

export class ConcurrentReportReplay extends Error {
  /** `original` is null for an anonymous replay: nothing about it leaves. */
  constructor(readonly original: WelfareReplay | null) {
    super("concurrent replay of a denuncia already filed under this key");
  }
}

/**
 * Throws ConcurrentReportReplay (rolling the write back) when a twin already
 * filed it. Returns the digest the writer must stamp with the case, or null
 * when this submit claims no report-level slot.
 */
export async function claimReportKey(
  repo: Pick<WelfareRepository, "lockAndFindBridgedReportReplay" | "lockAndFindReportByKeyDigest">,
  scope: {
    subjectPetId: string | null;
    clientIdempotencyKey: string | null;
    reporterUserId: string | null;
    /** The org an org member files for — part of the slot (domain/report-key-digest.ts). */
    reporterOrganizationId?: string | null;
  },
  tx: unknown,
): Promise<string | null> {
  const { subjectPetId, clientIdempotencyKey, reporterUserId } = scope;

  const keyDigest = reportKeyDigest(
    clientIdempotencyKey,
    reporterUserId,
    scope.reporterOrganizationId ?? null,
  );
  if (keyDigest) {
    const original = await repo.lockAndFindReportByKeyDigest(
      keyDigest,
      tx as Parameters<typeof repo.lockAndFindReportByKeyDigest>[1],
    );
    if (original) throw new ConcurrentReportReplay(reporterUserId ? original : null);
  }

  if (subjectPetId && clientIdempotencyKey && reporterUserId) {
    const original = await repo.lockAndFindBridgedReportReplay(
      subjectPetId,
      clientIdempotencyKey,
      reporterUserId,
      tx as Parameters<typeof repo.lockAndFindBridgedReportReplay>[3],
    );
    if (original) throw new ConcurrentReportReplay(original);
  }

  return keyDigest;
}

/**
 * The pre-check every door asks BEFORE inserting its report row: the report
 * already filed under this submit's key and scope, or null. Outside any
 * transaction — claimReportKey is what closes the race.
 */
export async function findKeyedReport(
  repo: Pick<WelfareRepository, "findReportByKeyDigest">,
  scope: {
    clientIdempotencyKey: string | null;
    reporterUserId: string | null;
    reporterOrganizationId?: string | null;
  },
): Promise<WelfareReplay | null> {
  const digest = reportKeyDigest(
    scope.clientIdempotencyKey,
    scope.reporterUserId,
    scope.reporterOrganizationId ?? null,
  );
  return digest ? repo.findReportByKeyDigest(digest) : null;
}

/**
 * The web form's answer to an ANONYMOUS submit already filed under the same
 * key. It carries nothing about the original — no reference code, no reporter
 * session: the key is the anonymous scope's only proof, and a key is not
 * enough to open a denuncia to whoever holds it. It rides the form's message
 * slot (WelfareReportFormState has no other) and keeps the draft, so a further
 * retry lands here again instead of filing a second report.
 */
export const ANONYMOUS_REPLAY_NOTICE =
  "Esta denuncia ya había sido recibida, no hace falta volver a enviarla. Por tu privacidad no volvemos a mostrar su código.";

/**
 * The answer to an anonymous submit that was already filed: nothing about it.
 * The `never` fields say so to the type system — a reader of `reportId`,
 * `referenceCode` or `redirectTo` gets `undefined` on this arm, never a value.
 */
export type AnonymousReplay = {
  ok: true;
  anonymousReplay: true;
  discardInserted: true;
  reportId?: never;
  referenceCode?: never;
  redirectTo?: never;
};

/** An anonymous twin's replay, or null for any other failure. */
export function anonymousReplayOf(err: unknown): AnonymousReplay | null {
  if (err instanceof ConcurrentReportReplay && err.original === null) {
    return { ok: true, anonymousReplay: true, discardInserted: true };
  }
  return null;
}

/**
 * A failed write's answer: the ORIGINAL report when the failure was an
 * identified reporter's concurrent twin (`discardInserted` tells the action to
 * remove the row it inserted), otherwise the writer's own failure. An
 * anonymous replay is NOT answered here (see anonymousReplayOf) — it falls
 * through to the failure, never to the original.
 */
export function replayOrFailure<F>(
  err: unknown,
  redirectFor: (referenceCode: string) => string,
  failure: F,
):
  | { ok: true; reportId: string; referenceCode: string; redirectTo: string; discardInserted: true }
  | F {
  if (!(err instanceof ConcurrentReportReplay) || err.original === null) return failure;
  return {
    ok: true,
    reportId: err.original.reportId,
    referenceCode: err.original.referenceCode,
    redirectTo: redirectFor(err.original.referenceCode),
    discardInserted: true,
  };
}
