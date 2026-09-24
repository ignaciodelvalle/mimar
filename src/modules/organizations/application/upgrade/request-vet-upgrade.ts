// Use-case: requestVetUpgradeForUser
//
// Submits a vet role-upgrade request for the given user:
//   1. Validates input (pure, fast-fail).
//   2. Canonicalizes the operational jurisdiction via the INDEC catalog.
//   3. Checks profile existence + current role (already a vet → idempotent rejection).
//   4. Enforces DNI verification prerequisite.
//   5. Idempotency: one pending role_upgrade_vet request per applicant.
//   6. Validates the approval payload schema.
//   7. Finds jurisdiction authorities for notification fan-out.
//   8. DB transaction: insert approval_request + update profile + insert notifications.
//
// Notifications are inserted inside the transaction (pre-existing behavior —
// zero-behavior-change contract for strangler 7/61).

import { and, eq } from "drizzle-orm";

import { approvalRequests, db, notifications, profiles } from "@/db";
import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { validateApprovalPayload } from "@/lib/infra/approval-payloads";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { generateApprovalRequestToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";

import type { UpgradeFormState, VetUpgradeInput } from "./types";

// ---------------------------------------------------------------------------
// Validation helpers (pure)
// ---------------------------------------------------------------------------

const MATRICULA_RE = /^[A-Za-z0-9-]{3,30}$/;

function validateLocationField(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 60) {
    return `${label} debe tener entre 2 y 60 caracteres.`;
  }
  return null;
}

function validateVetInput(input: VetUpgradeInput): string | null {
  const matricula = input.matriculaNumber.trim();
  if (!matricula) return "La matrícula es requerida.";
  if (!MATRICULA_RE.test(matricula)) {
    return "La matrícula debe tener entre 3 y 30 caracteres alfanuméricos o guiones.";
  }
  const jurError = validateLocationField(
    input.matriculaJurisdiccion,
    "La jurisdicción de la matrícula",
  );
  if (jurError) return jurError;
  const provError = validateLocationField(input.operationalProvince, "La provincia donde ejercés");
  if (provError) return provError;
  const locError = validateLocationField(input.operationalLocality, "La localidad donde ejercés");
  if (locError) return locError;
  return null;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function requestVetUpgradeForUser(
  userId: string,
  input: VetUpgradeInput,
): Promise<UpgradeFormState> {
  const validationError = validateVetInput(input);
  if (validationError) return { error: validationError };

  const matricula = input.matriculaNumber.trim();
  const matriculaJur = input.matriculaJurisdiccion.trim();
  // Canonicalize operational jurisdiction strictly against the INDEC catalog.
  // validateVetInput already guarantees both fields are non-empty (2-60 chars).
  // locality:"strict" — resolveCanonicalJurisdiction (vet upgrade behavior unchanged).
  let opProvince: string;
  let opLocality: string;
  try {
    const normalizedOp = await normalizeLocationForWrite(
      {
        province: input.operationalProvince,
        provinceCode: null,
        locality: input.operationalLocality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    opProvince = normalizedOp.province ?? input.operationalProvince;
    opLocality = normalizedOp.locality ?? input.operationalLocality;
  } catch (err) {
    if (err instanceof JurisdictionValidationError) {
      return { error: err.message };
    }
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  const especialidad = input.especialidad?.trim() || null;
  const anosExperiencia =
    typeof input.anosExperiencia === "number" && Number.isFinite(input.anosExperiencia)
      ? input.anosExperiencia
      : null;

  const [profile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
  if (!profile) return { error: "Perfil no encontrado." };
  if (profile.role === "vet") {
    return { error: "Ya sos veterinario/a en miMAR." };
  }

  // Prerequisite: DNI must be verified before submitting a vet upgrade.
  // prereqUrl uses the canonical ?next= pattern so the user lands back here
  // after completing verification. TODO(mi-argentina): when the real OAuth
  // flow lands, this prereq is satisfied by the Mi Argentina callback, not the
  // placeholder form. The contract (dniVerified=true before petition) stays.
  if (!profile.dniVerified) {
    return {
      error: "Necesitás declarar tu DNI antes de enviar una solicitud de veterinario.",
      missingPrereq: "dni",
      prereqUrl: "/cuenta/verificar-dni?next=/cuenta/upgrade",
    };
  }

  // Idempotency: one pending vet-upgrade request per applicant. A previously
  // rejected/withdrawn request does NOT block a re-submission (the new row
  // lives alongside the old one — full history in /cuenta/solicitudes).
  const [pending] = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.applicantUserId, userId),
        eq(approvalRequests.type, "role_upgrade_vet"),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) {
    return { error: "Ya tenés una solicitud pendiente de revisión." };
  }

  let payload: unknown;
  try {
    payload = validateApprovalPayload("role_upgrade_vet", {
      matricula_number: matricula,
      matricula_jurisdiccion: matriculaJur,
      especialidad,
      anos_experiencia: anosExperiencia,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Payload inválido.",
    };
  }

  const authorityIds = await findAuthoritiesForJurisdiction({
    province: opProvince,
    locality: opLocality,
  });
  const publicToken = await generateUniqueToken(
    approvalRequests,
    approvalRequests.publicToken,
    generateApprovalRequestToken,
  );

  try {
    await db.transaction(async (tx) => {
      // Step 1: insert the approval_request — the canonical contract.
      await tx.insert(approvalRequests).values({
        publicToken,
        type: "role_upgrade_vet",
        status: "pending",
        applicantUserId: userId,
        initiatedBy: "self",
        targetUserId: userId,
        jurisdictionProvince: opProvince,
        jurisdictionLocality: opLocality,
        payload,
      });

      // Step 2 (deferred): attachments with purpose='approval_evidence' —
      // wired in when the form has an upload field. The data model already
      // supports it via attachments.approval_request_id.

      // Step 3: update profiles so the user sees their submitted data
      // reflected in /cuenta/upgrade. role stays as-is until approval.
      await tx
        .update(profiles)
        .set({
          matriculaNumber: matricula,
          matriculaJurisdiccion: matriculaJur,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, userId));

      // Step 4a: notify the applicant.
      await tx.insert(notifications).values({
        userId,
        notificationType: "approval_request_submitted_self",
        title: "Solicitud de verificación profesional enviada",
        body: "Vamos a verificar tu matrícula y te avisamos. Mientras tanto podés seguir usando miMAR como dueño.",
        severity: "info",
        ctaLabel: "Ver estado",
        ctaUrl: "/cuenta/upgrade",
      });

      // Step 4b: notify every authority that should review this. Empty when
      // no admin is seeded — that's a configuration issue, not a fatal one.
      if (authorityIds.length > 0) {
        await tx.insert(notifications).values(
          authorityIds.map((authorityId) => ({
            userId: authorityId,
            notificationType: "approval_request_pending_authority",
            title: `Nueva solicitud: matrícula veterinaria en ${opLocality}`,
            body: `Un usuario solicitó verificación profesional. Matrícula ${matricula} (${matriculaJur}).`,
            severity: "info" as const,
            ctaLabel: "Revisar",
            ctaUrl: `/admin/cola/${publicToken}`,
          })),
        );
      }
    });
  } catch (err) {
    return {
      error: `No se pudo guardar la solicitud: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { error: null, ok: true };
}
