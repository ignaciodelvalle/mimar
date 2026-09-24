// Which notifications the recipient must ACT on before something expires.
//
// WHY THIS EXISTS
// ---------------
// The inbox sorts by severity (urgent → warning → success → info) and then by
// recency — deliberate, documented and tested in
// `app/(app)/notificaciones/notification-ordering.ts`. That sort is fine. What
// was broken is the input to it: severity was being picked by TONE rather than
// by urgency, so the ranking came out backwards where it mattered most.
//
// Measured on staging, 2026-08-13: `foster_proposal_received` — a shelter asking
// a volunteer to take an animal, which auto-expires in 7 days — was emitted as
// `info`, the LAST rank. With 19 unread warnings in the feed it sank to the
// bottom of the page, and the QA agent who had just triggered it concluded the
// notification did not exist. It did. Meanwhile `foster_proposal_accepted_org`
// — pure good news, nothing to do — was `success` and ranked above it, and
// `pet_transfer_expired` — the obituary of a deadline nobody could act on any
// more — was `warning`, above the proposal that could have prevented it.
//
// THE RULE
// --------
// If the recipient has to do something, and a cron will decide for them when
// the clock runs out, it is AT LEAST `warning`. Outcomes — accepted, cancelled,
// completed, expired — stay `info`/`success`: there is nothing left to do.
//
// Every type below has a matching expiry mechanism, which is what makes the
// deadline real and not rhetorical:
//   foster_proposal_received            → cron expire_foster_proposals
//   cross_org_transfer_proposed_receiver→ cron expire_cross_org_transfers
//   pet_transfer_received               → cron expire_pet_transfers
//   org_invitation_created              → the invitation link itself (14 days)
//
// Adding a type here is not enough on its own — the call site must emit the
// higher severity. `__tests__/notification-severity-deadline.test.ts` scans the
// source and fails if any of these is emitted as `info`, so the two cannot
// drift apart.

/** Notification types whose recipient must act before an automatic expiry. */
export const ACTION_REQUIRED_BEFORE_DEADLINE: ReadonlySet<string> = new Set([
  "foster_proposal_received",
  "cross_org_transfer_proposed_receiver",
  "pet_transfer_received",
  "org_invitation_created",
]);

/** Severities that outrank `info` in the inbox sort. */
export const SEVERITIES_ABOVE_INFO: ReadonlySet<string> = new Set(["urgent", "warning", "success"]);
