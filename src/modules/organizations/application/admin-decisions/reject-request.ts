// Use-case: rejectRequestForAuthority
//
// Validates reason length, loads actor authority, checks jurisdiction scope,
// then inside a db.transaction: updates the approval_request status, inserts
// an audit_log entry, and collects the applicant notification.
//
// Post-tx: flushes pendingNotifications (§2.2 — NOT inside the tx).
//
// Returns { ok: true } on success or { error: string } on any failure.

import { and, eq } from "drizzle-orm";

import { type ApprovalRequest, approvalRequests, auditLog, db, notifications } from "@/db";
import { canDecideRequest } from "@/lib/infra/approval-scope";
import { assertTwoPersonRule } from "@/src/modules/organizations/domain/two-person-rule";

import { ctaForApplicant, loadActorAuthority } from "./helpers";
import type { DecisionResult } from "./types";

export async function rejectRequestForAuthority(
  actorUserId: string,
  publicToken: string,
  reason: string,
  bulkActionId: string | null = null,
): Promise<DecisionResult> {
  const trimmedReason = reason.trim();
  if (!trimmedReason || trimmedReason.length < 5 || trimmedReason.length > 1000) {
    return { error: "La razón del rechazo debe tener entre 5 y 1000 caracteres." };
  }

  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.publicToken, publicToken))
    .limit(1);
  if (!request) return { error: "Solicitud no encontrada." };
  if (request.status !== "pending") {
    return { error: `La solicitud ya está en estado "${request.status}".` };
  }

  const auth = await loadActorAuthority(actorUserId);
  if (!auth.ok) return { error: auth.error };
  if (!canDecideRequest(auth.profile, request, auth.jurisdictions)) {
    return { error: "No tenés permiso para decidir esta solicitud (fuera de tu jurisdicción)." };
  }

  // H3 — four eyes, ordered after the scope check for the same reason as the
  // approve sibling. Reject is covered too: a self-reject is how you make an
  // inconvenient request (somebody else's proposal naming you) disappear from
  // the queue with your own signature on it.
  const fourEyes = assertTwoPersonRule(actorUserId, request);
  if (!fourEyes.ok) return { error: fourEyes.error };

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // Misma guarda que en approve-request.ts, y por la misma carrera: el
      // chequeo de "pending" ocurre antes de abrir la transacción, así que sin
      // esta condición un rechazo podía commitear encima de una aprobación ya
      // aplicada y dejar el privilegio otorgado con la solicitud marcada como
      // rechazada. Cero filas actualizadas ⇒ perdimos la carrera ⇒ abortamos.
      const decided = await tx
        .update(approvalRequests)
        .set({
          status: "rejected",
          decidedAt: new Date(),
          decidedByUserId: actorUserId,
          decisionNotes: trimmedReason,
          updatedAt: new Date(),
        })
        .where(and(eq(approvalRequests.id, request.id), eq(approvalRequests.status, "pending")))
        .returning({ id: approvalRequests.id });

      if (decided.length === 0) {
        throw new Error("otra persona la resolvió mientras tanto — recargá para ver en qué quedó");
      }

      await tx.insert(auditLog).values({
        actorUserId,
        action: "request_rejected",
        approvalRequestId: request.id,
        targetUserId: request.targetUserId,
        targetOrganizationId: request.targetOrganizationId,
        payload: {
          reason: trimmedReason,
          ...(bulkActionId ? { bulk_action_id: bulkActionId } : {}),
        },
      });

      pendingNotifications.push({
        userId: request.applicantUserId,
        notificationType: "approval_request_rejected",
        title: titleForRejection(request.type),
        body: `Tu solicitud fue rechazada: ${trimmedReason}`,
        severity: "warning",
        ctaLabel: "Ver detalle",
        ctaUrl: ctaForApplicant(request),
      });
    });
  } catch (err) {
    return {
      error: `No se pudo rechazar: ${err instanceof Error ? err.message : "error desconocido"}`,
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
// Private helpers (only used by rejectRequestForAuthority)
// ---------------------------------------------------------------------------

function titleForRejection(type: ApprovalRequest["type"]): string {
  switch (type) {
    case "role_upgrade_vet":
      return "Matrícula rechazada";
    case "organization_verification":
      return "Verificación de organización rechazada";
    case "service_dog_credential_verification":
      return "Verificación de credencial de perro de asistencia rechazada";
  }
}
