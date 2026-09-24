"use client";

// OverlayDisclosure — the v2C overlay-popover primitive: a native <details>
// whose panel floats absolutely over the map (spec: menus/popovers radio 8px,
// shadow, close on Esc / outside click; Esc returns focus to the trigger).
//
// WHY <details> and not conditional rendering: the panel content stays in the
// DOM while closed (native disclosure semantics — the same pattern the
// masthead's "Acerca de esta vista" and the old "Alcance y período" rail
// disclosure used), so the content is always reachable/testable and the
// browser owns the summary-toggle interaction. Esc + outside-click close are
// layered on top; `closeSignal` lets the owner close it when a selection
// commits (e.g. a preset pick).

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

type Props = {
  /** The always-visible trigger (pill) content. */
  summary: ReactNode;
  /** Classes for the summary pill (the trigger's whole visual). */
  summaryClassName: string;
  /** Extra classes for the floating panel (positioning side, width). */
  panelClassName?: string;
  /** Open direction: panel hangs below (down) or above (up) the trigger. */
  side?: "down" | "up";
  /**
   * Close the panel whenever this value CHANGES (not on mount) — e.g. the
   * active preset id, so picking an option dismisses the menu.
   */
  closeSignal?: unknown;
  /** Optional test id on the summary trigger. */
  summaryTestId?: string;
  /**
   * CONTROLLED mode (opt-in). Pass both to let an owner share ONE open-panel
   * state with sibling surfaces — the panorama ContextBar does this so the scope
   * disclosure, the rail panels and the bar segments can never be open at the
   * same time, and so a keyboard user opening another segment closes this one.
   *
   * Omit both and the component stays uncontrolled (LegendPill's usage), which
   * is why every internal close path routes through `setOpen` rather than the
   * state setter: Esc, outside-click and `closeSignal` behave identically in
   * both modes, including the focus restore.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Explicit id for the floating panel, mirrored as `aria-controls` on the
   * trigger. Native <details> already exposes its expanded state, but not every
   * AT/browser pair reports it, and the panorama's other disclosures (the rail,
   * the ContextBar) all state it explicitly — so state it here too.
   */
  panelId?: string;
  children: ReactNode;
};

export function OverlayDisclosure({
  summary,
  summaryClassName,
  panelClassName = "",
  side = "down",
  closeSignal,
  summaryTestId,
  open: controlledOpen,
  onOpenChange,
  panelId,
  children,
}: Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  // Every close path (toggle, Esc, outside-click, closeSignal) goes through
  // this, so controlled and uncontrolled modes cannot drift.
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );
  const rootRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);

  // Close when the owner's selection commits. Skip the mount pass.
  const firstSignalRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: closeSignal is the intentional sole trigger.
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    // Restore focus to the trigger ONLY when the commit happened from the OPEN
    // panel (the keyboard path: e.g. arrowing a <select>). If the panel was
    // already closed (a commit from elsewhere, e.g. clicking a province on the
    // map), don't steal focus. Mirrors the Escape handler's focus-return so a
    // keyboard user isn't dropped to <body> after a scope commit (WCAG 2.4.3).
    const wasOpen = rootRef.current?.open ?? false;
    setOpen(false);
    if (wasOpen) summaryRef.current?.focus();
  }, [closeSignal]);

  // Esc closes (returning focus to the trigger); a click/press outside closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        summaryRef.current?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, setOpen]);

  return (
    <details
      ref={rootRef}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="relative"
    >
      <summary
        ref={summaryRef}
        data-testid={summaryTestId}
        aria-expanded={open}
        aria-controls={panelId}
        className={`cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden ${summaryClassName}`}
      >
        {summary}
      </summary>
      {/* MOT-4b / Gap 6 (motion audit 2026-08-04): `op-panel-enter`, not
          `op-disclosure`. This panel is ABSOLUTELY POSITIONED over a live map,
          so the grid-row expand that fixes the in-flow accordions would animate
          a box this panel has already escaped. What it was missing is a
          directional cue about which pill it belongs to — which is exactly the
          8px settle + fade already applied to the sibling ContextBar panel. */}
      <div
        id={panelId}
        className={`op-panel-enter absolute z-30 rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card p-3 shadow-lg ${
          side === "down" ? "top-full mt-1.5" : "bottom-full mb-1.5"
        } ${panelClassName}`}
      >
        {children}
      </div>
    </details>
  );
}
