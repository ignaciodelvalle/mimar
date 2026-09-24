// bite_incident lifecycle (lifecycles spec §5).
//
// Opens: incident_reported with incident_type='bite_inflicted'. Atomic
// with the rabies_observation_started emit.
// Terminal: rabies_observation_ended. Cron emits the negative outcome
// at day 11 (12h cron schedule) if no escalation happened.
// Escalated: symptom_observed with rabies-high-spec match → status='escalated'.
// No reopen, no manual open.

import type { CaseLifecycle } from "./types";

export const biteIncidentLifecycle: CaseLifecycle = {
  kind: "bite_incident",
  statusValues: ["open", "escalated", "closed"],
  opensEvents: [
    {
      eventType: "incident_reported",
      whenPayload: (p) => p.incident_type === "bite_inflicted",
    },
  ],
  terminalEvents: ["rabies_observation_ended"],
  cronCloseRoute: "/api/cron/close-rabies-observations",
  cronCloseScheduleHours: 12,
  manualOpenAllowed: false,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: false,
};
