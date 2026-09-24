// rehome_request lifecycle (rehome-by-titular, design "Lifecycle declaration").
//
// The titular's CONSENT RECORD and the sponsoring org's INBOX ITEM. A titular
// who keeps living with their animal asks a verified org to sponsor its
// adoption listing; this case is that request, from "asked" to "answered".
//
// Two cases, not one (design ADR-1). The sponsorship ITSELF is the existing
// `adoption_listing` case, which the accept transaction opens through the
// `adoption_eligibility_set(eligible=true)` attachment rule. This case closes
// in the same transaction that opens that one, so the two never coexist while
// open — the shadow-copy failure that killed the duplicated custody_dispute
// rows (case-kinds.ts) cannot recur here.
//
// Opens: atomically with the titular's request action — the welfare_denuncia
//   shape. NO pet_events opener: a pending request is workflow state, not a
//   fact about the animal (same rule as the absent `caretaker_proposed`).
// Terminal: TWO action-closes, no event terminal —
//   - the org's answer (src/modules/rehome/application/respond-to-rehome-request.ts):
//     accept → resolved, decline → cancelled;
//   - the titular's own cancel before an answer
//     (src/modules/rehome/application/withdraw-rehome-request.ts) → cancelled.
//   Both flip `cases.status` from the action; nothing on the spine does.
//   `manualCloseAllowed` stays false: that flag is the admin/govt GENERIC close
//   button on the case detail, and this request is the parties' to close, not
//   an operator's. `rehome_sponsorship_started` attaches to THIS case
//   (requires-open) and is written one step before the accept's close, while
//   the case is still open.
// Cron: NONE in v1. No expiry, on purpose — the titular is never blocked from
//   withdrawing, so nothing needs a deadline (design risk R3 is accepted).
//
// HOW THE THREE OUTCOMES ARE TOLD APART — do not add a fifth closed_reason.
// `CASE_CLOSED_REASONS` is a closed four-value set (db/schema.ts):
//
//   | Outcome                           | closedReason | closedByUserId        |
//   |-----------------------------------|--------------|-----------------------|
//   | Accepted by the org               | resolved     | the accepting member  |
//   | Declined by the org               | cancelled    | the declining member  |
//   | Withdrawn by the titular (pre-accept) | cancelled | the titular           |
//
// The last two share a reason and are distinguished by the actor already on
// the row, plus a `case_closed` timeline entry whose notes name the org when
// it declined (spec REQ-5: a decline must read differently from "you cancelled
// this" and from an operator's administrative close).

import type { CaseLifecycle } from "./types";

export const rehomeRequestLifecycle: CaseLifecycle = {
  kind: "rehome_request",
  statusValues: ["open", "closed"],
  // Opened atomically with the request action, not by a pet_events insert —
  // the welfare_denuncia shape. Stays empty so the attachment helper never
  // tries to auto-open it from an event.
  opensEvents: [],
  // Closed by the answering action, never by an event insert. The clause
  // below is what the case detail shows in place of a close button — the
  // machine-readable half of the "TWO action-closes" paragraph above.
  terminalEvents: [],
  actionCloseProse:
    "la organización responde la solicitud (la acepta o la rechaza) o el titular la cancela antes de que respondan",
  cronCloseRoute: null,
  cronCloseScheduleHours: 24,
  // Same sense as welfare_denuncia: the kind has no event opener, so the
  // coverage invariant ("no manual open ⇒ at least one opensEvent") is
  // satisfied by declaring the action-open explicitly.
  manualOpenAllowed: true,
  manualCloseAllowed: false,
  // A new request opens a new case.
  reopenAllowed: false,
};
