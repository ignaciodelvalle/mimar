// Row-lock a decomiso case inside a hand-off transaction and re-read what the
// pre-tx validation decided on.
//
// WHY (security/code review 2026-09). accept and reassign both validate the
// case OUTSIDE their transaction. Interleaved, a reassign could move the case
// to a new receiver while the OLD receiver's accept — validated a moment
// earlier — went on to take custody. The accept took the pet advisory lock,
// but reassign took none, and nothing re-checked the case once inside.
//
// Both writers now take the SAME two locks in the SAME order — pet advisory
// lock (L-9, first statement of the transaction), then this `FOR UPDATE` on
// the case row — and re-check status and receiver under them. Whichever commits
// second sees the other's write and refuses.

import { eq } from "drizzle-orm";

import { cases, type db } from "@/db";

type TxType = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Thrown (the callers' transactions roll back on it) when the case moved on. */
export const DECOMISO_HANDOFF_STALE =
  "El decomiso cambió mientras operabas (fue reasignado o ya no está abierto). Recargá la página.";

/**
 * `SELECT … FOR UPDATE` the case and assert it is still open and still
 * addressed to `expectedReceiverOrgId`. Throws DECOMISO_HANDOFF_STALE otherwise.
 *
 * `null` is a real expectation, not a wildcard: after a receiver REJECTS, the
 * case stays open with no receiver and the authority reassigns from there. An
 * accept always passes its own org id, so a case with no receiver refuses it.
 */
export async function lockHandoffCaseOrThrow(
  tx: TxType,
  caseId: string,
  expectedReceiverOrgId: string | null,
): Promise<void> {
  const [row] = await tx
    .select({ status: cases.status, receiverOrganizationId: cases.receiverOrganizationId })
    .from(cases)
    .where(eq(cases.id, caseId))
    .for("update");
  if (!row || row.status !== "open" || row.receiverOrganizationId !== expectedReceiverOrgId) {
    throw new Error(DECOMISO_HANDOFF_STALE);
  }
}
