"use client";

// ContextBar — the panorama's ONE visible, persistent answer to the decision
// maker's first question: "¿qué estoy mirando y de qué período?".
//
// WHY THIS EXISTS (demo readiness, 2026-08-01): that answer used to be spread
// across four-to-six surfaces — the floating scope pill on the left, the Período
// and Capas panels behind icons on the right rail, the trimmed meta line above
// the KPI chips, the dock's meta line, and the Registros caption. A funcionario
// had to HUNT for it. The bar states scope · period · layers on one row, above
// the map, always.
//
// WHY ITS OWN FILE: PanoramaConsole is over the file-size ratchet's budget and
// the fence's standing instruction is to EXTRACT, never to feed it.
//
// WHAT IT IS NOT: a second control surface. Every segment is a disclosure that
// opens the panel that ALREADY exists — the console passes the very same
// `render()` closure the right rail uses, and the console owns ONE open-panel
// state shared by the bar, the rail and the scope disclosure. There is never a
// second instance of a panel, and never two panels open at once. The rail keeps
// all of its entries: the bar is the reading shortcut, the rail is the full index.
//
// A11Y: each segment carries `aria-expanded` + `aria-controls`, and its VALUE is
// visible text. The sr-only-label anti-pattern that ScopePillSummary.tsx
// documents (assistive tech hears a named control, a sighted operator sees only
// a value) is not reintroduced here: the verb is sr-only, the value never is.
//
// MOBILE (~390px): one line with horizontally scrolling pills. The scroll
// container is only `overflow-x-auto` while NOTHING is open, because an
// overflow container would clip the floating panels — with a panel open the row
// goes back to `visible` so the panel can hang over the map, viewport-clamped,
// exactly the way the scope disclosure already behaves.

import { type ReactNode, useEffect, useId, useRef } from "react";

import { Icon } from "@/components/Icon";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { OpIconButton } from "@/components/ui/dashboard/OpIconButton";

export type ContextBarSegment = {
  /** Shared panel id — the SAME id space the rail uses, so one state governs both. */
  id: string;
  /**
   * The live value, rendered as VISIBLE text (e.g. "CABA · 5 localidades").
   * Never pass an sr-only-only value: see the module header.
   */
  value: ReactNode;
  /** Extra classes for the value span (e.g. `first-letter:uppercase`). */
  valueClassName?: string;
  /**
   * Names the act for assistive tech ("alcance", "período", "capas del mapa").
   * Rendered as an sr-only "Cambiar {changeLabel}. Actualmente:" prefix so the
   * accessible name LEADS with the verb while the value stays visible.
   *
   * Omit when `value` already carries its own accessible verb (ScopePillSummary
   * does) — passing both would announce the verb twice.
   */
  changeLabel?: string;
  /** Optional count badge (e.g. the modifiers-over-the-vista counter). */
  badge?: number;
  /** REQUIRED with `badge` — a bare integer must never announce itself unnamed. */
  badgeLabel?: string;
  /** Panel header title (es-AR). */
  panelTitle: string;
  /** The panel body — the console passes the rail item's own `render()`. */
  render: () => ReactNode;
};

type Props = {
  segments: readonly ContextBarSegment[];
  /**
   * The open panel id, or null. CONTROLLED by the console with the same state
   * the rail reads, so a panel opened here and the same panel opened from the
   * rail are one instance, not two.
   */
  open: string | null;
  onOpenChange: (id: string | null) => void;
  /**
   * A segment the console renders itself (the scope disclosure keeps its own
   * `<details>` markup so its content stays reachable while closed). Placed
   * first, outside the segment loop.
   */
  leading?: ReactNode;
  /**
   * "Copiar vista" — the console's EXISTING copy-the-deep-link action (the same
   * callback the Exportar rail panel fires) and its transient confirmation. The
   * button is stateless, so mounting it in both places costs nothing; the
   * saved-views popover is not, which is why it is mounted only here.
   */
  onCopyView: () => void;
  copied: boolean;
  /** The single instance of the saved-views popover. */
  savedViews: ReactNode;
};

export function ContextBar({
  segments,
  open,
  onOpenChange,
  leading,
  onCopyView,
  copied,
  savedViews,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelBaseId = useId();

  // Esc closes and returns focus to the trigger; a pointer outside closes. Same
  // non-modal idiom as PanoramaRail — the map stays live underneath, no dim, no
  // focus trap, no re-layout.
  useEffect(() => {
    if (open === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onOpenChange(null);
        triggerRefs.current[open as string]?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node | null)) onOpenChange(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, onOpenChange]);

  return (
    <div
      ref={rootRef}
      data-testid="panorama-context-bar"
      className="relative z-40 flex-shrink-0 border-b border-ln-op-line bg-ln-op-card px-3 py-1.5"
    >
      <div
        // See the module header: scroll ONLY while closed, so an open panel is
        // never clipped by its own container.
        className={`flex items-center gap-2 ${open === null ? "overflow-x-auto" : ""}`}
      >
        {leading}
        {segments.map((segment) => {
          const isOpen = open === segment.id;
          const panelId = `${panelBaseId}-${segment.id}`;
          return (
            <div key={segment.id} className="relative flex-shrink-0">
              <button
                type="button"
                ref={(el) => {
                  triggerRefs.current[segment.id] = el;
                }}
                data-testid={`panorama-context-${segment.id}`}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => onOpenChange(isOpen ? null : segment.id)}
                className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-sm font-medium ${
                  isOpen
                    ? "border-ln-op-azul bg-ln-op-azul/10 text-ln-op-azul"
                    : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe"
                }`}
              >
                {segment.changeLabel && (
                  <span className="sr-only">{`Cambiar ${segment.changeLabel}. Actualmente:`}</span>
                )}
                <span className={segment.valueClassName}>{segment.value}</span>
                {segment.badge != null && segment.badge > 0 && (
                  <span
                    // Never a bare integer: the badge states WHAT it counts, the
                    // same rule the rail badge follows (filtroBadgeAriaLabel).
                    aria-label={segment.badgeLabel}
                    title={segment.badgeLabel}
                    aria-hidden={segment.badgeLabel ? undefined : true}
                    className="inline-flex min-w-4 items-center justify-center rounded-full bg-ln-op-azul px-1 text-xs font-semibold tabular-nums text-white"
                  >
                    {segment.badge}
                  </span>
                )}
                <span aria-hidden="true" className="text-xs">
                  ▾
                </span>
              </button>
              {isOpen && (
                <ContextBarPanel
                  panelId={panelId}
                  title={segment.panelTitle}
                  onClose={() => {
                    onOpenChange(null);
                    triggerRefs.current[segment.id]?.focus();
                  }}
                >
                  {segment.render()}
                </ContextBarPanel>
              )}
            </div>
          );
        })}
        <div className="flex flex-shrink-0 items-center gap-1.5 sm:ml-auto">
          <OpButton
            variant="ghost"
            size="sm"
            onClick={onCopyView}
            className="flex-shrink-0 whitespace-nowrap"
          >
            <Icon name="enlace" size="sm" decorative /> Copiar vista
            {copied && <span className="text-ln-op-ok">· copiada</span>}
          </OpButton>
          {savedViews}
        </div>
      </div>
    </div>
  );
}

// The floating panel: non-modal, hanging below its segment over the map, width
// clamped to the viewport (the scope disclosure's existing behavior) so ~390px
// gets a full-width sheet instead of a horizontally clipped card.
function ContextBarPanel({
  panelId,
  title,
  onClose,
  children,
}: {
  panelId: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <div
      id={panelId}
      aria-labelledby={titleId}
      // A6 (motion review): op-panel-enter (globals.css) — 8px translateY +
      // fade on mount. Safe here: this div's own conditional {isOpen && ...}
      // render already mounts/unmounts it (no wrapper needed), and it is
      // absolutely positioned, so the transform doesn't perturb layout.
      className="op-panel-enter absolute left-0 top-full z-40 mt-1.5 flex max-h-[min(60dvh,28rem)] w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card shadow-lg"
    >
      <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-ln-op-line px-3 py-2">
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-ln-op-ink">
          {title}
        </h2>
        <OpIconButton onClick={onClose} aria-label="Cerrar" className="-mr-1.5">
          <Icon name="close" size="sm" decorative />
        </OpIconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  );
}
