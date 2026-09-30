"use client";

// The landing's one step-list button, shared by the story rail and the
// chapter sequences' step lists. One component, so the raw-button ratchet
// (scripts/check-raw-buttons.mjs) counts one literal for every step list the
// story draws, and every step list keeps the same keyboard contract: a real
// <button>, `aria-current="step"` on the active one. The chapter sequences'
// ‹ › controls use it too: no `active`, an aria-label for the icon-only
// button, and a real `disabled` at either end of the sequence.

import type { ReactNode } from "react";

export function StepButton({
  active = false,
  onSelect,
  className,
  children,
  label,
  disabled,
  ...data
}: {
  active?: boolean;
  onSelect: () => void;
  className: string;
  children: ReactNode;
  /** Accessible name, for an icon-only button. */
  label?: string;
  disabled?: boolean;
  "data-s"?: string;
  "data-state"?: string;
}) {
  return (
    <button
      type="button"
      className={active ? `${className} on` : className}
      onClick={onSelect}
      aria-current={active ? "step" : undefined}
      aria-label={label}
      disabled={disabled}
      {...data}
    >
      {children}
    </button>
  );
}
