"use client";

// ConsoleNoticeStack — the board-state notices above the KPI strip, with the
// WP2 cap: at most ONE notice renders by default (priority: restored board >
// period reset > personalizada); when several are simultaneously true the rest
// sit behind a "+N avisos" expander instead of stacking. Mutual exclusion was
// rejected on purpose — the personalizada notice carries the "Volver a" action
// and must stay reachable, never silently suppressed by a sibling.

import { useState } from "react";

import { ConsoleNotice } from "@/components/panorama/ConsoleNotice";
import { OpButton } from "@/components/ui/dashboard/OpButton";

type NoticeKey = "restored" | "period" | "personalizada";

type Props = {
  /** T1.6 — a bare URL reopened the operator's last board from localStorage. */
  restored: boolean;
  onDismissRestored: () => void;
  /** T2.7 — the preset reset the operator's explicit período (label), or null. */
  periodResetLabel: string | null;
  onDismissPeriodReset: () => void;
  /** #53 QOL — the vista left behind by a hand-edit (label), or null. */
  personalizadaLabel: string | null;
  onVolver: () => void;
  onDismissPersonalizada: () => void;
};

export function ConsoleNoticeStack({
  restored,
  onDismissRestored,
  periodResetLabel,
  onDismissPeriodReset,
  personalizadaLabel,
  onVolver,
  onDismissPersonalizada,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const active: NoticeKey[] = [
    ...(restored ? (["restored"] as const) : []),
    ...(periodResetLabel !== null ? (["period"] as const) : []),
    ...(personalizadaLabel !== null ? (["personalizada"] as const) : []),
  ];
  // Review F3 (2026-08-15): re-arm the cap once the stack empties — the stack
  // lives for the console's lifetime, so a sticky showAll would defeat the
  // one-notice cap for every future co-occurrence after the first expansion.
  const [prevCount, setPrevCount] = useState(active.length);
  if (prevCount !== active.length) {
    setPrevCount(active.length);
    if (active.length === 0 && showAll) setShowAll(false);
  }
  const primary = active[0] ?? null;
  const hiddenCount = showAll ? 0 : Math.max(0, active.length - 1);
  const visible = (key: NoticeKey): boolean => showAll || key === primary;
  return (
    <>
      {restored && visible("restored") && (
        <ConsoleNotice onDismiss={onDismissRestored}>
          <span>Continuando tu vista anterior.</span>
        </ConsoleNotice>
      )}
      {periodResetLabel !== null && visible("period") && (
        <ConsoleNotice dismissLabel="Descartar aviso de período" onDismiss={onDismissPeriodReset}>
          <span>El período volvió a {periodResetLabel} con la vista.</span>
        </ConsoleNotice>
      )}
      {personalizadaLabel !== null && visible("personalizada") && (
        <ConsoleNotice onDismiss={onDismissPersonalizada}>
          <span>
            Editaste la vista — ahora es <span className="font-semibold">personalizada</span>.
          </span>
          <OpButton
            variant="ghost"
            size="sm"
            onClick={onVolver}
            className="-my-1 px-1 py-1 font-semibold text-ln-op-azul underline-offset-2 hover:underline"
          >
            Volver a {personalizadaLabel}
          </OpButton>
        </ConsoleNotice>
      )}
      {hiddenCount > 0 && (
        <OpButton
          variant="ghost"
          size="sm"
          aria-expanded={showAll}
          onClick={() => setShowAll(true)}
          className="w-fit px-1 py-1 text-xs font-medium text-ln-op-azul hover:underline"
        >
          +{hiddenCount} {hiddenCount === 1 ? "aviso" : "avisos"}
        </OpButton>
      )}
    </>
  );
}
