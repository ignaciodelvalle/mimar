// custody_transfer_handshake lifecycle (cross-org-transfer-ux spec §12).
//
// Two-phase handshake refugio→refugio:
//   Phase 1 (Proposal): sender emits custody_transfer_proposed → opens
//   the case in `proposed_awaiting_acceptance` phase.
//   Phase 2 (Accept): receiver emits custody_transferred → closes the
//   case with closed_reason='resolved' AND flips ownerships in the
//   same tx. Reject / Cancel / auto-expiry (30d) close as 'cancelled'.
//
// Reopen: NO — once closed, a new proposal starts a fresh case.

import type { CaseLifecycle } from "./types";

export const custodyTransferHandshakeLifecycle: CaseLifecycle = {
  kind: "custody_transfer_handshake",
  statusValues: ["open", "closed"],
  opensEvents: [
    {
      eventType: "custody_transfer_proposed",
    },
  ],
  terminalEvents: ["custody_transferred"],
  cronCloseRoute: "/api/cron/expire-cross-org-transfers",
  cronCloseScheduleHours: 24,
  manualOpenAllowed: false,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: false,
};
