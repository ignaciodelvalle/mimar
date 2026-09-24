// The one delivery path for every decomiso notification.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// All five decomiso actions committed their transaction and then did this: a
// raw bulk insert into the notifications table inside a try/catch whose only
// handler was `console.error("notifications insert failed (… succeeded)")`,
// followed unconditionally by `return { ok: true, publicCode }`.
//
// The notification is the ENTIRE instrument. There is no email channel in this
// product (lib/infra/ has web-push.ts and nothing else), so a lost row does not
// mean "the person hears about it later through another door" — it means the
// person whose animal was seized, or the refugio that has seven days to accept a
// handoff, is simply never told. And the action reported success either way, so
// nobody could know it happened.
//
// Two changes, both required by the PO's fix list (engram
// roadmap/decisiones-legales-flujos-2026-08-17, item 2e):
//
//   1. DURABLE. Delivery goes through createNotificationsBulk, which
//      dead-letters a failed payload into `notification_dead_letter` instead of
//      dropping it. "Gone forever" becomes "delayed but recoverable", and the
//      failure leaves a queryable trace.
//   2. VISIBLE. The result carries a `warning` the caller returns to the
//      operator. The decomiso still stands — it is recorded, and undoing it over
//      a notification blip would be worse — but the funcionario is told that N
//      people were not reached, so he can pick up the phone.
//
// The dedupe key is derived from the case code + type + recipient, which is
// stable across a retry of the same act and distinct across recipients.

import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { pluralizeEs } from "@/lib/utils/format";

import type { NewNotification } from "../domain/types";

export type DecomisoNotificationDelivery = {
  delivered: number;
  duplicate: number;
  /** Payloads parked in notification_dead_letter — nobody was reached for these. */
  deadLettered: number;
  /**
   * es-AR sentence for the operator, or null when everything landed. The caller
   * returns it alongside its success result; it never turns success into
   * failure.
   */
  warning: string | null;
};

/**
 * @param stage - short id of the act, so a later reassign/return on the SAME
 *   case does not collapse into the first notification's dedupe key.
 */
export async function deliverDecomisoNotifications(
  pending: NewNotification[],
  context: { casePublicCode: string; stage: string },
): Promise<DecomisoNotificationDelivery> {
  if (pending.length === 0) {
    return { delivered: 0, duplicate: 0, deadLettered: 0, warning: null };
  }

  const result = await createNotificationsBulk(
    pending.map((n) => ({
      userId: n.userId,
      notificationType: n.notificationType,
      title: n.title,
      body: n.body,
      // The service's severity union has no "success" arm; decomiso never emits
      // it, and mapping it down to "info" keeps the type honest either way.
      severity: n.severity === "success" ? ("info" as const) : n.severity,
      ctaLabel: n.ctaLabel ?? null,
      ctaUrl: n.ctaUrl ?? null,
      relatedPetId: n.relatedPetId ?? null,
      relatedCaseId: n.relatedCaseId ?? null,
      dedupeKey: `decomiso:${context.casePublicCode}:${context.stage}:${n.notificationType}:${n.userId}`,
    })),
  );

  return {
    delivered: result.insertedCount,
    duplicate: result.duplicateCount,
    deadLettered: result.deadLetteredCount,
    warning:
      result.deadLetteredCount > 0
        ? `El decomiso quedó registrado, pero ${result.deadLetteredCount} de ${pending.length} ${pluralizeEs(pending.length, "aviso")} no se pudieron entregar (quedaron en cola para reintento). Avisá por otra vía a las personas u organizaciones involucradas.`
        : null,
  };
}
