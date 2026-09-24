"use client";

// HoverTip — accessible hover/focus tooltip (WAI-ARIA tooltip pattern).
//
// Shows `content` when the trigger is hovered OR keyboard-focused; dismisses on
// mouseleave / blur / Escape. The trigger wrapper is focusable (tabIndex 0) so
// keyboard users reach it, and it points at the tip via aria-describedby while
// open so screen readers announce the description. No enter/leave animation, so
// it is reduced-motion-safe by construction.
//
// Uses the same light "card popover" surface as OpKpi's ⓘ tooltip (bg-ln-card /
// border-ln-line / shadow-lg) so the two read as one system. Distinct from that
// ⓘ, which is CLICK-toggled and dense; this is the lightweight HOVER label for:
//   - a glossary term (an acronym like "ENO" expands on hover) — red-team P2.5
//   - an icon-only control that has no always-visible label — red-team P1.3
//   - a ranking-row / map preview (rich content on hover) — red-team P1.3
//
// v1 positions the tip centered ABOVE the trigger; it does not yet flip/shift at
// the viewport edge, and is not portalled (an ancestor `overflow:hidden` will
// clip it) — both are deliberate v2 refinements to add if a call site needs them.

import { type ReactNode, useId, useState } from "react";

export function HoverTip({
  content,
  children,
  className,
  /** Tailwind width class for the tip box. Default fits a short definition. */
  width = "w-64",
}: {
  /** The tip body — a short definition, label, or rich preview. */
  content: ReactNode;
  /** The trigger (a term, an icon, a row). */
  children: ReactNode;
  /** Extra classes for the inline trigger wrapper. */
  className?: string;
  width?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={["relative inline-flex items-center", className].filter(Boolean).join(" ")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tooltip trigger must be keyboard-focusable (focus reveals the tip); the rule's autofix would remove it and break keyboard access.
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 ${width} rounded-lg border border-ln-line bg-ln-card p-2.5 text-sm font-normal leading-snug text-ln-ink shadow-lg`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
