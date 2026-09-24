// foster_placement lifecycle (lifecycles spec §11).
//
// Opens: foster_assigned. Often cascade-emitted from foster_proposal_resolved
// with outcome='accepted'.
// Terminal: foster_ended. Reason discriminates (returned / adopted /
// other_completion / other).
// No cron — placement ends when humans say so or via cascade
// (adoption_finalized, death_recorded).
// No reopen — new placement = new case.

import type { CaseLifecycle } from "./types";

export const fosterPlacementLifecycle: CaseLifecycle = {
  kind: "foster_placement",
  statusValues: ["open", "closed"],
  opensEvents: [
    {
      eventType: "foster_assigned",
    },
  ],
  terminalEvents: ["foster_ended"],
  cronCloseRoute: null,
  cronCloseScheduleHours: 24,
  manualOpenAllowed: false,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: false,
};
