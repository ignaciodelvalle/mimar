// materialize-slots.ts — slot materialization writers (strangler 28/61).
// Moved verbatim from app/actions/slot-materialization.ts.
//
// materializeAllActiveSlots(): loads ALL active rules for approved offerings,
// calls the pure generator, and bulk-inserts with an ON CONFLICT clause
// (adoptStaleSlot) that is a no-op for a slot whose rule is still live, so
// re-runs are idempotent.
//
// materializeSlotsForOffering(): same, scoped to a single offering by DB id.

import { and, asc, eq, gt, sql } from "drizzle-orm";

import { db, serviceOfferings, serviceScheduleRules, timeSlots } from "@/db";
import { type CronBudgetHeaders, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { materializeSlotsForRule } from "@/lib/infra/slot-materialization";
import { slotRuleIsLive } from "@/lib/infra/slot-rule-liveness";

// Keyset page size + per-run bounds (review 23 item 9): the sweep used to load
// ALL active rules and bulk-insert 60-day windows in one invocation, unbounded
// at province scale. Now paged over service_schedule_rules.id with a wall-clock
// budget; the route persists the cursor so the next run resumes.
const RULES_BATCH_SIZE = 200;
const MAX_RULES_PER_RUN = 5_000;
const MAX_DURATION_MS = 45_000;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function rollingWindow(): { windowStart: Date; windowEnd: Date } {
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + 60 * 24 * 60 * 60 * 1000); // +60 days
  return { windowStart, windowEnd };
}

// ────────────────────────────────────────────────────────────────────────────
// Writers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rows an INSERT … ON CONFLICT DO NOTHING actually wrote.
 *
 * postgres-js resolves an INSERT to a RowList — an array (empty here, there is
 * no RETURNING) carrying a `count` of affected rows. It has NO `rowCount`; that
 * is node-postgres's shape. Both call sites read
 * `(result as { rowCount?: number }).rowCount ?? 0` under a comment asserting
 * "rowCount is available on the pg query result". It was not: the cast made the
 * mismatch invisible to the compiler, the property was always undefined, and
 * `?? 0` turned that into a believable zero. "Materializar ahora" therefore
 * reported "Turnos nuevos: 0" while writing real slots (adversarial review
 * 2026-08-08, S3-F02), and the cron under-reported the same way.
 *
 * `count` is 0 on a pure conflict, which is exactly the idempotency signal the
 * caller wants to surface. Verified against the live driver, not inferred.
 */
/**
 * ON CONFLICT clause for both materialisers (T1-L16).
 *
 * The (service_offering_id, starts_at) unique index used to make a conflict a
 * plain no-op. Since bookSlotWriter refuses a slot whose rule no longer stands
 * (lib/infra/slot-rule-liveness.ts), a no-op would strand a REPLACEMENT rule:
 * delete Monday 9-12 and recreate it, and every Monday slot is still owned by
 * the archived rule — refused by the writer, and never re-materialised because
 * the time is taken. So a conflicting slot whose rule is no longer live is
 * ADOPTED by the rule materialising now: only `rule_id` moves. Status (an org
 * block stays blocked), capacity and bookings_count are left alone, so a slot
 * that already holds appointments keeps them. A slot owned by a live rule is
 * untouched — the WHERE makes that case the old no-op, so the daily run does
 * not churn rows. Adoptions count toward the returned `slotsInserted`.
 */
function adoptStaleSlot() {
  return {
    target: [timeSlots.serviceOfferingId, timeSlots.startsAt],
    set: { ruleId: sql`excluded.rule_id`, updatedAt: new Date() },
    setWhere: sql`NOT ${slotRuleIsLive()}`,
  };
}

function insertedRowCount(result: unknown): number {
  const count = (result as { count?: unknown }).count;
  return typeof count === "number" ? count : 0;
}

/**
 * Materializes slots for all approved offerings with active schedule rules.
 * Safe to call in a cron — idempotent via the (service_offering_id, starts_at)
 * unique index; see adoptStaleSlot for the one case a conflict writes.
 */
// @no-auth-required: cron-driven materialization, no caller identity.
// Idempotent via ON CONFLICT on (service_offering_id, starts_at).
export async function materializeAllActiveSlots(opts?: {
  /** Keyset cursor: process rules whose id sorts after this value. */
  afterRuleId?: string | null;
  /** Wall-clock budget (ms). Default 45s. */
  maxDurationMs?: number;
  /**
   * The daily dispatcher's fair share, when this runs inside the fleet
   * (RN #9 half b): the deadline becomes min(own ceiling, share handed down)
   * so a late start cannot push the shared function past its 60 s hard kill.
   * Absent (a manual curl, Vercel hitting the route directly) the constant is
   * all there is, unchanged.
   */
  budgetHeaders?: CronBudgetHeaders;
}): Promise<{
  rulesProcessed: number;
  slotsInserted: number;
  /** Resume cursor for the next run: last rule id when stopped early, else null. */
  nextCursor: string | null;
  earlyStop: boolean;
}> {
  const { windowStart, windowEnd } = rollingWindow();
  const ownCeilingMs = opts?.maxDurationMs ?? MAX_DURATION_MS;
  const maxDurationMs = opts?.budgetHeaders
    ? effectiveDeadlineMs(ownCeilingMs, opts.budgetHeaders)
    : ownCeilingMs;
  const start = Date.now();

  let rulesProcessed = 0;
  let slotsInserted = 0;
  let cursor: string | null = opts?.afterRuleId ?? null;
  let earlyStop = false;

  loop: for (;;) {
    if (rulesProcessed >= MAX_RULES_PER_RUN || Date.now() - start >= maxDurationMs) {
      earlyStop = true;
      break;
    }

    // Keyset page of active rules joined to their approved offering.
    const rows = await db
      .select({
        rule: serviceScheduleRules,
        offering: {
          id: serviceOfferings.id,
          slotCapacity: serviceOfferings.slotCapacity,
          durationMinutes: serviceOfferings.durationMinutes,
        },
      })
      .from(serviceScheduleRules)
      .innerJoin(serviceOfferings, eq(serviceScheduleRules.serviceOfferingId, serviceOfferings.id))
      .where(
        and(
          eq(serviceScheduleRules.status, "active"),
          eq(serviceOfferings.status, "approved"),
          ...(cursor ? [gt(serviceScheduleRules.id, cursor)] : []),
        ),
      )
      .orderBy(asc(serviceScheduleRules.id))
      .limit(RULES_BATCH_SIZE);

    if (rows.length === 0) break;

    for (const { rule, offering } of rows) {
      const candidates = materializeSlotsForRule({ rule, offering }, windowStart, windowEnd);
      if (candidates.length > 0) {
        const result = await db
          .insert(timeSlots)
          .values(candidates)
          .onConflictDoUpdate(adoptStaleSlot());
        slotsInserted += insertedRowCount(result);
      }
      cursor = rule.id;
      rulesProcessed += 1;
      if (rulesProcessed >= MAX_RULES_PER_RUN || Date.now() - start >= maxDurationMs) {
        earlyStop = true;
        break loop;
      }
    }

    if (rows.length < RULES_BATCH_SIZE) break; // drained
  }

  // Stopped early → resume from cursor next run; fully drained → wrap around.
  return { rulesProcessed, slotsInserted, nextCursor: earlyStop ? cursor : null, earlyStop };
}

// @no-auth-required: pure inner writer; the shim action auth-gates the caller.
/**
 * Same as materializeAllActiveSlots but scoped to one offering by DB id.
 * Used by the "Materializar ahora" button for immediate preview.
 */
export async function materializeSlotsForOffering(offeringId: string): Promise<{
  rulesProcessed: number;
  slotsInserted: number;
}> {
  const { windowStart, windowEnd } = rollingWindow();

  const rows = await db
    .select({
      rule: serviceScheduleRules,
      offering: {
        id: serviceOfferings.id,
        slotCapacity: serviceOfferings.slotCapacity,
        durationMinutes: serviceOfferings.durationMinutes,
      },
    })
    .from(serviceScheduleRules)
    .innerJoin(serviceOfferings, eq(serviceScheduleRules.serviceOfferingId, serviceOfferings.id))
    .where(
      and(
        eq(serviceScheduleRules.serviceOfferingId, offeringId),
        eq(serviceScheduleRules.status, "active"),
        eq(serviceOfferings.status, "approved"),
      ),
    );

  let slotsInserted = 0;

  for (const { rule, offering } of rows) {
    const candidates = materializeSlotsForRule({ rule, offering }, windowStart, windowEnd);
    if (candidates.length === 0) continue;

    const result = await db
      .insert(timeSlots)
      .values(candidates)
      .onConflictDoUpdate(adoptStaleSlot());

    slotsInserted += insertedRowCount(result);
  }

  return { rulesProcessed: rows.length, slotsInserted };
}
