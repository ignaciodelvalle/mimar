// Phone frame for the landing story devices. Decorative chrome only, drawn to
// read as a real modern phone (PO 2026-09-30): the actor's case around a slim
// black bezel with concentric corners, a dynamic-island camera, volume and
// power keys as slight bumps on the case edge, an edge highlight, and a
// status bar of signal / wifi / battery GLYPHS. The chrome carries no text
// node at all: every string inside a device must be one the product renders
// (__tests__/flagship-pampa-consistency.test.tsx), so no clock, no carrier.
// Content is responsive — no transform scaling.
//
// ONE fixed size, always (PO 2026-09-29): the `short` variant (dueño chapter)
// and the `tall` variant (libreta chapter, 760px) both used to make one
// chapter's phone visibly different from the rest of the story — the PO
// reversed both. A screen whose real content runs longer than 640px (the
// libreta) now scrolls or clips inside the SAME frame, the way the real app's
// own screen would, instead of growing the frame around it. The chrome is
// absolutely positioned, so it never moves that size either.

import type { ReactNode } from "react";

/** Signal bars, wifi arcs and a battery, as one 60×12 SVG. No text. */
function StatusGlyphs() {
  return (
    <svg
      className="lp-phone-status"
      viewBox="0 0 60 12"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <rect x="0" y="8" width="3" height="4" rx="0.8" />
      <rect x="4.5" y="6" width="3" height="6" rx="0.8" />
      <rect x="9" y="3.5" width="3" height="8.5" rx="0.8" />
      <rect x="13.5" y="1" width="3" height="11" rx="0.8" />
      <path d="M29 11.6 26.9 9.4a3 3 0 0 1 4.2 0Z" />
      <path
        d="M24.6 7.1a6.2 6.2 0 0 1 8.8 0M22.4 4.8a9.4 9.4 0 0 1 13.2 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <rect
        x="40.5"
        y="1.5"
        width="16"
        height="9"
        rx="2.6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.45"
      />
      <rect x="42.3" y="3.3" width="10.4" height="5.4" rx="1.3" />
      <path d="M58.2 4.4v3.2a1.6 1.6 0 0 0 0-3.2Z" fillOpacity="0.45" />
    </svg>
  );
}

export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lp-phone" aria-hidden="true">
      <span className="lp-phone-key lp-phone-key--vol-up" />
      <span className="lp-phone-key lp-phone-key--vol-down" />
      <span className="lp-phone-key lp-phone-key--power" />
      <div className="lp-scr">{children}</div>
      <span className="lp-phone-bezel" />
      <span className="lp-phone-island" />
      <StatusGlyphs />
      <span className="lp-phone-home" />
    </div>
  );
}
