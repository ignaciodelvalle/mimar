// Thin re-export shim — logic lives in src/modules/cases/application/.
// All callers (cron routes, scripts, tests) continue to work unchanged.
export type {
  EscalateStaleDisputesOptions,
  StaleDisputeCandidate,
} from "@/src/modules/cases/application/escalate-stale-disputes";
export {
  escalateStaleDispute,
  findStaleDisputes,
} from "@/src/modules/cases/application/escalate-stale-disputes";
