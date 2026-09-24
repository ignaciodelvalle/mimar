// Pure capability helpers — no DB imports, no Next.js imports.
// DB and Supabase logic lives in infrastructure/authz-resolver.ts.
//
// Baseline model:
//   - admin          → ALL ORGANIZATION_CAPABILITIES (universal grant)
//   - vet_individual → VET_INDIVIDUAL_IMPLICIT_CAPS ∪ approved grants
//   - coordinator    → COORDINATOR_IMPLICIT_CAPS ∪ approved grants
//   - others         → only approved grant rows (isValidCapability-filtered)
//
// Pure symbols: importers should use this module directly.
// I/O symbols (requireCapability, getGrantedCapabilities, getActiveMemberships)
// live in infrastructure/authz-resolver.ts.

import { ORGANIZATION_CAPABILITIES, type OrganizationCapability } from "@/db/schema";

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

export type CapabilityCatalogEntry = {
  capability: OrganizationCapability;
  label: string;
  description: string;
};

// ---------------------------------------------------------------------------
// Capability catalog — user-facing Spanish copy for in-product UI.
// Ordered roughly by lifecycle: read → intake → foster → adoption →
// transfer → admin. The shim re-exports this for all current importers.
// ---------------------------------------------------------------------------

export const CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    capability: "pet.read_held",
    label: "Ver mascotas en custodia",
    description:
      "Acceder al listado de animales que la organización tiene en custodia, foster o adoptados.",
  },
  {
    capability: "intake.create",
    label: "Registrar ingreso (intake)",
    description:
      "Dar de alta animales que entran en custodia de la organización (rescate, decomiso, abandono, encontrado).",
  },
  {
    capability: "foster.assign",
    label: "Asignar tránsito (foster)",
    description: "Asignar un animal en custodia a un voluntario para tránsito hogareño.",
  },
  {
    capability: "foster.end",
    label: "Finalizar tránsito",
    description:
      "Cerrar una asignación de tránsito y devolver el animal a la custodia del refugio.",
  },
  {
    capability: "adoption.review",
    label: "Revisar solicitudes de adopción",
    description: "Ver, evaluar y aprobar o rechazar solicitudes de adopción.",
  },
  {
    capability: "adoption.finalize",
    label: "Finalizar adopciones",
    description:
      "Concretar una adopción: cerrar custodia, registrar al adoptante como nuevo dueño.",
  },
  {
    capability: "custody.transfer",
    label: "Transferir custodia",
    description:
      "Pasar la custodia de un animal a otra organización o persona, fuera del flujo de adopción.",
  },
  {
    capability: "event.write",
    label: "Registrar eventos clínicos",
    description:
      "Anotar vacunas, desparasitaciones, cirugías y otros eventos médicos en animales de la organización.",
  },
  {
    capability: "member.invite",
    label: "Invitar miembros",
    description: "Sumar nuevos voluntarios o empleados a la organización.",
  },
  {
    capability: "capability.grant",
    label: "Aprobar permisos",
    description:
      "Decidir sobre las solicitudes de capacidades del resto del equipo (lo que los admins hacen).",
  },
  // Scheduling system (Fase 0). Not in VET_INDIVIDUAL_IMPLICIT_CAPS: service
  // providers earn these via the approval flow (intentional per spec D8).
  {
    capability: "service_offering.create",
    label: "Publicar servicios",
    description:
      "Crear solicitudes de servicios (vacunaciones, castraciones, etc.) para que la autoridad las apruebe.",
  },
  {
    capability: "appointment.manage",
    label: "Gestionar turnos",
    description:
      "Ver las reservas del día, registrar asistencia, marcar ausencias y cancelar turnos desde el portal.",
  },
  {
    capability: "bite.report",
    label: "Reportar mordeduras",
    description:
      "Registrar mordeduras presenciadas o conocidas clínicamente. Inicia automáticamente la observación antirrábica de 10 días (Decreto 4669/1973 PBA).",
  },
  {
    capability: "adoption.listing.manage",
    label: "Publicar adopciones",
    description:
      "Publicar, pausar y editar el contenido de adopción que se ve en /adoptar (historia, requisitos, edad, talle, energía).",
  },
] as const;

// ---------------------------------------------------------------------------
// Govt-level capability (NOT in ORGANIZATION_CAPABILITIES).
// Govt-authority-level capability granted outside the standard org capability set.
// ---------------------------------------------------------------------------

export const WELFARE_DECOMISO_EXECUTE_CAPABILITY = "welfare.decomiso.execute" as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CAPABILITY_SET = new Set<string>(ORGANIZATION_CAPABILITIES);

/** Returns true iff `value` is a member of ORGANIZATION_CAPABILITIES. */
export function isValidCapability(value: string): value is OrganizationCapability {
  return CAPABILITY_SET.has(value);
}

// ---------------------------------------------------------------------------
// Org-type specialization (#43 item 2) — a Clínica must not see refugio modules.
//
// These six capabilities are PURE-SHELTER concerns (custody rehoming lifecycle:
// foster, adoption, custody transfer, adoption listings). A clinic or sanitary
// authority never runs them, so their action cards and permission rows are
// hidden for those org types. `admin` still implicitly holds every capability
// (resolveGrantedCaps), which is exactly why a clinic ADMIN used to see every
// refugio card — the org-type filter, not the grant set, is the right gate.
// ---------------------------------------------------------------------------

export const SHELTER_ONLY_CAPABILITIES: ReadonlySet<OrganizationCapability> = new Set([
  "foster.assign",
  "foster.end",
  "adoption.review",
  "adoption.finalize",
  "custody.transfer",
  "adoption.listing.manage",
]);

// Org types that run the custody-rehoming lifecycle (and thus the shelter-only
// capabilities above). Everything else (clinic, sanitary_authority, other)
// hides them.
const REHOMING_ORG_TYPES: ReadonlySet<string> = new Set(["shelter", "rescue_network"]);

/**
 * Whether a capability is relevant to a given org_type. Shelter-only
 * capabilities are available only to rehoming org types; every other
 * capability is universal. Used to filter both the org-console action cards
 * and the permissions table so a clinic never surfaces refugio modules.
 */
export function capabilityAppliesToOrgType(
  capability: OrganizationCapability,
  orgType: string,
): boolean {
  if (SHELTER_ONLY_CAPABILITIES.has(capability)) {
    return REHOMING_ORG_TYPES.has(orgType);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Implicit capability baselines
// ---------------------------------------------------------------------------

// vet_individual: implicit caps per docs/org-portal-permissions.md.
export const VET_INDIVIDUAL_IMPLICIT_CAPS: readonly OrganizationCapability[] = [
  "pet.read_held",
  "event.write",
  "intake.create",
] as const;

// coordinator: cross-org transfer + member.invite implicit per CT9.
// Exported so authz-resolver and the shim can reference it.
export const COORDINATOR_IMPLICIT_CAPS: readonly OrganizationCapability[] = [
  "org.transfer.propose",
  "org.transfer.accept",
  "member.invite",
] as const;

// ---------------------------------------------------------------------------
// resolveGrantedCaps — pure baseline computation.
//
// Parameters:
//   role         — membership role string
//   approvedRows — capability strings from approved organization_capability_grants
//                  rows for this membership (already filtered to status='approved'
//                  by the caller; strings validated here before adding to set)
//
// Returns a Set<OrganizationCapability> with the full granted capability set.
// This is called by infrastructure/authz-resolver.getGrantedCapabilities.
// ---------------------------------------------------------------------------

export function resolveGrantedCaps(
  role: string,
  approvedRows: readonly string[],
): Set<OrganizationCapability> {
  if (role === "admin") {
    return new Set<OrganizationCapability>(ORGANIZATION_CAPABILITIES);
  }

  const set = new Set<OrganizationCapability>();

  // Add approved explicit grants (validate each string)
  for (const row of approvedRows) {
    if (isValidCapability(row)) set.add(row);
  }

  // Add role-based implicit baselines
  if (role === "vet_individual") {
    for (const cap of VET_INDIVIDUAL_IMPLICIT_CAPS) set.add(cap);
  } else if (role === "coordinator") {
    for (const cap of COORDINATOR_IMPLICIT_CAPS) set.add(cap);
  }
  // member / volunteer / foster / unknown: no implicit caps

  return set;
}
