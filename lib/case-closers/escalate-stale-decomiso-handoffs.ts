// Thin re-export shim — logic lives in src/modules/cases/application/.
// All callers (cron routes, scripts, tests) continue to work unchanged.
export type {
  EscalateStaleDecomisosOptions,
  StaleDecomisoCandidateFull,
} from "@/src/modules/cases/application/escalate-stale-decomiso-handoffs";
export {
  escalateStaleDecomiso,
  findStaleDecomisoCandidates,
} from "@/src/modules/cases/application/escalate-stale-decomiso-handoffs";
