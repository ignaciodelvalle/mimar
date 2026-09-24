// custody_episode lifecycle (decomiso spec §4.2 — activated from deferred per DC10).
//
// Represents the period a pet is in temporary institutional custody:
// from shelter_intake_recorded (shelter intake or govt seizure) until the
// custody ends via handoff, adoption, return to owner, or death.
//
// Opens: shelter_intake_recorded (the physical intake moment).
// Terminals: custody_transferred (handoff to another org / return to owner),
//            adoption_finalized (pet adopted while in custody),
//            death_recorded — decomiso spec §13.4 lists it as a direct
//              close trigger for the episode; attachment spec §8 has no
//              cascade-emit entry for death_recorded + custody_episode, so
//              the server action that records death closes this case directly
//              rather than via a cascade-emitted closer.
// No auto-close cron — the expiry cron for decomiso handoffs only emits
// escalation notifications, it does NOT close the episode automatically
// (decomiso spec DC8 + §13.5: cron notifies govt/admin, humans resolve).
// Manual close: allowed (admin/govt can cancel decomiso per DC authority).
// No reopen — each new custody period opens a fresh episode.

import type { CaseLifecycle } from "./types";

export const custodyEpisodeLifecycle: CaseLifecycle = {
  kind: "custody_episode",
  statusValues: ["open", "closed"],
  opensEvents: [
    {
      eventType: "shelter_intake_recorded",
    },
  ],
  // death_recorded is a direct terminal per decomiso spec §13.4. The
  // attachment spec §8 cascade table has no entry for
  // death_recorded + custody_episode, so there is no cascade-emitted
  // closer — the server action that records death closes this case directly.
  terminalEvents: ["custody_transferred", "adoption_finalized", "death_recorded"],
  // No cron close — the decomiso handoff cron only escalates (§13.5).
  cronCloseRoute: null,
  cronCloseScheduleHours: 0,
  manualOpenAllowed: true,
  // Único de los doce con política de cierre manual DOCUMENTADA: el spec de
  // decomiso da a admin/govt la autoridad de cancelar (DC).
  manualCloseAllowed: true,
  reopenAllowed: false,
};
