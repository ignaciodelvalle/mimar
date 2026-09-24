// Use-case: rejectServiceOfferingForAuthority
//
// Rejects a pending service offering:
//   1. Validate rejection reason (length guards).
//   2. Load offering + its owning org's jurisdiction.
//   3. ENFORCE the actor's authority scope: admin is universal; a govt actor
//      may only reject offerings whose org falls within their assigned
//      jurisdiction(s) (fail-closed). The role guard lives in the action; the
//      jurisdiction bound is enforced HERE (where offering→org resolution is).
//   4. Validate offering state.
//   5. DB transaction:
//      a. UPDATE offering status → rejected, set rejection fields.
//      b. Notify active org members (service_offering_rejected).

import { db, notifications, organizationMemberships, organizations, serviceOfferings } from "@/db";
import { and, eq, isNull } from "drizzle-orm";

import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";

import type { AuthorityScope, ServiceOfferingResult } from "../domain/types";

export async function rejectServiceOfferingForAuthority(
  actorUserId: string,
  publicToken: string,
  rejectionReason: string,
  authority: AuthorityScope,
): Promise<ServiceOfferingResult> {
  const trimmedReason = rejectionReason.trim();
  if (!trimmedReason || trimmedReason.length < 10) {
    return { error: "El motivo del rechazo debe tener al menos 10 caracteres." };
  }
  if (trimmedReason.length > 1000) {
    return { error: "El motivo del rechazo no puede superar los 1000 caracteres." };
  }

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
          status: "rejected",
          reviewedAt: now,
          reviewedByUserId: actorUserId,
          rejectionReason: trimmedReason,
          updatedAt: now,
        })
        .where(eq(serviceOfferings.id, offering.id));

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

      // No CTA without the org's public token. The alternative was a link built
      // from organizationId, which is a uuid and 404s at /org/[orgToken]; a
      // notification whose only button is dead is worse than one with none,
      // because it reads as the product losing the thing it just told you about.
      // The join is a leftJoin, so this is a real possibility to handle rather
      // than an assertion to wave through.
      if (orgAdmins.length > 0) {
        await tx.insert(notifications).values(
          orgAdmins.map((m) => ({
            userId: m.userId,
            notificationType: "service_offering_rejected",
            title: `Servicio rechazado: ${offering.displayName}`,
            body: `Tu solicitud fue rechazada: ${trimmedReason}`,
            severity: "warning" as const,
            ...(orgPublicToken
              ? {
                  ctaLabel: "Ver mis servicios",
                  ctaUrl: `/org/${orgPublicToken}/servicios`,
                }
              : {}),
          })),
        );
      }
    });
  } catch (err) {
    return {
      error: `No se pudo rechazar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true };
}
