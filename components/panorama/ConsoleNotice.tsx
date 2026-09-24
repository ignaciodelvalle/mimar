"use client";

// One-line dismissable console notice — the shared chrome for the board-state
// notes above the KPI strip ("Editaste la vista", "Continuando tu vista
// anterior.", "El período volvió a …"). One component so the three notes can't
// drift in markup, a11y semantics or button tokens (lint:buttons).

import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { OpButton } from "@/components/ui/dashboard/OpButton";

type Props = {
  onDismiss: () => void;
  dismissLabel?: string;
  children: ReactNode;
};

export function ConsoleNotice({ onDismiss, dismissLabel = "Descartar aviso", children }: Props) {
  return (
    <output
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe px-2.5 py-1.5 text-xs text-ln-op-ink-2"
    >
      {children}
      <OpButton
        variant="ghost"
        size="sm"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="-my-1 ml-auto px-1.5 py-1 text-ln-op-mute hover:text-ln-op-ink"
      >
        <Icon name="close" size="sm" decorative />
      </OpButton>
    </output>
  );
}
