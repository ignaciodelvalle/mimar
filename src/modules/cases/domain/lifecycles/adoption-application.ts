// adoption_application lifecycle (lifecycles spec §9).
//
// Per-applicant case — one per (pet, applicant_user_id). Opens at
// adoption_application_submitted; closes at adoption_application_resolved
// (manual approve/reject) or via the F5.5 cascade when another applicant
// wins the adoption_finalized.
// No reopen (a new postulation opens a new case).
// No auto-close cron — closure always comes from an explicit event.

import type { CaseLifecycle } from "./types";

export const adoptionApplicationLifecycle: CaseLifecycle = {
  kind: "adoption_application",
  statusValues: ["open", "closed"],
  opensEvents: [
    {
      eventType: "adoption_application_submitted",
    },
  ],
  terminalEvents: ["adoption_application_resolved"],
  cronCloseRoute: null,
  cronCloseScheduleHours: 24,
  manualOpenAllowed: false,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: false,
};
