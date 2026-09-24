// Use-case: requestInfoForAuthority — "Pedir más información" (non-terminal).
//
// UI/UX audit 2026-07: the approval detail offered only approve/reject, so an
// approver facing an incomplete matrícula either rubber-stamped or terminally
// rejected. This third action reuses the rejection notes channel (message to
// the applicant) WITHOUT deciding the request.
//
// STATE MACHINE NOTE: approval_requests.status is CHECK-constrained to
// pending | approved | rejected | withdrawn, and a second CHECK requires
// decided_at/decided_by to stay NULL while pending — there is NO compatible
// intermediate status. The info request is therefore a notes-only decision
// EVENT: an audit_log row (action 'request_info_requested', payload.message)
// plus an applicant notification, while the request row stays untouched and
// PENDING (it remains decidable afterwards).

import { eq } from "drizzle-orm";

import { type ApprovalRequest, approvalRequests, auditLog, db } from "@/db";
import { canDecideRequest } from "@/lib/infra/approval-scope";
import { createNotification } from "@/lib/infra/notification-service";
import {
  approvalInfoBody,
  approvalInfoDedupeKey,
} from "@/src/modules/organizations/domain/approval-info-key";
import { assertTwoPersonRule } from "@/src/modules/organizations/domain/two-person-rule";

import { loadActorAuthority } from "./helpers";
import type { DecisionResult } from "./types";

export async function requestInfoForAuthority(
  actorUserId: string,
  publicToken: string,
  message: string,
): Promise<DecisionResult> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage || trimmedMessage.length < 5 || trimmedMessage.length > 1000) {
    return { error: "El pedido de información debe tener entre 5 y 1000 caracteres." };
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

  // H3 — four eyes, ordered after the scope check like its two siblings. This
  // one writes no decision, but it is a step IN the decision: asking yourself
  // for information leaves an audit row that reads like an external reviewer
  // probed the request, and it is the manoeuvre that makes a self-approval look
  // diligent afterwards.
  const fourEyes = assertTwoPersonRule(actorUserId, request);
  if (!fourEyes.ok) return { error: fourEyes.error };

  try {
    // Notes-only event — the approval_requests row is NOT touched (status stays
    // pending, decided_at/decided_by stay NULL per the pending CHECK).
    await db.insert(auditLog).values({
      actorUserId,
      action: "request_info_requested",
      approvalRequestId: request.id,
      targetUserId: request.targetUserId,
      targetOrganizationId: request.targetOrganizationId,
      payload: { message: trimmedMessage },
    });
  } catch (err) {
    return {
      error: `No se pudo registrar el pedido: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // Applicant notification — canonical write path (idempotent + dead-letter,
  // never throws / never blocks the primary intent).
  await createNotification({
    userId: request.applicantUserId,
    notificationType: "approval_request_info_requested",
    title: titleForInfoRequest(request.type),
    body: approvalInfoBody(trimmedMessage),
    severity: "info",
    ctaLabel: "Ver detalle",
    // NOT ctaForApplicant: that helper points at each type's destination
    // surface (/cuenta/upgrade, /org, the pet's asistencia page), which is right
    // for approve and reject. None of those render an open information request —
    // /cuenta/upgrade in particular replaces its form with "Solicitud enviada —
    // pendiente de revisión." while a request is pending, which is the exact
    // silence this notification is trying to break. /cuenta/solicitudes is the
    // one page that shows the ask.
    ctaUrl: "/cuenta/solicitudes",
    // Stable across retries of the SAME message; distinct messages co-exist.
    dedupeKey: approvalInfoDedupeKey(request.id, simpleHash(trimmedMessage)),
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function titleForInfoRequest(type: ApprovalRequest["type"]): string {
  switch (type) {
    case "role_upgrade_vet":
      return "Te pedimos más información sobre tu matrícula";
    case "organization_verification":
      return "Te pedimos más información sobre tu organización";
    case "service_dog_credential_verification":
      return "Te pedimos más información sobre tu credencial RUPGA";
  }
}

/** djb2 — tiny stable hash for the dedupe key (not cryptographic; collisions
 * only risk deduping two identical-hash messages on the same request). */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}
