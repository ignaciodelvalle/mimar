#!/usr/bin/env tsx
/**
 * Daily cron CLI: escalate welfare_denuncia cases inactive >90 days.
 * Run: pnpm tsx scripts/escalate-stale-welfare-cases.ts
 * Idempotent (rows already in `escalated` are skipped).
 */

import {
  escalateStaleWelfareCase,
  findStaleWelfareCases,
} from "@/lib/case-closers/escalate-stale-welfare-cases";
import { runCaseCron } from "@/lib/infra/case-cron";

async function main() {
  const start = Date.now();
  const result = await runCaseCron({
    name: "escalate_stale_welfare_cases",
    scan: () => findStaleWelfareCases(),
    processOne: (candidate) => escalateStaleWelfareCase(candidate),
  });
  const ms = Date.now() - start;
  console.log(
    `[escalate-stale-welfare-cases] status=${result.status} processed=${result.itemsProcessed} errors=${result.errors.length} runId=${result.runId} (${ms}ms)`,
  );
  for (const e of result.errors) {
    console.warn(`  case ${e.id}: ${e.reason}`);
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1]?.endsWith("escalate-stale-welfare-cases.ts");
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
