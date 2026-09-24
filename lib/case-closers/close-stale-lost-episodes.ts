// Thin re-export shim — logic lives in src/modules/cases/application/.
// All callers (cron routes, scripts, tests) continue to work unchanged.
export type {
  CloseStaleLostEpisodesCandidate,
  CloseStaleLostEpisodesOptions,
} from "@/src/modules/cases/application/close-stale-lost-episodes";
export {
  closeStaleLostEpisode,
  findStaleLostEpisodes,
} from "@/src/modules/cases/application/close-stale-lost-episodes";
