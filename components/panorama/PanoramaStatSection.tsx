"use client";

// PanoramaStatSection — C3: a visually-bounded, collapsible section for one
// Estadísticas widget (CalendarHeatmap, Ranking). The dock's stats pane used to
// stack its widgets with only vertical spacing between them, so where one ended
// and the next began was ambiguous. Each widget now sits in its own LnCard-like
// bordered card with a clear header and a per-widget collapse control.
//
// Collapse state is COMPONENT-local (useState): the dock's URL/view state has no
// slot for per-widget disclosure and threading two booleans through it (plus the
// saved-view round-trip) is not trivially supported — so it lives here, resetting
// to the default on remount, which is the honest, low-risk choice (C3 brief).
//
// Presentational shell only. English identifiers, es-AR user copy (invariant #4).

import { type ReactNode, useId, useState } from "react";

import { Icon } from "@/components/Icon";

type Props = {
  /** es-AR section header (e.g. "Actividad por día"). */
  title: string;
  /** Optional one-line context under the header. */
  subtitle?: string;
  /** Whether the section starts expanded (default true). */
  defaultOpen?: boolean;
  children: ReactNode;
};

export function PanoramaStatSection({ title, subtitle, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <section className="rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-t-[var(--radius-lg)] px-3 py-2 text-left hover:bg-ln-op-stripe"
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-ln-op-ink">{title}</span>
          {subtitle && <span className="text-xs leading-snug text-ln-op-mute">{subtitle}</span>}
        </span>
        <Icon
          name={open ? "chevron-up" : "chevron-down"}
          size="sm"
          decorative
          className="flex-none text-ln-op-mute"
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-ln-op-line-2 px-3 py-2.5">
          {children}
        </div>
      )}
    </section>
  );
}
