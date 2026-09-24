#!/usr/bin/env tsx
/**
 * Daily cron CLI: escalate custody_dispute cases open >365 days.
 * Run: pnpm tsx scripts/escalate-stale-disputes.ts
 * Idempotent.
 */

import {
  escalateStaleDispute,
  findStaleDisputes,
} from "@/lib/case-closers/escalate-stale-disputes";
import { runCaseCron } from "@/lib/infra/case-cron";

async function main() {
  const start = Date.now();
  const result = await runCaseCron({
    name: "escalate_stale_disputes",
    scan: () => findStaleDisputes(),
    processOne: (candidate) => escalateStaleDispute(candidate),
  });
  const ms = Date.now() - start;
  console.log(
    `[escalate-stale-disputes] status=${result.status} processed=${result.itemsProcessed} errors=${result.errors.length} runId=${result.runId} (${ms}ms)`,
  );
  for (const e of result.errors) {
    console.warn(`  case ${e.id}: ${e.reason}`);
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1]?.endsWith("escalate-stale-disputes.ts");
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
