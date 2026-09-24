// Tests for lib/infra/outreach-reminders.ts — the "Enviar recordatorio(s)"
// write action on /gob/operativos?vista=alcance's overdue-antirrábica
// pipeline (sweep-fixes-2 2026-07-23).
//
// Covers:
//  1. A reminder (vaccine_due notification) is created for a genuinely
//     overdue, in-scope pet's active owner.
//  2. Throttle: a second call within OUTREACH_REMINDER_THROTTLE_DAYS does NOT
//     insert another notification — reported "already_notified".
//  3. Out-of-jurisdiction petId is rejected — reported "out_of_scope", no
//     notification is created (server-side re-derivation, never trusts the
//     client's pet list).
//  4. A pet with no active personal owner is reported "no_owner".
//  5. An audit_log row (action='outreach_reminder_sent') is written once per
//     invocation with honest counts.
//  6. Bulk call over a mixed batch reports sent/already_notified/out_of_scope
//     honestly in one summary.
//
// Integration tests run against local Postgres + bootstrapped schema, same
// posture as __tests__/outreach-pipelines.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, notifications, ownerships, petEvents, pets, profiles } from "@/db";
import {
  OUTREACH_REMINDER_THROTTLE_DAYS,
  sendOverdueRabiesReminders,
} from "@/lib/infra/outreach-reminders";
import { buildProjectionContext } from "@/lib/metrics";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";

const TEST_PROVINCE = "Buenos Aires";
const TEST_LOCALITY = `outreach-reminder-locality-${Date.now()}`;
const OTHER_LOCALITY = `outreach-reminder-other-locality-${Date.now()}`;

const createdProfileIds: string[] = [];
// Every pet this suite creates (via makeOverduePet or directly), tracked so
// afterAll can clean up pet_events + pets — scoped by id, never by a
// PET-RMD-* LIKE prefix that could reach another suite's fixtures.
const createdPetIds: string[] = [];
const actorId = crypto.randomUUID();

let overduePetId: string;
let overdueOwnerId: string;
let noOwnerPetId: string;
let otherJurisdictionPetId: string;
let currentPetId: string; // not overdue — must never be "sent"

async function makeOverduePet(locality: string, name: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `PET-RMD-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: locality,
    })
    .returning({ id: pets.id });
  createdPetIds.push(pet.id);
  const overdueDate = new Date(Date.now() - 400 * 86400_000);
  await db.insert(petEvents).values({
    petId: pet.id,
    eventType: "vaccination_administered",
    occurredAt: overdueDate,
    authorRole: "owner",
    payload: {
      vaccine_name: "Antirrábica",
      next_due_at: new Date(overdueDate.getTime() + 365 * 86400_000).toISOString(),
    },
  });
  return pet.id;
}

beforeAll(async () => {
  await db
    .insert(profiles)
    .values({ id: actorId, displayName: "Reminder Test Operator", role: "govt" });
  createdProfileIds.push(actorId);

  overdueOwnerId = crypto.randomUUID();
  await db
    .insert(profiles)
    .values({ id: overdueOwnerId, displayName: "Reminder Test Owner", role: "owner" });
  createdProfileIds.push(overdueOwnerId);

  overduePetId = await makeOverduePet(TEST_LOCALITY, "Overdue");
  await db.insert(ownerships).values({
    petId: overduePetId,
    ownerUserId: overdueOwnerId,
    role: "owner",
  });

  noOwnerPetId = await makeOverduePet(TEST_LOCALITY, "NoOwner");
  // Deliberately no ownerships row for this pet.

  otherJurisdictionPetId = await makeOverduePet(OTHER_LOCALITY, "OtherJuris");
  const otherOwnerId = crypto.randomUUID();
  await db
    .insert(profiles)
    .values({ id: otherOwnerId, displayName: "Other Juris Owner", role: "owner" });
  createdProfileIds.push(otherOwnerId);
  await db.insert(ownerships).values({
    petId: otherJurisdictionPetId,
    ownerUserId: otherOwnerId,
    role: "owner",
  });

  // A current (NOT overdue) pet — fetchOverdueRabiesVaccine's re-derivation
  // must exclude it even if a caller tried to slip it into the petIds list.
  const [petCurrent] = await db
    .insert(pets)
    .values({
      publicToken: `PET-RMD-CURRENT-${Date.now()}`,
      name: "Current",
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  currentPetId = petCurrent.id;
  createdPetIds.push(currentPetId);
  const recentVaccDate = new Date(Date.now() - 30 * 86400_000);
  await db.insert(petEvents).values({
    petId: currentPetId,
    eventType: "vaccination_administered",
    occurredAt: recentVaccDate,
    authorRole: "owner",
    payload: {
      vaccine_name: "Antirrábica",
      next_due_at: new Date(recentVaccDate.getTime() + 365 * 86400_000).toISOString(),
    },
  });
});

afterAll(async () => {
  // notifications.relatedPetId is ON DELETE SET NULL (not cascade — see
  // db/schema.ts) — delete explicitly, scoped per pet, so no residue
  // notification rows outlive their pet.
  for (const petId of createdPetIds) {
    await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  }

  // audit_log is append-only — GUC bypass, same pattern as
  // __tests__/outreach-pipelines.test.ts.
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, actorId));
  });

  // Each pet is deleted in its OWN transaction, scoped only by its own id —
  // never a broad PET-RMD-* prefix match. ownerships.pet_id and
  // pet_events.pet_id are both ON DELETE CASCADE from pets (db/schema.ts), so
  // once the GUC override is set for this transaction (see
  // __tests__/_helpers/db-overrides.ts), the cascade into the append-only
  // pet_events table is allowed too. Deliberately NOT one transaction over the
  // whole list — a single pet's failure must not block cleanup of the rest
  // (see scheduling-attendance.test.ts's afterAll for the incident this
  // guards against).
  for (const petId of createdPetIds) {
    try {
      await withMutationOverride(async (tx) => {
        await tx.delete(pets).where(eq(pets.id, petId));
      });
    } catch (err) {
      console.error(`outreach-reminders.test.ts afterAll: failed to clean up pet ${petId}`, err);
    }
  }

  for (const id of createdProfileIds) {
    await db.delete(profiles).where(eq(profiles.id, id));
  }
});

function govtCtx(locality: string) {
  return buildProjectionContext({ role: "govt" }, [{ province: TEST_PROVINCE, locality }], {
    since: new Date(Date.now() - 365 * 86400_000),
    until: new Date(),
  });
}

describe("sendOverdueRabiesReminders — single pet", () => {
  it("sends a vaccine_due reminder to the overdue pet's active owner", async () => {
    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      overduePetId,
    ]);

    expect(result.results).toEqual([{ petId: overduePetId, outcome: "sent" }]);
    expect(result.sentCount).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, overdueOwnerId),
          eq(notifications.relatedPetId, overduePetId),
          eq(notifications.notificationType, "vaccine_due"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("health");
    expect(rows[0].severity).toBe("urgent");
  });

  it(`throttles a second call within ${OUTREACH_REMINDER_THROTTLE_DAYS} days — no duplicate notification`, async () => {
    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      overduePetId,
    ]);

    expect(result.results).toEqual([{ petId: overduePetId, outcome: "already_notified" }]);
    expect(result.alreadyNotifiedCount).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, overdueOwnerId),
          eq(notifications.relatedPetId, overduePetId),
          eq(notifications.notificationType, "vaccine_due"),
        ),
      );
    // Still exactly one — the throttle prevented a second insert.
    expect(rows).toHaveLength(1);
  });

  it("rejects an out-of-jurisdiction petId — never trusts the client's list", async () => {
    // ctx is scoped to TEST_LOCALITY only; otherJurisdictionPetId lives in
    // OTHER_LOCALITY.
    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      otherJurisdictionPetId,
    ]);

    expect(result.results).toEqual([{ petId: otherJurisdictionPetId, outcome: "out_of_scope" }]);
    expect(result.outOfScopeCount).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.relatedPetId, otherJurisdictionPetId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a petId that is in-scope but NOT actually overdue", async () => {
    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      currentPetId,
    ]);
    expect(result.results).toEqual([{ petId: currentPetId, outcome: "out_of_scope" }]);
  });

  it("reports 'no_owner' for an overdue in-scope pet with no active personal owner", async () => {
    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      noOwnerPetId,
    ]);
    expect(result.results).toEqual([{ petId: noOwnerPetId, outcome: "no_owner" }]);
    expect(result.noOwnerCount).toBe(1);
  });

  it("writes an audit_log row per invocation with honest counts", async () => {
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, actorId), eq(auditLog.action, "outreach_reminder_sent")));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.surface).toBe("outreach_pipeline");
    expect(payload.pipeline).toBe("overdue_rabies");
    expect(typeof payload.sent_count).toBe("number");
  });
});

describe("sendOverdueRabiesReminders — bulk", () => {
  it("reports sent/already_notified/no_owner/out_of_scope honestly in one summary", async () => {
    // overduePetId was already notified in the describe block above (within
    // the throttle window) → already_notified. noOwnerPetId → no_owner.
    // otherJurisdictionPetId → out_of_scope.
    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      overduePetId,
      noOwnerPetId,
      otherJurisdictionPetId,
    ]);

    expect(result.sentCount).toBe(0);
    expect(result.alreadyNotifiedCount).toBe(1);
    expect(result.noOwnerCount).toBe(1);
    expect(result.outOfScopeCount).toBe(1);
    expect(result.results).toHaveLength(3);

    const byId = new Map(result.results.map((r) => [r.petId, r.outcome]));
    expect(byId.get(overduePetId)).toBe("already_notified");
    expect(byId.get(noOwnerPetId)).toBe("no_owner");
    expect(byId.get(otherJurisdictionPetId)).toBe("out_of_scope");
  });

  it("dedupes a repeated petId in the same bulk call", async () => {
    const freshOwnerId = crypto.randomUUID();
    await db
      .insert(profiles)
      .values({ id: freshOwnerId, displayName: "Fresh Bulk Owner", role: "owner" });
    createdProfileIds.push(freshOwnerId);
    const freshPetId = await makeOverduePet(TEST_LOCALITY, "FreshBulk");
    await db
      .insert(ownerships)
      .values({ petId: freshPetId, ownerUserId: freshOwnerId, role: "owner" });

    const result = await sendOverdueRabiesReminders(actorId, govtCtx(TEST_LOCALITY), [
      freshPetId,
      freshPetId,
    ]);

    expect(result.results).toHaveLength(1);
    expect(result.sentCount).toBe(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.relatedPetId, freshPetId),
          eq(notifications.notificationType, "vaccine_due"),
        ),
      );
    expect(rows).toHaveLength(1);

    await db.delete(notifications).where(eq(notifications.relatedPetId, freshPetId));
    await db.delete(ownerships).where(eq(ownerships.petId, freshPetId));
  });
});

describe("outreach reminders — a failed delivery is never reported as 'already avised'", () => {
  // The defect this pins: createNotification has three outcomes (inserted,
  // duplicate, dead_lettered) and this pipeline used to treat only `inserted`
  // as delivery, folding the other two into `already_notified`. The 14-day
  // throttle above already excludes everyone genuinely notified, and the dedupe
  // key is day-bucketed per owner, so in practice the only way to miss
  // `inserted` is that the write threw. The operator saw muted grey and the
  // audit row recorded the citizen as already reminded.
  //
  // Forcing a real dead-letter against live Postgres is not worth the fixture
  // it would take, and the bug was never in the database: it was in which NAME
  // the post-insert branch reaches for. So this asserts the source, in both
  // directions, so neither half can drift back.
  const SOURCE = readFileSync(
    join(import.meta.dirname, "..", "lib", "infra", "outreach-reminders.ts"),
    "utf8",
  );

  it("the post-insert branch reports delivery_failed, not already_notified", () => {
    const branch = SOURCE.match(/results\.push\(\{\s*petId,\s*outcome:\s*deliveredAny[^}]*\}\)/);
    // Non-vacuity: if the branch is refactored out of this shape the regex
    // stops matching, and an assertion over `null` would pass silently.
    expect(branch, "post-insert results.push not found — update this test").not.toBeNull();
    expect(branch?.[0]).toContain("delivery_failed");
    expect(branch?.[0]).not.toContain("already_notified");
  });

  it("still reports already_notified for the throttle, which is the honest use of that name", () => {
    // The other direction. Without this, deleting `already_notified` entirely
    // would satisfy the assertion above while destroying a real outcome.
    expect(SOURCE).toContain('outcome: "already_notified"');
  });
});
