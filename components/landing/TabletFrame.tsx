// Tablet frame for the landing story's org-portal chapters (the vet's
// "Vacuna" chapter and the refugio's own steps of "Refugio") — the device
// itself signals who is using the system (PO 2026-09-29): a tablet running
// the organization's web portal, next to the owner's phone everywhere else in
// the story.
//
// ONE device for both organizations (PO 2026-09-30): the vet and the refugio
// render this exact component — same geometry, same bezel, same chrome. The
// only thing that differs is the case colour, which the wrapping
// `.lp-seq-case[data-actor]` sets through --lp-case (app/landing.css). Drawn to
// read as a real modern tablet: the case around a uniform slim black bezel
// with concentric corners, a front camera centred on the long bezel, top and
// volume keys as slight bumps on the case edge, an edge highlight, an inner
// screen edge and a barely visible glass reflection. Decorative chrome only,
// no text node, all aria-hidden with the frame.
//
// ONE fixed size, always, same rule as PhoneFrame: no size-variant props. The
// intrinsic frame is scaled down uniformly with `zoom` at the story's own
// mobile breakpoint (app/landing.css, 940px) so both org-portal chapters
// render at the identical size at every viewport.

import type { ReactNode } from "react";

export function TabletFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lp-tablet" aria-hidden="true">
      <span className="lp-tablet-key lp-tablet-key--top" />
      <span className="lp-tablet-key lp-tablet-key--vol-up" />
      <span className="lp-tablet-key lp-tablet-key--vol-down" />
      <span className="lp-tablet-bezel" />
      <span className="lp-tablet-cam" />
      <div className="lp-tab-scr">{children}</div>
      <span className="lp-tablet-edge" />
      <span className="lp-tablet-glass" />
    </div>
  );
}
