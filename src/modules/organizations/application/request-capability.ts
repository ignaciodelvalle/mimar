// Use-case: request a capability for the current user's org membership.
//
// Auth handled by caller (Supabase session check, getActiveMemberships[length-1]).
// Caller passes the resolved `active` membership context to keep this use-case pure.

import { VET_INDIVIDUAL_IMPLICIT_CAPS } from "@/src/modules/organizations/domain/capabilities";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface RequestCapabilityRepo {
  insertGrant: OrgRepository["insertGrant"];
  adminRecipients: OrgRepository["adminRecipients"];
  findRequesterDisplayName: OrgRepository["findAccepterDisplayName"]; // same shape
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

/** The resolved active-membership context provided by the caller. */
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

export type RequestCapabilityInput = {
  userId: string;
  capability: string;
  reason: string | null;
  active: ActiveOrgContext;
};

type Deps = {
  repo: RequestCapabilityRepo;
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

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function requestCapability(
  input: RequestCapabilityInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, transaction, isUniqueViolation } = deps;
  const { active } = input;

  // Admins implicitly hold every capability — they don't need to request.
  if (active.membership.role === "admin") {
    return { ok: false, error: "Como administrador ya tenés todos los permisos." };
  }

  // vet_individual has an implicit baseline — block duplicate requests.
  if (
    active.membership.role === "vet_individual" &&
    (VET_INDIVIDUAL_IMPLICIT_CAPS as readonly string[]).includes(input.capability)
  ) {
    return { ok: false, error: "Como veterinario/a ya tenés este permiso por defecto." };
  }

  const pendingNotifications: NewNotification[] = [];

  try {
    await transaction(async (tx) => {
      const e = tx as Exec;

      await repo.insertGrant(
        {
          membershipId: active.membership.id,
          organizationId: active.organization.id,
          capability: input.capability,
          status: "pending",
          requestedReason: input.reason,
        },
        e,
      );

      // Fan out to every admin in the org.
      const admins = await repo.adminRecipients(active.organization.id, e);
      if (admins.length > 0) {
        const requesterName =
          (await repo.findRequesterDisplayName(input.userId, e)) ?? "Un miembro";
        for (const admin of admins) {
          pendingNotifications.push({
            userId: admin.userId,
            notificationType: "capability_request",
            title: `Pedido de permiso: ${labelFor(input.capability)}`,
            body: `${requesterName} solicitó el permiso "${labelFor(input.capability)}" en ${active.organization.displayName}.`,
            severity: "info",
            ctaLabel: "Revisar",
            ctaUrl: `/org/${active.organization.publicToken}/admin/permisos`,
          });
        }
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: "Ya tenés una solicitud pendiente o un permiso concedido para esto.",
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "No se pudo registrar la solicitud.",
    };
  }

  return { ok: true, value: {}, notifications: pendingNotifications };
}
