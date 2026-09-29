// Simplified tablet frame for the landing story's org-portal chapters (the
// vet's "Vacuna" chapter and the refugio's own steps of "Refugio") — the
// device itself signals who is using the system (PO 2026-09-29): a landscape
// tablet running the organization's web portal, next to the owner's phone
// everywhere else in the story. Decorative chrome only (a camera dot; no
// home indicator — org tablets don't carry the owner app's one).
//
// ONE fixed size, always, same rule as PhoneFrame: no size-variant props. The
// intrinsic frame is scaled down uniformly with `zoom` at the story's own
// mobile breakpoint (app/landing.css, 940px) so both org-portal chapters
// render at the identical size at every viewport.

import type { ReactNode } from "react";

export function TabletFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lp-tablet" aria-hidden="true">
      <span className="lp-tablet-cam" />
      <div className="lp-tab-scr">{children}</div>
    </div>
  );
}
