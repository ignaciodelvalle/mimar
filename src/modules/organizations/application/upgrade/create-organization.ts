// Use-case: createOrganizationForUser
//
// Creates a new organization for the given user:
//   1. Validates input (pure, fast-fail).
//   2. Checks DNI verification prerequisite.
//   3. Determines solo-vet-clinic auto-verify eligibility (D1).
//   4. Idempotency: one org per user via active admin membership check.
//   5. Canonicalizes jurisdiction via the INDEC catalog.
//   6. Validates the approval payload schema.
//   7. Finds jurisdiction authorities for notification fan-out.
//   8. DB transaction: insert org + membership + audit_log + approval_request + notifications.
//   9. Returns organizationId on success.
//
// Notifications are inserted inside the transaction (pre-existing behavior —
// zero-behavior-change contract for strangler 7/61).

import { eq } from "drizzle-orm";

import {
  approvalRequests,
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { validateApprovalPayload } from "@/lib/infra/approval-payloads";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { pgError } from "@/lib/infra/db-errors";
import { generateApprovalRequestToken, generatePublicToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";
import { getActiveMemberships } from "@/src/modules/organizations/infrastructure/authz-resolver";

import type { CreateOrganizationInput, UpgradeFormState } from "./types";

// ---------------------------------------------------------------------------
// Validation helpers (pure)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CUIT_RE = /^\d{11}$/;
const ORG_TYPES = ["clinic", "shelter", "rescue_network", "sanitary_authority", "other"] as const;

function validateLocationField(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 60) {
    return `${label} debe tener entre 2 y 60 caracteres.`;
  }
  return null;
}

function validateOrgInput(input: CreateOrganizationInput): string | null {
  const name = input.name.trim();
  if (!name || name.length < 2 || name.length > 100) {
    return "El nombre debe tener entre 2 y 100 caracteres.";
  }
  const legalName = input.legalName.trim();
  if (!legalName || legalName.length < 2 || legalName.length > 100) {
    return "La razón social debe tener entre 2 y 100 caracteres.";
  }
  if (!ORG_TYPES.includes(input.orgType as (typeof ORG_TYPES)[number])) {
    return "Tipo de organización inválido.";
  }
  // sanitary_authority is a government classification provisioned out-of-band.
  // Block self-registration server-side regardless of what the form submitted.
  if (input.orgType === "sanitary_authority") {
    return "Las organizaciones de tipo 'Autoridad sanitaria' son provisionadas por el equipo de miMAR. No podés registrarlas de forma autónoma.";
  }
  if (!EMAIL_RE.test(input.email)) {
    return "El correo electrónico es inválido.";
  }
  if (input.cuit) {
    const digits = input.cuit.replace(/-/g, "");
    if (!CUIT_RE.test(digits)) {
      return "El CUIT debe tener 11 dígitos.";
    }
  }
  const provError = validateLocationField(input.jurisdictionProvince, "La provincia");
  if (provError) return provError;
  const locError = validateLocationField(input.jurisdictionLocality, "La localidad");
  if (locError) return locError;
  return null;
}

// Postgres 23505 = unique_violation. Match by constraint metadata, not the
// error-message string, so renamed constraints or driver-level message
// changes don't silently miscategorize the error.
//
// pgError unwraps drizzle 0.45's `.cause` chain to the real postgres-js error;
// `column_name` / `detail` live on that raw object alongside `constraint`.
function isUniqueViolationOn(err: unknown, column: string): boolean {
  const info = pgError(err);
  if (!info || info.code !== "23505") return false;
  const constraint = info.constraint ?? "";
  const columnName = typeof info.raw.column_name === "string" ? info.raw.column_name : "";
  const detail = typeof info.raw.detail === "string" ? info.raw.detail : "";
  return constraint.includes(column) || columnName === column || detail.includes(`(${column})`);
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createOrganizationForUser(
  userId: string,
  input: CreateOrganizationInput,
): Promise<UpgradeFormState> {
  const validationError = validateOrgInput(input);
  if (validationError) return { error: validationError };

  // Prerequisite: DNI must be verified before creating an organization.
  const [profile] = await db
    .select({ dniVerified: profiles.dniVerified, matriculaVerified: profiles.matriculaVerified })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (!profile) return { error: "Perfil no encontrado." };
  if (!profile.dniVerified) {
    return {
      error: "Necesitás declarar tu DNI antes de crear una organización.",
      missingPrereq: "dni",
      prereqUrl: "/cuenta/verificar-dni?next=/cuenta/upgrade",
    };
  }

  // D1: a solo vet clinic auto-verifies at creation when the creator's personal
  // matrícula is already verified. Other org types and non-verified-matrícula
  // creators follow the standard pending-review flow.
  const isSoloVetClinic = input.orgType === "clinic" && profile.matriculaVerified === true;

  // Idempotency: one org per user (the existing membership-based guard).
  const memberships = await getActiveMemberships(userId);
  const alreadyAdmin = memberships.some((m) => m.membership.role === "admin");
  if (alreadyAdmin) {
    return { error: "Ya administrás una organización." };
  }

  // NOTE: organizations.public_token historically uses the DIM-XXXX prefix
  // even though it's an org, not a pet. Kept as-is for backward compat with
  // existing org URLs. The retry wrapper still ensures uniqueness against
  // the organizations table.
  const publicToken = await generateUniqueToken(
    organizations,
    organizations.publicToken,
    generatePublicToken,
  );
  const approvalPublicToken = await generateUniqueToken(
    approvalRequests,
    approvalRequests.publicToken,
    generateApprovalRequestToken,
  );
  const cuit = input.cuit ? input.cuit.replace(/-/g, "") : null;
  // Canonicalize org jurisdiction strictly against the INDEC catalog.
  // validateOrgInput already guarantees both fields are non-empty (2-60 chars).
  // locality:"strict" — resolveCanonicalJurisdiction (org create behavior unchanged).
  let province: string;
  let locality: string;
  try {
    const normalizedOrg = await normalizeLocationForWrite(
      {
        province: input.jurisdictionProvince,
        provinceCode: null,
        locality: input.jurisdictionLocality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    province = normalizedOrg.province ?? input.jurisdictionProvince;
    locality = normalizedOrg.locality ?? input.jurisdictionLocality;
  } catch (err) {
    if (err instanceof JurisdictionValidationError) {
      return { error: err.message };
    }
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  let organizationId: string;

  let payload: unknown;
  try {
    payload = validateApprovalPayload("organization_verification", {
      org_type: input.orgType,
      cuit,
      personeria_juridica_number: input.personeriaJuridicaNumber?.trim() || null,
      additional_documents_summary: null,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Payload inválido.",
    };
  }

  const authorityIds = await findAuthoritiesForJurisdiction({ province, locality });

  try {
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [newOrg] = await tx
        .insert(organizations)
        .values({
          publicToken,
          displayName: input.name.trim(),
          legalName: input.legalName.trim(),
          orgType: input.orgType,
          cuit: cuit || null,
          email: input.email.trim(),
          phone: input.phone?.trim() || null,
          jurisdictionProvince: province,
          jurisdictionLocality: locality,
          // D1: auto-verify solo vet clinics at creation.
          verified: isSoloVetClinic,
          verifiedAt: isSoloVetClinic ? now : null,
          verifiedByUserId: null, // intentionally null — system decision, not the vet herself
          autoVerifiedViaMatricula: isSoloVetClinic,
          createdByUserId: userId,
        })
        .returning();

      await tx.insert(organizationMemberships).values({
        organizationId: newOrg.id,
        userId,
        role: "admin",
        canWritePetEvents: true,
      });

      // Audit: org creator is auto-added as admin at org creation.
      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "org_member_added",
        targetUserId: userId,
        targetOrganizationId: newOrg.id,
        payload: {
          org_id: newOrg.id,
          member_user_id: userId,
          role: "admin",
          how: "org_creation",
        },
      });

      // Canonical contract: the approval request is what authorities act on.
      // For auto-verified solo-vet clinics, insert as approved (audit trail).
      // For all other orgs, insert as pending (standard review flow).
      await tx.insert(approvalRequests).values({
        publicToken: approvalPublicToken,
        type: "organization_verification",
        status: isSoloVetClinic ? "approved" : "pending",
        applicantUserId: userId,
        initiatedBy: "self",
        targetOrganizationId: newOrg.id,
        jurisdictionProvince: province,
        jurisdictionLocality: locality,
        payload,
        // D1: decidedAt required by CHECK constraint for approved rows.
        // decidedByUserId is null — system-automated decision.
        decidedAt: isSoloVetClinic ? now : null,
        decidedByUserId: null,
        decisionNotes: isSoloVetClinic
          ? "Auto-verified via verified matrícula — solo vet clinic creation"
          : null,
      });

      if (isSoloVetClinic) {
        // D1: lighter onboarding copy — the clinic is already operational.
        await tx.insert(notifications).values({
          userId,
          notificationType: "approval_request_submitted_self",
          title: "Consultorio creado y verificado",
          body: "Tu consultorio fue creado y verificado gracias a tu matrícula habilitada. Ya podés crear servicios y recibir turnos.",
          severity: "success",
          ctaLabel: "Ir al panel",
          ctaUrl: "/org",
        });
      } else {
        await tx.insert(notifications).values({
          userId,
          notificationType: "approval_request_submitted_self",
          title: "Organización creada — pendiente de verificación",
          body: "Tu organización fue creada. Mientras se verifica, los eventos que registres aparecen como no verificados.",
          severity: "info",
          ctaLabel: "Ir al panel",
          ctaUrl: "/org",
        });

        if (authorityIds.length > 0) {
          await tx.insert(notifications).values(
            authorityIds.map((authorityId) => ({
              userId: authorityId,
              notificationType: "approval_request_pending_authority",
              title: `Nueva organización a verificar en ${locality}`,
              body: `${newOrg.displayName} (${input.orgType}) solicitó verificación.`,
              severity: "info" as const,
              ctaLabel: "Revisar",
              ctaUrl: `/admin/cola/${approvalPublicToken}`,
            })),
          );
        }
      }

      return { organizationId: newOrg.id };
    });
    organizationId = result.organizationId;
  } catch (err) {
    if (isUniqueViolationOn(err, "cuit")) {
      return { error: "Ya existe una organización con ese CUIT." };
    }
    const msg = err instanceof Error ? err.message : "error desconocido";
    return { error: `No se pudo crear la organización: ${msg}` };
  }

  return { error: null, ok: true, organizationId };
}
