// lib/metrics/adoption-funnel.test.ts — integration tests for
// fetchAdoptionApplicationFunnel + pure approvalRate helper.
//
// Seeds synthetic adoption_application_submitted / _resolved events (with an
// outcome breakdown and one submission outside the window) and asserts the
// funnel counts + conversion rate.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";
import { approvalRate, fetchAdoptionApplicationFunnel } from "./adoption-funnel";

const TEST_PROVINCE = "Tucumán";
const TEST_LOCALITY = "AdoptionFunnelVille";
const TOKEN = "ADO-FUN-TST-1";

const DAY_MS = 24 * 60 * 60 * 1000;
let petId: string;

async function cleanup() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${TOKEN})
    `);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${TOKEN}`);
  });
}

async function seedEvent(eventType: string, payload: Record<string, unknown>, occurredAt: Date) {
  await db.insert(petEvents).values({
    petId,
    eventType,
    occurredAt,
    payload: { payload_version: 1, ...payload },
    authorRole: "owner",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  await cleanup();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "AdoptDog",
      species: "dog",
      status: "active",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  petId = pet.id;

  const recent = new Date(Date.now() - 5 * DAY_MS);
  // 4 submissions in-window.
  for (let i = 0; i < 4; i++) {
    await seedEvent("adoption_application_submitted", {}, recent);
  }
  // 1 submission outside the window — must not count.
  await seedEvent("adoption_application_submitted", {}, new Date(Date.now() - 400 * DAY_MS));
  // Resolutions: 2 approved, 1 rejected, 1 withdrawn.
  await seedEvent("adoption_application_resolved", { outcome: "approved" }, recent);
  await seedEvent("adoption_application_resolved", { outcome: "approved" }, recent);
  await seedEvent("adoption_application_resolved", { outcome: "rejected" }, recent);
  await seedEvent("adoption_application_resolved", { outcome: "withdrawn" }, recent);
});

afterAll(cleanup);

describe("approvalRate", () => {
  it("returns null when nothing was submitted", () => {
    expect(approvalRate(0, 0)).toBeNull();
    expect(approvalRate(3, 0)).toBeNull();
  });

  it("returns approved / submitted", () => {
    expect(approvalRate(2, 4)).toBe(0.5);
    expect(approvalRate(4, 4)).toBe(1);
  });
});

describe("fetchAdoptionApplicationFunnel", () => {
  it("returns zeros/null for an empty govt scope without hitting the DB", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], windows.trailing12m());
    const result = await fetchAdoptionApplicationFunnel(ctx);
    expect(result).toEqual({
      submitted: 0,
      resolved: 0,
      approved: 0,
      rejected: 0,
      withdrawn: 0,
      conversionRate: null,
    });
  });

  it("counts in-window submissions/resolutions and the conversion rate", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      windows.trailing12m(),
    );
    const result = await fetchAdoptionApplicationFunnel(ctx);

    expect(result.submitted).toBe(4);
    expect(result.resolved).toBe(4);
    expect(result.approved).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.withdrawn).toBe(1);
    expect(result.conversionRate).toBe(0.5);
  });
});
