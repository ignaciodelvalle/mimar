// Use case: the receiving authority marks an ENO notice "recibido" (PO S3,
// 2026-09-26). Who may: a govt user within the row's jurisdiction (their
// mandate), or an institutional admin (universal scope). The read-only
// `national` role is refused — it reads every row and writes none, the same
// line lint:authz draws for the government slice's writers. A govt with no
// mandate is refused before anything is read.

import type {
  OutboxReceiptRepository,
  OutboxReceiptResult,
} from "../infrastructure/outbox-receipt-repository";

export type MarkOutboxReceivedInput = {
  rowId: string;
  actor: {
    userId: string;
    role: string;
    /** The govt mandate; ignored for a national-scope role. */
    jurisdictions: ReadonlyArray<{ province: string; locality: string }>;
  };
};

export type MarkOutboxReceivedResult = OutboxReceiptResult | { ok: false; reason: "forbidden" };

export async function markOutboxReceived(
  input: MarkOutboxReceivedInput,
  deps: { repo: Pick<OutboxReceiptRepository, "markReceived"> },
): Promise<MarkOutboxReceivedResult> {
  const universal = input.actor.role === "admin";
  if (!universal && (input.actor.role !== "govt" || input.actor.jurisdictions.length === 0)) {
    return { ok: false, reason: "forbidden" };
  }
  return deps.repo.markReceived({
    rowId: input.rowId,
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    scope: universal ? undefined : input.actor.jurisdictions,
  });
}
