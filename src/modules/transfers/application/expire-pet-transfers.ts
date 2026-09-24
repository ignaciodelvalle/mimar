// Use-case: expire pending pet transfers past their expiry date (cron/system).
//
// Migrated from app/actions/pet-transfer.ts::expirePetTransfersOnce.
// Auth: none (system-initiated). Route gates on CRON_SECRET.
//
// Per-row (NOT single tx) — loop continues on per-row failure.
// Parity: actor for auditLog = fromOwnerId. auditLog insert stays in the thin
// action/route (the use-case returns all notifications so the caller can flush them).
//
// Returns { expired: count } plus accumulated notifications for best-effort flush.

import type { TransfersRepository } from "../infrastructure/transfers-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Deps = {
  repo: typeof TransfersRepository;
};

export type ExpirePetTransfersAuditEntry = {
  actorUserId: string;
  transferToken: string;
  petId: string;
};

export type ExpirePetTransfersStats = {
  expired: number;
  errors: number;
  /** Per-row data for audit_log inserts. The thin action writes these post-loop. */
  auditEntries: ExpirePetTransfersAuditEntry[];
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function expirePetTransfers(
  deps: Deps,
  opts?: { limit?: number },
): Promise<UseCaseResult<ExpirePetTransfersStats>> {
  const { repo } = deps;

  const now = new Date();
  const stale = await repo.expirablePetTransfers(now, opts?.limit);

  let expired = 0;
  let errors = 0;
  const notifications: NewNotification[] = [];
  const auditEntries: ExpirePetTransfersAuditEntry[] = [];

  for (const row of stale) {
    try {
      // Concurrency guard: only expire rows STILL 'pending'. The
      // expirablePetTransfers scan reads 'pending' rows, but between that scan
      // and this per-row UPDATE a concurrent accept/reject/cancel may have moved
      // the transfer to a terminal status. Without the expectedStatus predicate
      // this blind write would stomp that terminal status back to 'expired',
      // corrupting an already-accepted/rejected/cancelled transfer. A zero-row
      // result means another writer already resolved it — skip silently (no
      // expiry notification, no audit entry).
      const updatedRows = await repo.updateTransferStatus({
        id: row.id,
        status: "expired",
        respondedAt: now,
        expectedStatus: "pending",
      });
      if (updatedRows === 0) continue;

      notifications.push({
        userId: row.fromOwnerId,
        notificationType: "pet_transfer_expired",
        severity: "warning",
        title: "Transferencia expirada",
        body: "La propuesta venció sin respuesta. Podés iniciar otra cuando quieras.",
        ctaUrl: "/mis-mascotas",
        ctaLabel: "Ver mis mascotas",
        relatedPetId: row.petId,
        category: "custody",
      });

      // Parity: actor=fromOwnerId per row (not the calling user).
      auditEntries.push({
        actorUserId: row.fromOwnerId,
        transferToken: row.publicToken,
        petId: row.petId,
      });

      expired += 1;
    } catch (err) {
      errors += 1;
      console.error("expirePetTransfers row failed", row.id, err);
    }
  }

  return { ok: true, value: { expired, errors, auditEntries }, notifications };
}
