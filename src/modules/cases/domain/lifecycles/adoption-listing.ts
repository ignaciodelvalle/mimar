// adoption_listing lifecycle (lifecycles spec §8).
//
// Opens: adoption_eligibility_set with eligible=true (a refugio marks
// the pet as eligible — opens one listing per (pet, org)).
// Terminal: adoption_eligibility_set with eligible=false (withdraw),
// adoption_finalized triggers post-adoption followup window, the cron
// closes when followup expires.
// Reopen: adoption_reversed does NOT reopen the listing (PO decision,
// commit 406c049f). On reversal the pet returns to the finalizing org's
// custody UN-LISTED; the org must explicitly re-publish via a new
// adoption_eligibility_set(eligible=true), which opens a listing through
// the normal opensEvents path above. reopenAllowed=true is declared here
// per the L4 spec but has no wired reopen code path today — do not read
// it as "adoption_reversed reopens automatically."

import type { CaseLifecycle } from "./types";

export const adoptionListingLifecycle: CaseLifecycle = {
  kind: "adoption_listing",
  statusValues: ["open", "closed"],
  opensEvents: [
    {
      eventType: "adoption_eligibility_set",
      whenPayload: (p) => p.eligible === true,
    },
  ],
  terminalEvents: ["adoption_eligibility_set"],
  cronCloseRoute: "/api/cron/close-followup-expired-adoptions",
  cronCloseScheduleHours: 24,
  manualOpenAllowed: false,
  // Nadie documentó una política de cierre manual para este kind.  no
  // es una prohibición decidida: es la ausencia de una decisión escrita.
  manualCloseAllowed: false,
  reopenAllowed: true,
};
