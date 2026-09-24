// Use-case: expire stale cross-org transfer handshake cases (cron/system).
//
// Logic moved from lib/case-closers/expire-cross-org-transfers.ts into the module.
// The lib file becomes a thin re-export shim (until callers are repointed in WU-4).
//
// Auth: none (system-initiated). Route/script gates on CRON_SECRET.
// Per-case in its own tx (repo.expireOneCrossOrgCase). Loop continues on failure.
// NO audit_log by design — note_added system event + closed case row is the trail.
//
// Returns { expired, errors } stats.

import type { TransfersRepository } from "../infrastructure/transfers-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Deps = {
  repo: typeof TransfersRepository;
  options?: { now?: Date; staleAfterDays?: number };
};

export type ExpireCrossOrgStats = {
  expired: number;
  errors: number;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function expireCrossOrgTransfers(
  deps: Deps,
): Promise<UseCaseResult<ExpireCrossOrgStats>> {
  const { repo, options } = deps;

  const candidates = await repo.findExpirableCrossOrgCases(options);

  let expired = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      await repo.expireOneCrossOrgCase(candidate, { now: options?.now });
      expired += 1;
    } catch (err) {
      errors += 1;
      console.error("expireCrossOrgTransfers case failed", candidate.id, err);
    }
  }

  return { ok: true, value: { expired, errors }, notifications: [] };
}
