// Thin re-export shim — logic lives in src/modules/cases/application/.
// All callers (cron routes, scripts, tests) continue to work unchanged.
export type {
  CloseFollowupExpiredAdoptionsOptions,
  FollowupExpiredCandidate,
} from "@/src/modules/cases/application/close-followup-expired-adoptions";
export {
  closeFollowupExpiredAdoption,
  findFollowupExpiredAdoptions,
} from "@/src/modules/cases/application/close-followup-expired-adoptions";
