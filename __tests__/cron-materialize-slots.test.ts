// Cron invariants test — materialize-slots handler (P7-1).
//
// Three invariants:
//  1. Runtime window — only rules whose effectiveFrom..effectiveUntil overlaps
//     the rolling [now, now+60d] window produce slots; expired rules are skipped.
//  2. Idempotency — running twice does not duplicate slots
//     (onConflictDoNothing on (service_offering_id, starts_at)).
//  3. Recovery — if previously materialized slots are partially deleted, the
//     next run regenerates exactly the missing ones without touching the rest.
//
// Tested function: materializeAllActiveSlots() from
//   src/modules/service-offerings/application/slot-materialization/materialize-slots.ts
// (this is what the cron route delegates to; no need to invoke the HTTP route
// for behavior coverage).

import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, serviceOfferings, serviceScheduleRules, timeSlots } from "@/db";
import { generatePrefixedToken, generatePublicToken } from "@/lib/infra/publicToken";
import {
  materializeAllActiveSlots,
  materializeSlotsForOffering,
} from "@/src/modules/service-offerings/application/slot-materialization/materialize-slots";

// ---------------------------------------------------------------------------
// Fixture IDs collected during setup so afterAll can clean up.
// ---------------------------------------------------------------------------

const createdOfferingIds: string[] = [];
const createdOrgIds: string[] = [];

// ---------------------------------------------------------------------------
// Helper: insert a minimal org + approved offering + one active schedule rule.
// Returns the offering id and rule id so tests can query time_slots directly.
// ---------------------------------------------------------------------------

async function makeOfferingWithRule(opts: {
  /** ISO date string for effectiveFrom (YYYY-MM-DD) */
  effectiveFrom: string;
  /** ISO date string for effectiveUntil, or null for open-ended */
  effectiveUntil: string | null;
  /** Days-of-week (ISO 8601: 1=Mon…7=Sun). Defaults to [1,2,3,4,5] */
  daysOfWeek?: number[];
  /** Whether the offering status should be 'approved'. Defaults to true. */
  approved?: boolean;
}): Promise<{ offeringId: string; ruleId: string }> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: `Slots Test Org ${Date.now()}`,
      displayName: `Slots Test Org ${Date.now()}`,
      orgType: "shelter",
      email: `slots-test-${Date.now()}@dim-test.local`,
      verified: true,
    })
    .returning({ id: organizations.id });
  createdOrgIds.push(org.id);

  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: generatePrefixedToken("OFR"),
      organizationId: org.id,
      serviceKind: "veterinary_consult",
      displayName: "Slots Test Consult",
      durationMinutes: 30,
      slotCapacity: 1,
      status: opts.approved === false ? "pending_approval" : "approved",
    })
    .returning({ id: serviceOfferings.id });
  createdOfferingIds.push(offering.id);

  const [rule] = await db
    .insert(serviceScheduleRules)
    .values({
      serviceOfferingId: offering.id,
      daysOfWeek: opts.daysOfWeek ?? [1, 2, 3, 4, 5],
      startTimeLocal: "09:00",
      endTimeLocal: "12:00",
      effectiveFrom: opts.effectiveFrom,
      effectiveUntil: opts.effectiveUntil,
      timezone: "America/Argentina/Buenos_Aires",
      status: "active",
    })
    .returning({ id: serviceScheduleRules.id });

  return { offeringId: offering.id, ruleId: rule.id };
}

// ---------------------------------------------------------------------------
// Build a date string ± N days from today (UTC midnight, YYYY-MM-DD)
// ---------------------------------------------------------------------------

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Nothing to seed globally — each test creates its own fixtures.
});

afterAll(async () => {
  // Cascades: time_slots → (service_offering_id FK cascade) → service_offerings
  // → (organization_id FK cascade) → organizations.
  // Deleting the offering cascades slots + rules.
  for (const id of createdOfferingIds) {
    await db
      .delete(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, id))
      .catch(() => {});
    await db
      .delete(serviceScheduleRules)
      .where(eq(serviceScheduleRules.serviceOfferingId, id))
      .catch(() => {});
    await db
      .delete(serviceOfferings)
      .where(eq(serviceOfferings.id, id))
      .catch(() => {});
  }
  for (const id of createdOrgIds) {
    await db
      .delete(organizations)
      .where(eq(organizations.id, id))
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("materializeAllActiveSlots", () => {
  it("runtime window — active rule produces slots; expired rule (effectiveUntil in the past) is skipped", async () => {
    // Expired rule: effectiveFrom and effectiveUntil both in the past. The
    // rolling window starts at ~now, so no matching dates exist.
    const { offeringId: expiredId } = await makeOfferingWithRule({
      effectiveFrom: dateOffset(-90),
      effectiveUntil: dateOffset(-30),
    });

    // Active rule: effectiveFrom today, open-ended. Should generate slots
    // for every matching weekday in the next 60 days.
    const { offeringId: activeId } = await makeOfferingWithRule({
      effectiveFrom: dateOffset(0),
      effectiveUntil: null,
    });

    const result = await materializeAllActiveSlots();
    expect(result.rulesProcessed).toBeGreaterThanOrEqual(2);

    // The active offering must have at least one slot in the DB.
    const [activeCount] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, activeId));
    expect(activeCount.n).toBeGreaterThan(0);

    // The expired offering must have zero slots.
    const [expiredCount] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, expiredId));
    expect(expiredCount.n).toBe(0);
  });

  it("idempotency — running twice produces no duplicate slots", async () => {
    const { offeringId } = await makeOfferingWithRule({
      effectiveFrom: dateOffset(0),
      effectiveUntil: null,
    });

    const first = await materializeAllActiveSlots();
    expect(first.rulesProcessed).toBeGreaterThanOrEqual(1);

    const [countAfterFirst] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));
    const slotsAfterFirst = countAfterFirst.n;
    expect(slotsAfterFirst).toBeGreaterThan(0);

    const second = await materializeAllActiveSlots();
    expect(second.rulesProcessed).toBeGreaterThanOrEqual(1);

    const [countAfterSecond] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));
    // The per-offering slot count must be identical after the second run — no
    // duplicates for THIS offering. We intentionally avoid asserting
    // `slotsInserted === 0` because that is a global counter across all active
    // offerings in the DB and can be non-zero due to other offerings or a
    // day-boundary insertion, causing false failures.
    expect(countAfterSecond.n).toBe(slotsAfterFirst);
  });

  // S3-F02 (2026-08-08): "Materializar ahora" reported "Turnos nuevos: 0" and
  // the operator then found the slots on the public page. The counter read
  // `(result as { rowCount?: number }).rowCount ?? 0`, under a comment claiming
  // "rowCount is available on the pg query result" — but this repo runs
  // postgres-js, whose RowList exposes `count`, not `rowCount`. The cast hid the
  // mismatch from the compiler and `?? 0` turned the undefined into a
  // believable zero.
  //
  // Every existing test here counts ROWS IN THE DATABASE, deliberately (see the
  // note in the idempotency case above). That is exactly why this survived: the
  // suite proved the work happened and nobody checked that the number reported
  // back was true. This one compares the two.
  it("reports the number of slots it actually inserted, not zero", async () => {
    const { offeringId } = await makeOfferingWithRule({
      effectiveFrom: dateOffset(0),
      effectiveUntil: null,
    });

    // Per-offering (not the global cron path) so the count is deterministic
    // regardless of what else lives in the local DB.
    const result = await materializeSlotsForOffering(offeringId);

    const [persisted] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));

    expect(persisted.n).toBeGreaterThan(0);
    expect(result.slotsInserted, "the reported count must match the rows actually written").toBe(
      persisted.n,
    );
  });

  it("reports 0 on a re-run that inserts nothing", async () => {
    // The other direction: a counter hard-wired to `candidates.length` would
    // pass the test above and then claim it created slots it only conflicted
    // with. 0 here is the honest idempotency signal.
    const { offeringId } = await makeOfferingWithRule({
      effectiveFrom: dateOffset(0),
      effectiveUntil: null,
    });

    const first = await materializeSlotsForOffering(offeringId);
    expect(first.slotsInserted).toBeGreaterThan(0);

    const second = await materializeSlotsForOffering(offeringId);
    expect(second.slotsInserted).toBe(0);
  });

  it("recovery — partial deletion of materialized slots is fully repaired on the next run", async () => {
    const { offeringId, ruleId } = await makeOfferingWithRule({
      effectiveFrom: dateOffset(0),
      effectiveUntil: null,
    });

    // First pass — materialize the full window.
    await materializeAllActiveSlots();

    const [fullCount] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));
    const fullSlots = fullCount.n;
    expect(fullSlots).toBeGreaterThan(1); // need at least 2 to delete some

    // Simulate a "partial prior run" by deleting roughly half the slots.
    // We delete the earliest (MIN starts_at) batch for this offering.
    const allSlots = await db
      .select({ id: timeSlots.id })
      .from(timeSlots)
      .where(and(eq(timeSlots.serviceOfferingId, offeringId), eq(timeSlots.ruleId, ruleId)))
      .limit(Math.floor(fullSlots / 2));

    for (const s of allSlots) {
      await db.delete(timeSlots).where(eq(timeSlots.id, s.id));
    }

    const [deletedCount] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));
    expect(deletedCount.n).toBeLessThan(fullSlots);

    // Recovery run — must restore the deleted slots.
    await materializeAllActiveSlots();

    const [recoveredCount] = await db
      .select({ n: count() })
      .from(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId));
    expect(recoveredCount.n).toBe(fullSlots);
  });
});
