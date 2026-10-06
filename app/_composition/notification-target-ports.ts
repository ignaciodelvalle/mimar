// The composition root for the notification resolver's cross-module port
// (notificaciones-destinos review, 2026-10).
//
// The resolver opens an `/org/{token}/…` section only when the page would let
// the reader in, and a few of those pages hard-gate on an org CAPABILITY
// (`/admin/permisos` on `capability.grant`). Capabilities belong to the
// `organizations` module; `notifications` importing it is a cross-module edge
// the dependency fence refuses, so the question is asked through a port and
// answered here, in the layer allowed to know both — the same arrangement
// `owner-pet-detail-ports.ts` records for the owner face.
//
// EVERY CALLER SHARES THIS OBJECT: `GET /api/v1/me/notifications/{id}/target`,
// the `/notificaciones/{id}/abrir` redirect and the explanation page.

import { and, eq, isNull } from "drizzle-orm";

import { db, organizationMemberships } from "@/db";
import type { NotificationTargetPorts } from "@/src/modules/notifications/infrastructure/notification-target-probes";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

export const notificationTargetPorts: NotificationTargetPorts = {
  async hasOrgCapability(orgId, userId, capability) {
    const [membership] = await db
      .select({ id: organizationMemberships.id, role: organizationMemberships.role })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, orgId),
          eq(organizationMemberships.userId, userId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    if (!membership) return false;
    const granted: ReadonlySet<string> = await getGrantedCapabilities(membership);
    return granted.has(capability);
  },
};
