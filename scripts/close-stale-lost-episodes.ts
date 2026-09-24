#!/usr/bin/env tsx
/**
 * Daily cron CLI: close lost_pet_episode cases inactive >180 days.
 * Run: pnpm tsx scripts/close-stale-lost-episodes.ts
 * Idempotent.
 */

import {
  closeStaleLostEpisode,
  findStaleLostEpisodes,
} from "@/lib/case-closers/close-stale-lost-episodes";
import { runCaseCron } from "@/lib/infra/case-cron";

async function main() {
  const start = Date.now();
  const result = await runCaseCron({
    name: "close_stale_lost_episodes",
    scan: () => findStaleLostEpisodes(),
    processOne: (candidate) => closeStaleLostEpisode(candidate),
  });
  const ms = Date.now() - start;
  console.log(
    `[close-stale-lost-episodes] status=${result.status} processed=${result.itemsProcessed} errors=${result.errors.length} runId=${result.runId} (${ms}ms)`,
  );
  for (const e of result.errors) {
    console.warn(`  case ${e.id}: ${e.reason}`);
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1]?.endsWith("close-stale-lost-episodes.ts");
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
