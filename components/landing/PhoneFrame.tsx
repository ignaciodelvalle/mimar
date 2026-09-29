// Simplified phone frame for the landing story devices. Decorative chrome
// only (island + home indicator); the handoff's full iOS frame is prototype
// tooling and is not ported. Content is responsive — no transform scaling.
//
// ONE fixed size, always (PO 2026-09-29): the `short` variant (dueño chapter)
// and the `tall` variant (libreta chapter, 760px) both used to make one
// chapter's phone visibly different from the rest of the story — the PO
// reversed both. A screen whose real content runs longer than 640px (the
// libreta) now scrolls or clips inside the SAME frame, the way the real app's
// own screen would, instead of growing the frame around it.

import type { ReactNode } from "react";

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lp-phone" aria-hidden="true">
      <span className="lp-phone-island" />
      <div className="lp-scr">{children}</div>
      <span className="lp-phone-home" />
    </div>
  );
}
