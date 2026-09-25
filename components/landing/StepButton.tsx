"use client";

// The landing's one step-list button, shared by the story rail and the
// chapter sequences' step lists. One component, so the raw-button ratchet
// (scripts/check-raw-buttons.mjs) counts one literal for every step list the
// story draws, and every step list keeps the same keyboard contract: a real
// <button>, `aria-current="step"` on the active one.

import type { ReactNode } from "react";

export function StepButton({
  active,
  onSelect,
  className,
  children,
  ...data
}: {
  active: boolean;
  onSelect: () => void;
  className: string;
  children: ReactNode;
  "data-s"?: string;
  "data-state"?: string;
}) {
  return (
    <button
      type="button"
      className={active ? `${className} on` : className}
      onClick={onSelect}
      aria-current={active ? "step" : undefined}
      {...data}
    >
      {children}
    </button>
  );
}
