// lost_pet_episode lifecycle (lifecycles spec §6).
//
// Opens: status_changed with to_status='lost'.
// Terminal: status_changed with to_status='active' (recovered) closes
// the episode atomically with the same event. Custody_transferred during
// the episode also closes via return-to-owner handshake.
// Auto-close: cron closes episodes inactive >60d AND open >365d (ADR-18,
// pet-document-redesign — raised from 180d so a lost pet can never silently
// expire in under a year). The closer deliberately does NOT reset
// pets.status, so the profile can still show status='lost' with no open
// episode; reactivateLostSearchAction (app/actions/reactivate-lost-search.ts)
// covers that case by opening a brand-new episode directly (a narrow,
// kind-specific carve-out — manualOpenAllowed stays false for the general
// open path below).
// No reopen — losing the pet again (or reactivating a stale search) opens a
// new episode; reopenAllowed stays false.

import type { CaseLifecycle } from "./types";

export const lostPetEpisodeLifecycle: CaseLifecycle = {
  kind: "lost_pet_episode",
  statusValues: ["open", "closed"],
  opensEvents: [
    {
      eventType: "status_changed",
      whenPayload: (p) => p.to_status === "lost",
    },
  ],
  terminalEvents: ["status_changed", "custody_transferred"],
  cronCloseRoute: "/api/cron/close-stale-lost-episodes",
  cronCloseScheduleHours: 24,
  manualOpenAllowed: false,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: false,
};
