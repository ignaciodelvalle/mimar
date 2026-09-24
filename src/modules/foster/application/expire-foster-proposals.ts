// Use-case: expire pending foster proposals past their expiry date (cron/system).
//
// Migrated from FosterRepository.expirePendingProposals (the repo method handles
// per-row tx + status recheck + event + case close + notifications).
//
// This use-case is a thin orchestrator: no actor (system-initiated), delegates
// the sweep to the repo, and returns ExpireStats.
//
// Auth: no user actor — this is called by the cron route (system action).
// Parity: recordedByUserId=null, authorRole='system', auto_expired close reason.

import type { CronBudgetHeaders } from "@/lib/infra/cron-dispatcher";

import type { FosterRepository } from "../infrastructure/foster-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Deps = {
  repo: typeof FosterRepository;
};

export type ExpireStats = {
  candidates: number;
  expired: number;
  errors: number;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function expireFosterProposals(
  deps: Deps,
  opts?: {
    /**
     * The daily dispatcher's fair share, forwarded to the repo sweep so its
     * 45 s ceiling becomes min(own, handed down) — RN #9 half b.
     */
    budgetHeaders?: CronBudgetHeaders;
  },
): Promise<UseCaseResult<ExpireStats>> {
  const { repo } = deps;

  try {
    const stats = await repo.expirePendingProposals(new Date(), {
      budgetHeaders: opts?.budgetHeaders,
    });
    return { ok: true, value: stats, notifications: [] };
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo ejecutar la expiración: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }
}
