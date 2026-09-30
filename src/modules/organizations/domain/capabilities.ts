// Pure capability helpers — no DB imports, no Next.js imports.
// DB and Supabase logic lives in infrastructure/authz-resolver.ts.
//
// Baseline model:
//   - admin          → ALL ORGANIZATION_CAPABILITIES (universal grant)
//   - vet_individual → BASELINE ∪ (CREDENTIAL if matrícula verified) ∪ grants
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
  // Scheduling system (Fase 0). Earned via the approval flow (spec D8), except
  // appointment.manage, which is the vet_individual baseline (portal-vet-p0).
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

// vet_individual — the preset splits in two (portal-vet-p0 D10).
//
// BASELINE: every vet_individual member holds it, verified or not. Running
// the clinic's agenda is not a clinical act.
export const VET_INDIVIDUAL_BASELINE_CAPS: readonly OrganizationCapability[] = [
  "appointment.manage",
] as const;

// CREDENTIAL: clinical acts, bound to the member's own verified matrícula.
// They are never GRANTED to a vet_individual: a grant row would outlive a
// revoked matrícula (W6), so resolveGrantedCaps ignores such rows while the
// credential is invalid.
export const VET_CREDENTIAL_CAPS: readonly OrganizationCapability[] = [
  "pet.read_held",
  "event.write",
  "intake.create",
  "bite.report",
] as const;

// The whole vet preset (docs/org-portal-permissions.md): baseline ∪ credential.
export const VET_INDIVIDUAL_IMPLICIT_CAPS: readonly OrganizationCapability[] = [
  ...VET_INDIVIDUAL_BASELINE_CAPS,
  ...VET_CREDENTIAL_CAPS,
];

const VET_CREDENTIAL_CAP_SET: ReadonlySet<string> = new Set(VET_CREDENTIAL_CAPS);

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

/**
 * What the implicit `vet_individual` baseline is conditioned on (W6 review).
 *
 * The role name alone is not a credential. `vetCredentialValid` is true only
 * when the MEMBER's profile says `role = 'vet'` AND `matricula_verified`. A
 * vet whose matrícula was revoked, or who resigned it, keeps the membership
 * row until something ends it — and without this check that row alone kept
 * vaccines, bites, rabies closes and controlled meds open to them. Absent or
 * false → the clinical caps (VET_CREDENTIAL_CAPS) are withheld (default deny),
 * INCLUDING approved grant rows for them (portal-vet-p0 D10): a row an admin
 * wrote before would otherwise outlive the revocation. The baseline and every
 * other approved grant still apply.
 */
export type ResolveGrantedCapsContext = { vetCredentialValid?: boolean };

export function resolveGrantedCaps(
  role: string,
  approvedRows: readonly string[],
  context: ResolveGrantedCapsContext = {},
): Set<OrganizationCapability> {
  if (role === "admin") {
    return new Set<OrganizationCapability>(ORGANIZATION_CAPABILITIES);
  }

  const set = new Set<OrganizationCapability>();
  const vetCredentialValid = context.vetCredentialValid === true;
  const dropsCredentialRows = role === "vet_individual" && !vetCredentialValid;

  // Add approved explicit grants (validate each string)
  for (const row of approvedRows) {
    if (!isValidCapability(row)) continue;
    if (dropsCredentialRows && VET_CREDENTIAL_CAP_SET.has(row)) continue;
    set.add(row);
  }

  // Add role-based implicit baselines
  if (role === "vet_individual") {
    for (const cap of VET_INDIVIDUAL_BASELINE_CAPS) set.add(cap);
    if (vetCredentialValid) {
      for (const cap of VET_CREDENTIAL_CAPS) set.add(cap);
    }
  } else if (role === "coordinator") {
    for (const cap of COORDINATOR_IMPLICIT_CAPS) set.add(cap);
  }
  // member / volunteer / foster / unknown: no implicit caps

  return set;
}

// ---------------------------------------------------------------------------
// credentialGatedGrantRefusal — the one rule every grant writer asks.
// Appended at the end on purpose: docs/architecture/authorization.md cites the
// lines above by number.
// ---------------------------------------------------------------------------

/** Why a capability cannot be granted to a membership role. */
export type CredentialGatedGrantRefusal = "derives_from_matricula";

/**
 * A vet_individual's clinical capabilities (VET_CREDENTIAL_CAPS) come from
 * their own verified matrícula, never from an org decision (portal-vet-p0
 * D10). Every path that writes a grant row — direct grant, member request,
 * the event-write toggle, invitation accept — asks this first and writes
 * nothing when it refuses. Other roles are unaffected: an org that wants a
 * non-vet to record uses role `member` plus a grant.
 */
export function credentialGatedGrantRefusal(
  role: string,
  capability: string,
): CredentialGatedGrantRefusal | null {
  if (role === "vet_individual" && VET_CREDENTIAL_CAP_SET.has(capability)) {
    return "derives_from_matricula";
  }
  return null;
}

/** Admin-facing refusal copy (grant, toggle). */
export const CREDENTIAL_GATED_GRANT_REFUSAL_COPY: Record<CredentialGatedGrantRefusal, string> = {
  derives_from_matricula:
    "Los permisos clínicos de un veterinario/a no se conceden: salen de su propia matrícula verificada.",
};

/** Member-facing refusal copy (the vet asking for it herself). */
export const CREDENTIAL_GATED_REQUEST_REFUSAL_COPY: Record<CredentialGatedGrantRefusal, string> = {
  derives_from_matricula:
    "Este permiso no se pide: sale de tu matrícula verificada. Verificala desde Mi cuenta.",
};
