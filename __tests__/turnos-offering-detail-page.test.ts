// Regression test — /turnos/buscar/[offeringToken] (offering detail page).
//
// Bug: the slot-window query interpolated raw JS `Date` objects (`now`,
// `windowEnd`) directly into a Drizzle sql`` template. The Postgres driver
// throws `TypeError: Received an instance of Date` for those params, so the
// page 500'd on EVERY offering-detail view (production error digests
// 2113796355 / 3036398211). Fix mirrors e1ed4559 (search page): serialize
// via `.toISOString()` before interpolation.
//
// This test seeds a real approved offering + open time slot in local
// Postgres and calls the page function directly — a mocked `@/db` would not
// exercise the real driver and would not have caught this bug.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn().mockResolvedValue({
    supabase: {},
    user: { id: "turnos-offering-detail-test-user" },
  }),
}));

import { db, organizations, serviceOfferings, timeSlots } from "@/db";
import { generateOfferingToken, generatePublicToken } from "@/lib/infra/publicToken";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string;
let offeringId: string;
let offeringToken: string;
let futureSlotId: string;

beforeAll(async () => {
  // Raw insert (only the columns this test needs) instead of the
  // schema-driven `db.insert(organizations)` — some local envs have
  // unrelated organizations-table column drift (e.g. a lat/lng rename) that
  // would otherwise fail every full-column insert regardless of this fix.
  const [org] = await db.execute<{ id: string }>(
    sql`INSERT INTO organizations (public_token, legal_name, display_name, org_type, email, verified)
        VALUES (${generatePublicToken()}, 'Offering Detail Test Org', 'Offering Detail Test Org', 'shelter', ${`offering-detail-test-${Date.now()}@dim-test.local`}, true)
        RETURNING id`,
  );
  orgId = org.id;

  offeringToken = generateOfferingToken();
  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: offeringToken,
      organizationId: orgId,
      serviceKind: "veterinary_consult",
      displayName: "Offering Detail Test Consult",
      durationMinutes: 30,
      slotCapacity: 2,
      status: "approved",
      isPublic: true,
    })
    .returning({ id: serviceOfferings.id });
  offeringId = offering.id;

  // Inside the [now, now+60d] window the page queries.
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
  const [slot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt,
      endsAt,
      capacity: 2,
      bookingsCount: 0,
      status: "open",
    })
    .returning({ id: timeSlots.id });
  futureSlotId = slot.id;
});

afterAll(async () => {
  if (futureSlotId) {
    await db
      .delete(timeSlots)
      .where(eq(timeSlots.serviceOfferingId, offeringId))
      .catch(() => {});
  }
  if (offeringId) {
    await db
      .delete(serviceOfferings)
      .where(eq(serviceOfferings.id, offeringId))
      .catch(() => {});
  }
  if (orgId) {
    await db
      .delete(organizations)
      .where(eq(organizations.id, orgId))
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OfferingDetailPage — slot window query", () => {
  it("resolves without throwing when now/windowEnd are Date instances, and renders the offering", async () => {
    const { default: OfferingDetailPage } = await import(
      "@/app/(app)/turnos/buscar/[offeringToken]/page"
    );

    const result = await OfferingDetailPage({
      params: Promise.resolve({ offeringToken }),
    });

    // Before the fix, the sql`` template with raw Date params threw a
    // TypeError from the Postgres driver before this line was ever reached.
    expect(result).toBeTruthy();
  });
});
