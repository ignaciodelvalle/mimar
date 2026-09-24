// Public-facing offerings for /refugios/[orgToken] (handoff P2-1 + P2-5).
//
// Returns only offerings the org explicitly marked is_public=true (default
// false per privacy-first, handoff P1-3). Orders by free first, then by
// nearest available slot, then by name (slot-sort placeholder until the
// scheduling lookup lands).
//
// Consumed by the ServicesPanel (P2-5) — no rendering today. Lives here
// so the data layer is in place when the panel ships.

import { and, asc, desc, eq } from "drizzle-orm";

import { db, organizations, serviceOfferings } from "@/db";

export type PublicServiceOffering = {
  offeringToken: string;
  title: string;
  serviceKind: string;
  description: string | null;
  free: boolean;
  durationMinutes: number;
  /** Per P2-5: when null AND requiresAppointment, surface a "Sin agenda
   * activa" badge. We default to true here; richer status fields land
   * with the scheduling lookup. */
  requiresAppointment: boolean;
  /** Always null until the next-slot lookup lands. */
  nextAvailableSlot: Date | null;
};

export async function queryPublicOfferings(
  orgToken: string,
  opts: { limit?: number } = {},
): Promise<PublicServiceOffering[]> {
  const limit = opts.limit ?? 8;

  const rows = await db
    .select({
      offeringToken: serviceOfferings.publicToken,
      title: serviceOfferings.displayName,
      serviceKind: serviceOfferings.serviceKind,
      description: serviceOfferings.description,
      priceArs: serviceOfferings.priceArs,
      durationMinutes: serviceOfferings.durationMinutes,
    })
    .from(serviceOfferings)
    .innerJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .where(
      and(
        eq(organizations.publicToken, orgToken),
        eq(serviceOfferings.status, "approved"),
        eq(serviceOfferings.isPublic, true),
      ),
    )
    .orderBy(asc(serviceOfferings.priceArs), desc(serviceOfferings.submittedAt))
    .limit(limit);

  return rows.map((r) => ({
    offeringToken: r.offeringToken,
    title: r.title,
    serviceKind: r.serviceKind,
    description: r.description,
    free: r.priceArs === null || Number(r.priceArs) === 0,
    durationMinutes: r.durationMinutes,
    requiresAppointment: true,
    nextAvailableSlot: null,
  }));
}
