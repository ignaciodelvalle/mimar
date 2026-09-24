// Use-case: decide (approve / deny / revoke) a capability grant request.
//
// Auth handled by caller: live session + requireOrgAccessByToken(orgToken from
// the form — the org whose panel is open, never the session default) +
// getGrantedCapabilities. Caller passes the resolved `active` context and `granted` set.

import { isValidCapability } from "@/src/modules/organizations/domain/capabilities";
import { canDecide } from "@/src/modules/organizations/domain/membership-state";
import { assertNotSelfGrant } from "@/src/modules/organizations/domain/self-grant";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface DecideCapabilityRepo {
  findGrant: OrgRepository["findGrant"];
  updateGrant: OrgRepository["updateGrant"];
  setGrantStatus: OrgRepository["setGrantStatus"];
  findGrantMemberUserId: OrgRepository["findGrantMemberUserId"];
  insertAuditLog: OrgRepository["insertAuditLog"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

type Decision = "approved" | "denied" | "revoked";

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

export type DecideCapabilityInput = {
  deciderId: string;
  grantId: string;
  decision: Decision;
  reason: string | null;
  active: ActiveOrgContext;
  granted: Set<string>;
};

type Deps = {
  repo: DecideCapabilityRepo;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  isUniqueViolation: (err: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Notification helpers
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

const DECISION_VERBS: Record<Decision, { verb: string; severity: "success" | "warning" | "info" }> =
  {
    approved: { verb: "aprobado", severity: "success" },
    denied: { verb: "denegado", severity: "warning" },
    revoked: { verb: "revocado", severity: "warning" },
  };

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function decideCapability(
  input: DecideCapabilityInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, transaction, isUniqueViolation } = deps;

  // Check actor has capability.grant permission.
  if (!input.granted.has("capability.grant")) {
    return { ok: false, error: "No tenés permiso para decidir solicitudes." };
  }

  // Load the grant.
  const grant = await repo.findGrant(input.grantId);
  if (!grant) {
    return { ok: false, error: "Solicitud no encontrada." };
  }

  // Auth scope guard — prevent cross-org decisions.
  if (grant.organizationId !== input.active.organization.id) {
    return { ok: false, error: "Esa solicitud pertenece a otra organización." };
  }

  // State machine guard.
  if (!canDecide(grant.status as "pending" | "approved" | "denied" | "revoked", input.decision)) {
    return { ok: false, error: "La solicitud ya está en un estado terminal." };
  }

  // Validate capability still exists in catalog.
  if (!isValidCapability(grant.capability)) {
    return { ok: false, error: "La solicitud apunta a un permiso desconocido." };
  }

  const capability = grant.capability;

  // H2 — four eyes. AFTER the scope and state guards so a cross-org or
  // already-decided grant still gets its own (more accurate) refusal, and
  // BEFORE the transaction so a refused self-decision leaves no status change
  // and no audit row describing a decision that never happened.
  //
  // Deliberately covers revoke too: self-revocation is harmless today, but the
  // rule "the beneficiary is never the decider" is easier to keep true than a
  // per-decision carve-out, and a revoke you granted yourself is a way to erase
  // the row that would have shown you granting it.
  //
  // Compares USERS, not membership ids — see domain/self-grant.ts.
  const beneficiaryUserId = await repo.findGrantMemberUserId(grant.membershipId);
  const fourEyes = assertNotSelfGrant(input.deciderId, beneficiaryUserId);
  if (!fourEyes.ok) return { ok: false, error: fourEyes.error };

  const pendingNotifications: NewNotification[] = [];

  try {
    await transaction(async (tx) => {
      const e = tx as Exec;

      if (input.decision === "revoked") {
        // Lote B1 — revoke must NOT overwrite decidedAt/By/Reason: those are
        // the provenance of who originally GRANTED the capability. The
        // revocation's own who/when/why lives in the audit_log row below.
        await repo.setGrantStatus(input.grantId, "revoked", e);
      } else {
        // First-ever decision on the row — no provenance to protect.
        await repo.updateGrant(
          input.grantId,
          {
            status: input.decision,
            decidedAt: new Date(),
            decidedByUserId: input.deciderId,
            decisionReason: input.reason,
          },
          e,
        );
      }

      // Lote B1 — every capability decision is answerable in audit_log
      // (there was NO capability.* action before; a revoke erased the
      // approver with zero trace).
      const actionByDecision = {
        approved: "capability_granted",
        denied: "capability_denied",
        revoked: "capability_revoked",
      } as const;
      await repo.insertAuditLog(
        {
          actorUserId: input.deciderId,
          action: actionByDecision[input.decision],
          targetOrganizationId: input.active.organization.id,
          payload: {
            org_id: input.active.organization.id,
            grant_id: input.grantId,
            membership_id: grant.membershipId,
            capability,
            reason: input.reason,
            ...(input.decision === "revoked"
              ? {
                  revoked_by_user_id: input.deciderId,
                  revoked_at: new Date().toISOString(),
                  original_decided_by_user_id: grant.decidedByUserId,
                  original_decided_at: grant.decidedAt?.toISOString() ?? null,
                }
              : {}),
          },
        },
        e,
      );

      // Notify requester.
      const requesterUserId = await repo.findGrantMemberUserId(grant.membershipId, e);
      if (requesterUserId) {
        const { verb, severity } = DECISION_VERBS[input.decision];
        pendingNotifications.push({
          userId: requesterUserId,
          notificationType: `capability_${input.decision}`,
          title: `Permiso ${verb}: ${labelFor(capability)}`,
          body: input.reason
            ? `Tu solicitud para "${labelFor(capability)}" en ${input.active.organization.displayName} fue ${verb}. Motivo: ${input.reason}`
            : `Tu solicitud para "${labelFor(capability)}" en ${input.active.organization.displayName} fue ${verb}.`,
          severity,
          ctaLabel: "Ver panel",
          ctaUrl: `/org/${input.active.organization.publicToken}`,
        });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "Otro permiso ya está activo para este miembro." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo actualizar la solicitud.",
    };
  }

  return { ok: true, value: {}, notifications: pendingNotifications };
}
