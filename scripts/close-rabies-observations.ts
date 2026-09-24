#!/usr/bin/env tsx
/**
 * Daily cron: close 10-day rabies observations whose period has elapsed.
 *
 * Delegates to lib/rabies-observation-closer.ts → closeEligibleRabiesObservations,
 * shared with app/api/cron/close-rabies-observations/route.ts so the cron and
 * the CLI run the same code path.
 *
 * Run:
 *   pnpm tsx scripts/close-rabies-observations.ts
 *
 * Idempotent.
 */

import { closeEligibleRabiesObservations } from "@/lib/infra/rabies-observation-closer";

async function main() {
  const start = Date.now();
  const stats = await closeEligibleRabiesObservations();
  const ms = Date.now() - start;
  console.log(
    `[close-rabies] scanned=${stats.scanned} windowExpiredUnclosed=${stats.windowExpiredUnclosed} flaggedForReview=${stats.flaggedForReview} skippedNotYetDue=${stats.skippedNotYetDue} errors=${stats.errors.length} (${ms}ms)`,
  );
  if (stats.errors.length > 0) {
    for (const e of stats.errors) {
      console.warn(`  pet ${e.petId}: ${e.reason}`);
    }
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1]?.endsWith("close-rabies-observations.ts");
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
