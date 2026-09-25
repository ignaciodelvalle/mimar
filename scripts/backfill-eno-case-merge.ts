#!/usr/bin/env tsx
/**
 * Legacy backfill for "one ENO record per case" (migration 0247).
 *
 * The rule and the three passes (key every case row, merge duplicates without
 * deleting them, enqueue positive closures that never got an ENO row) are
 * documented in src/modules/surveillance/infrastructure/eno-case-backfill.ts.
 * This file is the CLI.
 *
 * DRY-RUN BY DEFAULT: lists what it would do and writes nothing.
 *
 *   pnpm backfill:eno-case              # dry-run
 *   pnpm backfill:eno-case -- --apply   # writes
 *
 * Both modes need migration 0247 applied (they read eno_case_key). Re-running
 * is safe: keyed rows are not re-keyed, merged rows are skipped, and a linked
 * closure is found on its record.
 */

import "./_load-env";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import {
  applyEnoCaseBackfill,
  planEnoCaseBackfill,
} from "@/src/modules/surveillance/infrastructure/eno-case-backfill";

async function hasMigration0247(): Promise<boolean> {
  const rows = (await db.execute(sql`
    select count(*)::int as n from information_schema.columns
    where table_name = 'event_notification_outbox'
      and column_name in ('eno_case_key', 'linked_sources', 'merged_into_id')`)) as unknown as {
    n: number;
  }[];
  return Number(rows[0]?.n ?? 0) === 3;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`[backfill-eno-case-merge] mode=${apply ? "APPLY" : "dry-run"}`);
  if (!(await hasMigration0247())) {
    console.error(
      "  needs migration 0247 (eno_case_key, linked_sources, merged_into_id). Aborting.",
    );
    process.exit(1);
  }

  const plan = await planEnoCaseBackfill();
  const folded = plan.duplicates.reduce((n, g) => n + g.rows.length - 1, 0);
  console.log(`  outbox rows scanned: ${plan.scanned}`);
  console.log(`  (a) case rows to key (singletons): ${plan.singletons.length}`);
  console.log(
    `  (a) duplicate case groups: ${plan.duplicates.length}  (rows to mark merged: ${folded})`,
  );
  for (const g of plan.duplicates) {
    console.log(
      `      ${g.targetKind} ${g.caseKey}: ${g.rows.map((r) => `${r.eventType}/${r.status}`).join(", ")}`,
    );
  }
  console.log(`  (b) positive closures without an ENO row: ${plan.orphanClosures.length}`);
  for (const c of plan.orphanClosures) {
    console.log(`      event=${c.id} pet=${c.petId} recorded_at=${c.recordedAt.toISOString()}`);
  }

  if (!apply) {
    console.log("  dry-run: nothing written. Re-run with --apply to key, merge and create.");
    return;
  }
  await applyEnoCaseBackfill(plan);
  console.log(
    `  applied: ${plan.singletons.length} keyed, ${plan.duplicates.length} group(s) merged, ${plan.orphanClosures.length} closure(s) enqueued.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-eno-case-merge] FATAL:", err);
    process.exit(1);
  });
