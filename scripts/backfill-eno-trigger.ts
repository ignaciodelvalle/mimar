#!/usr/bin/env tsx
/**
 * One-time backfill: replay missed ENO notifications for historical
 * `clinical_info_logged / disease_diagnosis` events that were silently
 * no-op'd by the eno-trigger disease-code bug (fixed in PR #137).
 *
 * Run (dry-run — safe, no writes):
 *   pnpm backfill:eno -- --dry-run --since 2026-01-01
 *
 * Run (real — writes notifications + audit entries):
 *   pnpm backfill:eno -- --since 2026-01-01
 *
 * Use the `backfill:eno` npm script, NOT a raw `tsx` call: it passes
 * `--conditions=react-server` so the `server-only` guard in the surveillance
 * repository (which this script reaches via processEnoEventTrigger) resolves
 * to a no-op. This script IS server code, so that condition is correct.
 *
 * Flags:
 *   --dry-run              Query and report candidates without writing anything.
 *   --since YYYY-MM-DD     Only consider events with occurred_at >= since.
 *   --until YYYY-MM-DD     Only consider events with occurred_at < until (default: now).
 *   --limit N              Max candidates processed in this run (default: 1000).
 *
 * Idempotent: skips events where a notification with
 *   notificationType='eno_disease_diagnosis' AND relatedEventId=event.id
 * already exists.  Re-running the script after a partial failure is safe.
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap — side-effect import MUST be first so DATABASE_URL is set
//    before db/index.ts is evaluated. ESM hoists all `import` statements, so an
//    inline `loadEnv()` call runs AFTER `@/db` is already evaluated (and throws).
//    See scripts/_load-env.ts (same fix as seed-demo-spine.ts).
// ---------------------------------------------------------------------------

import "./_load-env";

// ---------------------------------------------------------------------------
// 2. Imports
// ---------------------------------------------------------------------------

import { and, eq, gte, isNull, lt } from "drizzle-orm";

import { auditLog, db, notifications, petEvents, profiles } from "@/db";
import { parseFlags } from "@/lib/infra/backfill-eno-trigger-helpers";
import { processEnoEventTrigger } from "@/lib/infra/eno-trigger";
import { diseaseCodeToEnoCode, isEnoCode } from "@/src/modules/surveillance/domain/eno-catalog";

// ---------------------------------------------------------------------------
// 3. Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const { dryRun, since, until, limit } = flags;

  console.log("[backfill-eno-trigger] starting");
  console.log(
    `  dry_run=${dryRun}  since=${since?.toISOString() ?? "unbounded"}  until=${until.toISOString()}  limit=${limit}`,
  );

  // ── Step 1: Resolve a system actor for the top-level audit log entry ──
  // audit_log.actor_user_id is NOT NULL + FK to profiles.  Use the same
  // pattern as the auto-expire-approvals cron: oldest active admin.
  const [systemActor] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        eq(profiles.accountType, "institutional"),
        isNull(profiles.deactivatedAt),
      ),
    )
    .orderBy(profiles.createdAt)
    .limit(1);

  if (!systemActor) {
    console.error(
      "[backfill-eno-trigger] FATAL: no active admin found for system actor — aborting.",
    );
    process.exit(1);
  }

  // ── Step 2: Query candidate events ──
  // Filter at SQL level for the fast lane: event_type + sub_kind.
  // The ENO-eligibility bridge (diseaseCodeToEnoCode + isEnoCode) is applied
  // in-process after fetch because JSONB operator support varies.
  const conditions = [
    eq(petEvents.eventType, "clinical_info_logged"),
    lt(petEvents.occurredAt, until),
  ];
  if (since) {
    conditions.push(gte(petEvents.occurredAt, since));
  }

  const candidates = await db
    .select({
      id: petEvents.id,
      petId: petEvents.petId,
      authorRole: petEvents.authorRole,
      recordedByUserId: petEvents.recordedByUserId,
      authorOrganizationId: petEvents.authorOrganizationId,
      payload: petEvents.payload,
      occurredAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .where(and(...conditions))
    .limit(limit);

  console.log(`  candidates fetched (pre-filter): ${candidates.length}`);

  // ── Step 3: Filter to ENO-eligible ──
  const eligible = candidates.filter((ev) => {
    const p = ev.payload as Record<string, unknown>;
    if (p.sub_kind !== "disease_diagnosis") return false;
    const rawCode = typeof p.disease_code === "string" ? p.disease_code : null;
    if (!rawCode) return false;
    return isEnoCode(diseaseCodeToEnoCode(rawCode));
  });

  console.log(`  ENO-eligible after bridge filter: ${eligible.length}`);

  // ── Step 4: Process each eligible event ──
  let processed = 0;
  let skipped = 0;
  let notified = 0;
  const errors: { id: string; reason: string }[] = [];

  for (const ev of eligible) {
    const rawCode = (ev.payload as Record<string, unknown>).disease_code as string;
    const enoCode = diseaseCodeToEnoCode(rawCode);

    if (dryRun) {
      // For dry-run, check whether a notification already exists and log.
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.notificationType, "eno_disease_diagnosis"),
            eq(notifications.relatedEventId, ev.id),
          ),
        )
        .limit(1);

      const wouldNotify = !existing;
      console.log(
        `  [DRY-RUN] event=${ev.id}  disease_code=${rawCode} → enoCode=${enoCode}  would-notify=${wouldNotify}  occurred_at=${ev.occurredAt.toISOString()}`,
      );
      processed++;
      if (wouldNotify) notified++;
      else skipped++;
      continue;
    }

    // Real run: skip if notification already exists (idempotency gate)
    try {
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.notificationType, "eno_disease_diagnosis"),
            eq(notifications.relatedEventId, ev.id),
          ),
        )
        .limit(1);

      if (existing) {
        skipped++;
        processed++;
        continue;
      }

      // Fire the trigger with the original event row shape expected by
      // processEnoEventTrigger (PetEventRow).
      await processEnoEventTrigger({
        id: ev.id,
        petId: ev.petId,
        authorRole: ev.authorRole,
        recordedByUserId: ev.recordedByUserId,
        authorOrganizationId: ev.authorOrganizationId,
        payload: ev.payload as Record<string, unknown>,
      });

      notified++;
      processed++;
    } catch (err) {
      errors.push({
        id: ev.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      processed++;
    }
  }

  // ── Step 5: Print summary ──
  const summaryPrefix = dryRun ? "[DRY-RUN] " : "";
  console.log(
    `${summaryPrefix}[backfill-eno-trigger] done — candidates=${eligible.length} processed=${processed} notified=${notified} skipped=${skipped} errors=${errors.length}`,
  );
  for (const e of errors) {
    console.warn(`  error event=${e.id}: ${e.reason}`);
  }

  // ── Step 6: Write top-level audit log entry (real run only) ──
  if (!dryRun) {
    await db.insert(auditLog).values({
      actorUserId: systemActor.id,
      action: "eno_backfill_run_completed",
      payload: {
        since: since?.toISOString() ?? null,
        until: until.toISOString(),
        limit,
        processed,
        notified,
        skipped,
        errors: errors.length,
        dry_run: false,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Entry point guard
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" && process.argv[1]?.endsWith("backfill-eno-trigger.ts");

if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-eno-trigger] fatal error:", err);
      process.exit(1);
    });
}
