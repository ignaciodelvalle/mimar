// Thin re-export shim — logic lives in src/modules/cases/application/.
// All callers (cron routes, scripts, tests) continue to work unchanged.
export type {
  EscalateStaleWelfareOptions,
  StaleWelfareCandidate,
} from "@/src/modules/cases/application/escalate-stale-welfare-cases";
export {
  escalateStaleWelfareCase,
  findStaleWelfareCases,
} from "@/src/modules/cases/application/escalate-stale-welfare-cases";
