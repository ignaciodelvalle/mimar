// OpStatusPill — canonical status primitive for operator surfaces.
//
// ONE geometry: --radius-op-chip, font-ln-mono, unified size/tracking.
// Tone resolves directly to st-* design tokens; no per-component overrides.
//
// Usage: thin domain wrappers (CaseStatusBadge, OpStateBadge, OpPill) map
// their domain enum → tone and delegate all rendering here.
//
// A11y: icon (if any) is aria-hidden; the label/children are the accessible name.

import type { ReactNode } from "react";

export type StatusTone = "st-ok" | "st-warn" | "st-err" | "st-info" | "neutral";

export const TONE_CLASSES: Record<StatusTone, string> = {
  "st-ok": "bg-[var(--color-st-ok-bg)] text-[var(--color-st-ok)] border-[var(--color-st-ok-bd)]",
  "st-warn":
    "bg-[var(--color-st-warn-bg)] text-[var(--color-st-warn)] border-[var(--color-st-warn-bd)]",
  "st-err":
    "bg-[var(--color-st-err-bg)] text-[var(--color-st-err)] border-[var(--color-st-err-bd)]",
  "st-info":
    "bg-[var(--color-st-info-bg)] text-[var(--color-st-info)] border-[var(--color-st-info-bd)]",
  neutral: "bg-ln-op-stripe text-ln-op-mute border-ln-op-line",
};

interface Props {
  tone: StatusTone;
  children: ReactNode;
  /** Optional decorative icon (e.g. <Icon .../>); wrapped aria-hidden automatically. */
  icon?: ReactNode;
}

/**
 * Canonical status primitive for all operator status surfaces.
 *
 * Geometry: --radius-op-chip · font-ln-mono · text-xs (10px) bold uppercase
 * 0.06em tracking. Said "9px" until 2026-08-10 while rendering text-xs, which
 * --text-xs pins at 10px (globals.css:251). Naming the TOKEN instead of a
 * pixel value is what keeps the two from drifting apart again.
 * Color: resolved via st-* tokens (remapped to ln-op-* under .op-surface).
 *
 * Do not use this component directly in feature code — prefer the domain-
 * specific wrappers: CaseStatusBadge, OpStateBadge, OpPill.
 */
export function OpStatusPill({ tone, children, icon }: Props) {
  return (
    <span
      className={[
        "inline-flex items-center gap-[3px] rounded-[var(--radius-op-chip)] border px-[7px] py-0.5",
        "font-ln-mono text-xs font-bold uppercase tracking-[0.06em]",
        TONE_CLASSES[tone],
      ].join(" ")}
    >
      {icon && (
        <span aria-hidden="true" className="inline-flex items-center">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
