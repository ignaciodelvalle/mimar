// Use-case: approveServiceOfferingForAuthority
//
// Approves a pending service offering:
//   1. Load offering + its owning org's jurisdiction.
//   2. ENFORCE the actor's authority scope: admin is universal; a govt actor
//      may only approve offerings whose org falls within their assigned
//      jurisdiction(s) (fail-closed). The role guard lives in the action, but
//      the jurisdiction bound is enforced HERE because this is where the
//      offering→org→jurisdiction resolution happens.
//   3. Validate offering state.
//   4. DB transaction:
//      a. UPDATE offering status → approved, set reviewedAt / reviewedByUserId.
//      b. Notify active org members (service_offering_approved).

import { db, notifications, organizationMemberships, organizations, serviceOfferings } from "@/db";
import { and, eq, isNull } from "drizzle-orm";

import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";

import type { AuthorityScope, ServiceOfferingResult } from "../domain/types";

export async function approveServiceOfferingForAuthority(
  actorUserId: string,
  publicToken: string,
  authority: AuthorityScope,
): Promise<ServiceOfferingResult> {
  const [row] = await db
    .select({
      offering: serviceOfferings,
      orgProvince: organizations.jurisdictionProvince,
      orgLocality: organizations.jurisdictionLocality,
      // The notification CTA needs the org's PUBLIC token: /org/[orgToken] does
      // not resolve a uuid. `organizations` is already joined, so it is free.
      orgPublicToken: organizations.publicToken,
    })
    .from(serviceOfferings)
    .leftJoin(organizations, eq(serviceOfferings.organizationId, organizations.id))
    .where(eq(serviceOfferings.publicToken, publicToken))
    .limit(1);
  if (!row) return { error: "Servicio no encontrado." };
  const { offering, orgProvince, orgLocality, orgPublicToken } = row;

  // Jurisdiction enforcement (before the status check, so an out-of-scope govt
  // learns nothing about the offering's state). Admin is universal.
  if (
    authority.role === "govt" &&
    !jurisdictionScopeContains(authority.jurisdictions, orgProvince, orgLocality)
  ) {
    return { error: "Este servicio no está en tu jurisdicción asignada." };
  }

  if (offering.status !== "pending_approval") {
    return { error: `El servicio ya está en estado "${offering.status}".` };
  }

  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(serviceOfferings)
        .set({
          status: "approved",
          reviewedAt: now,
          reviewedByUserId: actorUserId,
          updatedAt: now,
        })
        .where(eq(serviceOfferings.id, offering.id));

      // Notify active org members with admin role (they submitted / manage the offering).
      const orgAdmins = await tx
        .select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            // biome-ignore lint/style/noNonNullAssertion: org-scoped offering rows always have organizationId.
            eq(organizationMemberships.organizationId, offering.organizationId!),
            isNull(organizationMemberships.leftAt),
          ),
        );

      if (orgAdmins.length > 0) {
        await tx.insert(notifications).values(
          orgAdmins.map((m) => ({
            userId: m.userId,
            notificationType: "service_offering_approved",
            title: `Servicio aprobado: ${offering.displayName}`,
            body: "Ya podés crear la agenda y empezar a recibir reservas.",
            severity: "success" as const,
            // See reject-service-offering.ts: no CTA rather than a uuid-built
            // one that 404s. This is the worse of the two to get wrong, because
            // the whole point of the message is "ahora podés configurar esto".
            ...(orgPublicToken
              ? {
                  ctaLabel: "Gestionar agenda",
                  ctaUrl: `/org/${orgPublicToken}/servicios/${publicToken}`,
                }
              : {}),
          })),
        );
      }
    });
  } catch (err) {
    return {
      error: `No se pudo aprobar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true };
}
