// Use-case: approveRequestForAuthority
//
// Validates actor authority, checks jurisdiction scope, then inside a
// db.transaction: applies the polymorphic mutation (role/org/service-dog),
// updates the approval_request status, inserts an audit_log entry, and
// collects the applicant notification.
//
// Post-tx: flushes pendingNotifications (§2.2 — NOT inside the tx).
//
// Returns { ok: true } on success or { error: string } on any failure.

import { and, eq } from "drizzle-orm";

import { MATRICULA_VERIFICATION_NOTE } from "@/app/gob/cola/_lib/matricula-verification";
import {
  type ApprovalRequest,
  approvalRequests,
  auditLog,
  db,
  notifications,
  organizations,
  petServiceDog,
  profiles,
} from "@/db";
import { canDecideRequest } from "@/lib/infra/approval-scope";
import { assertTwoPersonRule } from "@/src/modules/organizations/domain/two-person-rule";

import { ctaForApplicant, loadActorAuthority } from "./helpers";
import type { DecisionResult } from "./types";

export async function approveRequestForAuthority(
  actorUserId: string,
  publicToken: string,
  notes: string | null,
  bulkActionId: string | null = null,
): Promise<DecisionResult> {
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.publicToken, publicToken))
    .limit(1);
  if (!request) return { error: "Solicitud no encontrada." };
  if (request.status !== "pending") {
    return { error: `La solicitud ya está en estado "${request.status}".` };
  }

  // Matrícula approvals are a VERIFICATION flow, not a rubber stamp (UI/UX
  // audit 2026-07): each one requires the per-request checklist on the detail
  // page (format / official registry / identity), which a bulk pass cannot
  // perform. Bulk REJECT stays allowed — only the approval path is individual.
  // bulkActionId != null is the bulk-path marker (bulk-approve-requests.ts).
  if (bulkActionId !== null && request.type === "role_upgrade_vet") {
    return {
      error:
        "Las matrículas veterinarias no se aprueban en lote: cada una requiere la verificación individual desde el detalle.",
    };
  }

  const auth = await loadActorAuthority(actorUserId);
  if (!auth.ok) return { error: auth.error };
  if (!canDecideRequest(auth.profile, request, auth.jurisdictions)) {
    return { error: "No tenés permiso para decidir esta solicitud (fuera de tu jurisdicción)." };
  }

  // H3 — four eyes. AFTER the scope check, so an out-of-scope authority keeps
  // getting the jurisdiction refusal (the accurate one) rather than learning
  // that this request happens to be their own; and BEFORE the matrícula-note
  // validation below, because this is an authorization guard and that one is
  // validation detail nobody unauthorized should see. See domain/two-person-rule.ts.
  const fourEyes = assertTwoPersonRule(actorUserId, request);
  if (!fourEyes.ok) return { error: fourEyes.error };

  // Lote A3 — the individual path must carry PROOF of the verification too.
  // The client checklist only disabled a button; a direct call could approve a
  // vet upgrade with empty notes. The structured note prefix is the artifact
  // the checklist produces (composeMatriculaApprovalNotes), so its presence is
  // the server-side mirror of "the checklist was completed". Ordered AFTER the
  // authorization guards: an out-of-scope caller gets the permission error,
  // never validation detail.
  if (request.type === "role_upgrade_vet") {
    const trimmedNotes = notes?.trim() ?? "";
    if (!trimmedNotes.startsWith(MATRICULA_VERIFICATION_NOTE)) {
      return {
        error:
          "La aprobación de matrícula requiere completar la verificación (checklist) desde el detalle de la solicitud.",
      };
    }
  }

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      const mutationSummary = await applyApprovalMutation(tx, request, actorUserId);

      // GUARDA DE ESTADO EN EL PROPIO UPDATE, y no solo en la lectura previa.
      //
      // El `request.status !== "pending"` de arriba se evalúa ANTES de abrir la
      // transacción, así que no dice nada sobre lo que pasó mientras tanto. Dos
      // operadores sobre la misma solicitud —uno aprobando, otro rechazando con
      // la pestaña vieja abierta— pasaban los dos ese chequeo y los dos
      // escribían. El perdedor pisaba el `status` sin revertir la mutación del
      // perfil que el ganador ya había aplicado: quedaba un veterinario con
      // matrícula verificada y privilegios de firma clínica activos cuya
      // solicitud figuraba "rechazada", detectable solo cruzando dos filas
      // contradictorias de audit_log.
      //
      // Con la condición adentro del WHERE, el perdedor actualiza cero filas y
      // aborta. Como `applyApprovalMutation` corrió ANTES en esta misma
      // transacción, el rollback la deshace: o se aplica todo, o nada. Es el
      // patrón que este repo ya usa en cases-repository.ts::closeCase, con su
      // propio comentario diciendo que quien pierde la carrera no debe seguir.
      const decided = await tx
        .update(approvalRequests)
        .set({
          status: "approved",
          decidedAt: new Date(),
          decidedByUserId: actorUserId,
          decisionNotes: notes?.trim() || null,
          updatedAt: new Date(),
        })
        .where(and(eq(approvalRequests.id, request.id), eq(approvalRequests.status, "pending")))
        .returning({ id: approvalRequests.id });

      if (decided.length === 0) {
        throw new Error("otra persona la resolvió mientras tanto — recargá para ver en qué quedó");
      }

      await tx.insert(auditLog).values({
        actorUserId,
        action: "request_approved",
        approvalRequestId: request.id,
        targetUserId: request.targetUserId,
        targetOrganizationId: request.targetOrganizationId,
        payload: {
          mutations_applied: mutationSummary,
          notes: notes ?? null,
          ...(bulkActionId ? { bulk_action_id: bulkActionId } : {}),
        },
      });

      pendingNotifications.push({
        userId: request.applicantUserId,
        notificationType: "approval_request_approved",
        title: titleForApproval(request.type),
        body: bodyForApproval(request.type, notes),
        severity: "success",
        ctaLabel: "Ver detalle",
        ctaUrl: ctaForApplicant(request),
      });
    });
  } catch (err) {
    return {
      error: `No se pudo aprobar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Private helpers (only used by approveRequestForAuthority)
// ---------------------------------------------------------------------------

// Polymorphic mutation. Returns a summary object for the audit_log payload.
// Each branch is the spec §7.4 "Aplicar mutación al target" step for its type.
async function applyApprovalMutation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  request: ApprovalRequest,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  switch (request.type) {
    case "role_upgrade_vet": {
      if (!request.targetUserId) throw new Error("role_upgrade_vet requires target_user_id.");
      await tx
        .update(profiles)
        .set({
          role: "vet",
          matriculaVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(profiles.id, request.targetUserId));
      return { kind: "role_upgrade_vet", target_user_id: request.targetUserId };
    }

    case "organization_verification": {
      if (!request.targetOrganizationId) {
        throw new Error("organization_verification requires target_organization_id.");
      }
      await tx
        .update(organizations)
        .set({
          verified: true,
          verifiedAt: new Date(),
          verifiedByUserId: actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, request.targetOrganizationId));
      return {
        kind: "organization_verification",
        target_organization_id: request.targetOrganizationId,
      };
    }

    case "service_dog_credential_verification": {
      // The pet is identified by request.payload.pet_id (stored at submit
      // time). We anchor on pet_id rather than reading it back from the
      // owner profile so the approval survives an ownership change before
      // verification lands.
      const payload = (request.payload ?? {}) as { pet_id?: string };
      if (!payload.pet_id) {
        throw new Error("service_dog_credential_verification requires payload.pet_id");
      }
      const now = new Date();
      const updated = await tx
        .update(petServiceDog)
        .set({
          credentialStatus: "vigente",
          verifiedAt: now,
          verifiedByUserId: actorUserId,
          updatedAt: now,
        })
        .where(eq(petServiceDog.petId, payload.pet_id))
        .returning({ id: petServiceDog.id });
      if (updated.length === 0) {
        throw new Error(
          "service_dog row not found for pet — owner may have withdrawn it before approval landed",
        );
      }
      return {
        kind: "service_dog_credential_verification",
        pet_id: payload.pet_id,
      };
    }
  }
}

function titleForApproval(type: ApprovalRequest["type"]): string {
  switch (type) {
    case "role_upgrade_vet":
      return "Matrícula aprobada";
    case "organization_verification":
      return "Tu organización fue verificada";
    case "service_dog_credential_verification":
      return "Credencial de perro de asistencia verificada";
  }
}

function bodyForApproval(type: ApprovalRequest["type"], notes: string | null): string {
  const trail = notes ? ` Notas: ${notes}` : "";
  switch (type) {
    case "role_upgrade_vet":
      return `Verificamos tu matrícula. Ya figurás como veterinario/a en miMAR.${trail}`;
    case "organization_verification":
      return `Tu organización ahora figura como verificada. Los eventos que registres aparecen con el sello de verificación.${trail}`;
    case "service_dog_credential_verification":
      return `Tu credencial RUPGA fue verificada. Ya podés activar el banner público de acceso (Ley 26.858).${trail}`;
  }
}
