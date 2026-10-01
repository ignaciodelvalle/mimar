// Phone frame for the landing story devices. Decorative chrome only, drawn to
// read as a real modern phone (PO 2026-09-30): the actor's case around a slim
// black bezel with concentric corners, a dynamic-island camera, volume and
// power keys as slight bumps on the case edge, and an edge highlight. No
// status bar (PO 2026-10-01: the signal / wifi / battery glyphs came out). The
// chrome carries no text node at all: every string inside a device must be
// one the product renders (__tests__/flagship-pampa-consistency.test.tsx), so
// no clock, no carrier. Content is responsive — no transform scaling.
//
// ONE fixed size, always (PO 2026-09-29): the `short` variant (dueño chapter)
// and the `tall` variant (libreta chapter, 760px) both used to make one
// chapter's phone visibly different from the rest of the story — the PO
// reversed both. A screen whose real content runs longer than 640px (the
// libreta) now scrolls or clips inside the SAME frame, the way the real app's
// own screen would, instead of growing the frame around it. The chrome is
// absolutely positioned, so it never moves that size either.

import type { ReactNode } from "react";

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lp-phone" aria-hidden="true">
      <span className="lp-phone-key lp-phone-key--vol-up" />
      <span className="lp-phone-key lp-phone-key--vol-down" />
      <span className="lp-phone-key lp-phone-key--power" />
      <div className="lp-scr">{children}</div>
      <span className="lp-phone-bezel" />
      <span className="lp-phone-island" />
      <span className="lp-phone-home" />
    </div>
  );
}
