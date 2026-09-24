#!/usr/bin/env tsx
/**
 * Daily cron CLI: close adoption_listing cases whose followup window expired.
 * Run: pnpm tsx scripts/close-followup-expired-adoptions.ts
 * Idempotent.
 */

import {
  closeFollowupExpiredAdoption,
  findFollowupExpiredAdoptions,
} from "@/lib/case-closers/close-followup-expired-adoptions";
import { runCaseCron } from "@/lib/infra/case-cron";

async function main() {
  const start = Date.now();
  const result = await runCaseCron({
    name: "close_followup_expired_adoptions",
    scan: () => findFollowupExpiredAdoptions(),
    processOne: (candidate) => closeFollowupExpiredAdoption(candidate),
  });
  const ms = Date.now() - start;
  console.log(
    `[close-followup-expired-adoptions] status=${result.status} processed=${result.itemsProcessed} errors=${result.errors.length} runId=${result.runId} (${ms}ms)`,
  );
  for (const e of result.errors) {
    console.warn(`  case ${e.id}: ${e.reason}`);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1]?.endsWith("close-followup-expired-adoptions.ts");
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
