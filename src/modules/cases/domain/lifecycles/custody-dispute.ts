// custody_dispute lifecycle (lifecycles spec §10).
//
// Opens: custody_dispute_raised (admin/govt only). Linked to a
// custody_disputes row.
// Terminal: custody_dispute_resolved (admin/govt only).
// Escalation cron: NO auto-close. Cron emits notifications for disputes
// open >365 days (escalation visible, not status change).
// No reopen — resolved disputes stay resolved.

import type { CaseLifecycle } from "./types";

export const custodyDisputeLifecycle: CaseLifecycle = {
  kind: "custody_dispute",
  statusValues: ["open", "escalated", "closed"],
  opensEvents: [
    {
      eventType: "custody_dispute_raised",
    },
  ],
  terminalEvents: ["custody_dispute_resolved"],
  cronCloseRoute: null,
  cronCloseScheduleHours: 24,
  // Owners can self-raise via /mis-mascotas/reclamar (P3-1, 2026-05-28).
  // Govt/admin still adjudicate resolution.
  manualOpenAllowed: true,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: false,
};
