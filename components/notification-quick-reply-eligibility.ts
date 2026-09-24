// Pure eligibility gate for the quick-reply island (capture-console surface #4).
//
// This MUST live OUTSIDE the "use client" boundary. NotificationCard is a SERVER
// component that CALLS this during render, but every export of a "use client"
// module (NotificationQuickReply.tsx) becomes a client reference — importing this
// from the server and invoking it throws "Attempted to call isQuickReplyEligible
// from the server but isQuickReplyEligible is on the client", which 500'd
// /notificaciones and the /inicio widget for any user with ≥1 notification
// (staging incident 2026-07-19, digest 1823265464). Keeping the pure gate in this
// plain module lets both the server card and the client island import it safely.

/**
 * Notification types eligible for the inline quick-reply island. MUST stay in
 * sync with the owner-facing CTA types lib/infra/notifications.ts emits
 * (vaccine_due → "Registrar vacuna", post_adoption_checkin_due → "Hacer
 * check-in"). Adding a new type here without also wiring that form's autoconfirm
 * handling leaves "Confirmar" degrading to a plain prefilled navigation (safe,
 * just not a one-tap commit) — still fine, but pointless.
 */
export const QUICK_REPLY_ALLOWLIST: ReadonlySet<string> = new Set([
  "vaccine_due",
  "post_adoption_checkin_due",
]);

/** The exact mount gate NotificationCard applies before rendering the island. */
export function isQuickReplyEligible(
  notificationType: string,
  relatedPetId: string | null,
  hasRelatedPet: boolean,
): boolean {
  return QUICK_REPLY_ALLOWLIST.has(notificationType) && Boolean(relatedPetId) && hasRelatedPet;
}
