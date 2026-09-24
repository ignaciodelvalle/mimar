/**
 * THE ONE QUESTION BOTH PUSH CHANNELS ASK: should this notification row leave
 * the building?
 *
 * WHY THIS FILE EXISTS AT ALL, rather than the predicate living in either
 * sender. Web push (`web-push.ts`) and Expo push (`expo-push.ts`) are siblings,
 * not a migration path — the web channel keeps `push_subscriptions` and its own
 * transport permanently. If the predicate lived in one of them, the other would
 * have to import from a peer it has no other reason to know about, and the first
 * person to widen one channel's filter would widen it in a file whose name says
 * it belongs to the other. A neutral module makes "both senders agree by
 * construction" a property of the import graph instead of a rule somebody has to
 * remember.
 *
 * THE FILTER IS DELIBERATELY NARROW AND MUST NOT BE WIDENED HERE. The wider
 * filter this project wants needs a notification-type registry that does not
 * exist: `notification_type` is free text with roughly 149 distinct values in the
 * corpus, so a second hardcoded list would drift from the first. Two channels
 * disagreeing about what is urgent is worse than both being narrow. Widening is a
 * separate workstream and it starts with the registry, not with this line.
 */

/**
 * The structural subset of a notifications row this predicate reads.
 *
 * Declared structurally rather than imported from either sender so that neither
 * channel owns the shape. `PushCandidateRow` in `web-push.ts` satisfies it
 * without an import, and so will the Expo sender's row type.
 */
export type PushEligibilityInput = {
  severity?: "info" | "success" | "warning" | "urgent" | null;
  /** The row's `notification_type`. Free text, not an enum — see the note above. */
  notificationType?: string | null;
};

/**
 * The notification type that is pushed despite not being `urgent`.
 *
 * A sighting is warning-severity in the Bandeja on purpose — the taxonomy
 * separates "somebody SAW the pet" from "somebody HAS the pet", and styling an
 * avistaje like a hallazgo would tell the owner something false. It is still a
 * time-sensitive lost-mode signal the owner wants on their lock screen, which is
 * why it is named here rather than promoted to `urgent` in the database.
 */
export const PUSH_ELIGIBLE_NOTIFICATION_TYPE = "pet_sighting";

/**
 * True when a notification row qualifies for push on EVERY channel.
 *
 * Channel-specific gating (the web feature flag, a missing `EXPO_ACCESS_TOKEN`)
 * is NOT this function's job and must stay in the sender that owns it. This
 * answers "is this row worth a lock screen", not "can this channel deliver".
 */
export function isPushEligible(row: PushEligibilityInput): boolean {
  return row.severity === "urgent" || row.notificationType === PUSH_ELIGIBLE_NOTIFICATION_TYPE;
}
