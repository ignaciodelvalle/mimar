// Use-case: admin-initiated direct capability grant (no prior request required).
//
// Auth handled by caller: Supabase session + requireCapability("capability.grant", orgId).
// Caller passes the resolved `active` context and `granted` set — same contract as decideCapability.
//
// Grant lifecycle for admin-initiated grants:
//   - Inserts a row with status="approved" + decidedAt/decidedByUserId set immediately.
//   - requestedReason is null (no prior request); the row is both the request and decision.
//   - The unique partial index (status IN ('pending','approved')) prevents duplicate active
//     grants — the same uniqueness guarantee that applies to the member-request path.

import {
  COORDINATOR_IMPLICIT_CAPS,
  VET_INDIVIDUAL_IMPLICIT_CAPS,
  isValidCapability,
} from "@/src/modules/organizations/domain/capabilities";
import { assertNotSelfGrant } from "@/src/modules/organizations/domain/self-grant";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface GrantCapabilityRepo {
  findActiveMembership: OrgRepository["findActiveMembership"];
  insertGrant: OrgRepository["insertGrant"];
  updateGrant: OrgRepository["updateGrant"];
  findGrantMemberUserId: OrgRepository["findGrantMemberUserId"];
  insertAuditLog: OrgRepository["insertAuditLog"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

type ActiveOrgContext = {
  organization: {
    id: string;
    displayName: string;
    publicToken: string;
  };
  membership: {
    id: string;
    role: string;
    organizationId: string;
  };
};

export type GrantCapabilityInput = {
  /** The admin (or capability.grant holder) performing the action. */
  granterId: string;
  /** Target membership to receive the grant. */
  membershipId: string;
  capability: string;
  active: ActiveOrgContext;
  granted: Set<string>;
};

type Deps = {
  repo: GrantCapabilityRepo;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  isUniqueViolation: (err: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Notification labels — mirrors NOTIFICATION_LABELS in decide-capability.ts
// ---------------------------------------------------------------------------

const NOTIFICATION_LABELS: Record<string, string> = {
  "pet.read_held": "Ver mascotas en custodia",
  "intake.create": "Registrar ingresos",
  "foster.assign": "Asignar tránsitos",
  "foster.end": "Finalizar tránsitos",
  "adoption.review": "Revisar adopciones",
  "adoption.finalize": "Finalizar adopciones",
  "custody.transfer": "Transferir custodia",
  "event.write": "Registrar eventos clínicos",
  "member.invite": "Invitar miembros",
  "capability.grant": "Aprobar permisos",
  "service_offering.create": "Publicar servicios",
  "appointment.manage": "Gestionar turnos",
  "bite.report": "Reportar mordeduras",
  "adoption.listing.manage": "Publicar adopciones",
  "org.transfer.propose": "Proponer transferencias entre orgs",
  "org.transfer.accept": "Aceptar transferencias entre orgs",
};

function labelFor(capability: string): string {
  return NOTIFICATION_LABELS[capability] ?? capability;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function grantCapability(
  input: GrantCapabilityInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, transaction, isUniqueViolation } = deps;

  // Auth: caller must hold capability.grant.
  if (!input.granted.has("capability.grant")) {
    return { ok: false, error: "No tenés permiso para conceder capacidades." };
  }

  // Validate capability exists in catalog.
  if (!isValidCapability(input.capability)) {
    return { ok: false, error: "Permiso no reconocido." };
  }

  const capability = input.capability;

  // Load and validate the target membership.
  const targetMembership = await repo.findActiveMembership(
    input.active.organization.id,
    input.membershipId,
  );
  if (!targetMembership) {
    return { ok: false, error: "El miembro no pertenece a esta organización o no está activo." };
  }

  // H2 — four eyes. AFTER the membership lookup (so "not a member of this org"
  // still wins, and the refusal names the real problem) and BEFORE the
  // transaction, so a refused self-grant leaves no row and no audit entry.
  //
  // The comparison reads `targetMembership.userId`, not `input.membershipId`:
  // one person can hold two membership rows in the same org (leave, rejoin, or
  // an admin opening a second seat), and comparing seats would let them grant
  // themselves a capability through the other one and call it four eyes.
  const fourEyes = assertNotSelfGrant(input.granterId, targetMembership.userId);
  if (!fourEyes.ok) return { ok: false, error: fourEyes.error };

  // Block granting to admin role — they already have every capability implicitly.
  if (targetMembership.role === "admin") {
    return {
      ok: false,
      error: "Los administradores ya tienen todos los permisos por su rol.",
    };
  }

  // Block granting a capability the target role already holds implicitly.
  const vetImplicit = VET_INDIVIDUAL_IMPLICIT_CAPS as readonly string[];
  const coordImplicit = COORDINATOR_IMPLICIT_CAPS as readonly string[];
  if (
    (targetMembership.role === "vet_individual" && vetImplicit.includes(capability)) ||
    (targetMembership.role === "coordinator" && coordImplicit.includes(capability))
  ) {
    return {
      ok: false,
      error: "Este miembro ya tiene ese permiso por su rol (implícito).",
    };
  }

  const now = new Date();
  const pendingNotifications: NewNotification[] = [];

  try {
    await transaction(async (tx) => {
      const e = tx as Exec;

      // Insert directly as "approved" — this is an admin-initiated grant.
      // requestedReason is null (no prior member request).
      const grant = await repo.insertGrant(
        {
          membershipId: input.membershipId,
          organizationId: input.active.organization.id,
          capability,
          status: "approved",
          requestedReason: null,
        },
        e,
      );

      // Stamp the decided-by metadata on the same row within the same tx.
      await repo.updateGrant(
        grant.id,
        {
          status: "approved",
          decidedAt: now,
          decidedByUserId: input.granterId,
          decisionReason: null,
        },
        e,
      );

      // Lote B1 — a direct grant is answerable in audit_log like any other
      // capability decision.
      await repo.insertAuditLog(
        {
          actorUserId: input.granterId,
          action: "capability_granted",
          targetOrganizationId: input.active.organization.id,
          payload: {
            org_id: input.active.organization.id,
            grant_id: grant.id,
            membership_id: input.membershipId,
            capability,
            reason: null,
          },
        },
        e,
      );

      // Notify the recipient.
      const recipientUserId = await repo.findGrantMemberUserId(input.membershipId, e);
      if (recipientUserId) {
        pendingNotifications.push({
          userId: recipientUserId,
          notificationType: "capability_granted",
          title: `Nuevo permiso: ${labelFor(capability)}`,
          // NOT "Un administrador de …" (H2, 2026-08-22). Two things were wrong
          // with that sentence: the granter may be a coordinator holding
          // `capability.grant` rather than an admin, and while self-grant was
          // possible it doubled as a cover story — the recipient reading "un
          // administrador te concedió" could be the person who granted it to
          // themselves. The org is the actor the recipient can act on.
          body: `${input.active.organization.displayName} te concedió el permiso "${labelFor(capability)}".`,
          severity: "success",
          ctaLabel: "Ver panel",
          ctaUrl: `/org/${input.active.organization.publicToken}`,
        });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: "Este miembro ya tiene un permiso activo o pendiente para esta capacidad.",
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo conceder el permiso.",
    };
  }

  return { ok: true, value: {}, notifications: pendingNotifications };
}
