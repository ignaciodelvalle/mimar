// Regression test — /org/[orgToken]/servicios/[offeringToken] (org service
// detail page).
//
// Bug (cursor QA 2026-07-15 A1, digest 3955119939): the "occupancy next 7 days"
// query interpolated a raw JS `Date` (`next7d`) straight into a Drizzle sql``
// template. The Postgres driver throws `TypeError: Received an instance of Date`
// for that param, so the page 500'd on EVERY approved/paused offering — the list
// showed "Aprobado" but opening the detail hit the generic error boundary. Same
// bug class as the /turnos search + detail pages: serialize via `.toISOString()`
// before interpolation.
//
// This test seeds a real approved offering + a future time slot in local
// Postgres and calls the page function directly, so it exercises the real
// driver (a mocked `@/db` would not have caught the param-binding throw).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: vi.fn(),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getGrantedCapabilities: vi.fn().mockResolvedValue(new Set(["service_offering.create"])),
}));

import { db, organizations, serviceOfferings, timeSlots } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { generateOfferingToken, generatePublicToken } from "@/lib/infra/publicToken";

let orgId: string;
let orgToken: string;
let offeringId: string;
let offeringToken: string;
let slotId: string;

beforeAll(async () => {
  const [org] = await db.execute<{ id: string }>(
    sql`INSERT INTO organizations (public_token, legal_name, display_name, org_type, email, verified)
        VALUES (${generatePublicToken()}, 'Org Offering Detail Test', 'Org Offering Detail Test', 'clinic', ${`org-offering-detail-${Date.now()}@dim-test.local`}, true)
        RETURNING id`,
  );
  orgId = org.id;
  orgToken = generatePublicToken();

  offeringToken = generateOfferingToken();
  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: offeringToken,
      organizationId: orgId,
      serviceKind: "vaccination_rabies",
      displayName: "Org Offering Detail Test Campaign",
      durationMinutes: 15,
      slotCapacity: 6,
      status: "approved",
      isPublic: true,
    })
    .returning({ id: serviceOfferings.id });
  offeringId = offering.id;

  // A slot inside the [now, now+7d] occupancy window the page queries.
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 15 * 60 * 1000);
  const [slot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt,
      endsAt,
      capacity: 6,
      bookingsCount: 2,
      status: "open",
    })
    .returning({ id: timeSlots.id });
  slotId = slot.id;

  vi.mocked(requireOrgAccessByToken).mockResolvedValue({
    // Only the fields the page reads; the rest of OrgAccessSession is unused here.
    organization: { id: orgId, displayName: "Org Offering Detail Test" },
    membership: { id: "test-membership", role: "staff" },
  } as unknown as Awaited<ReturnType<typeof requireOrgAccessByToken>>);
});

afterAll(async () => {
  if (slotId) {
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

describe("OfferingDetailPage — occupancy window query", () => {
  it("renders an approved offering without throwing on the 7-day occupancy query", async () => {
    const { default: OfferingDetailPage } = await import(
      "@/app/org/[orgToken]/servicios/[offeringToken]/page"
    );

    // Before the fix, the sql`` template with a raw Date param threw a
    // TypeError from the Postgres driver before this resolved.
    const result = await OfferingDetailPage({
      params: Promise.resolve({ orgToken, offeringToken }),
    });

    expect(result).toBeTruthy();
  });
});
