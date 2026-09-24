"use client";

// PanoramaDock — the v2C floating data dock (dim-interno:docs/design/handoffs/
// 2026-07-11-panorama-v2C, "Dock inferior flotante").
//
// A collapsible panel FLOATING over the map's bottom edge (absolute overlay —
// the MapLibre canvas NEVER resizes when it expands; spec no-negociable #4).
// Collapsed (the default — PO: "MÁS MAPA, la lista es opcional"): a slim bar
// with the tab row (Registros carries a live record count), the board meta
// ("Córdoba · últimos 90 días · 2 capas"), an optional CSV action and the
// expand toggle. Expanded: 42% of the map container's height, growing UP over
// the map, body scrolls internally. Clicking any tab while collapsed expands.
//
// Presentational shell only — the console owns the state (open/tab) and the
// pane contents arrive as slots (Registros = the MapDataTable projection,
// Estadísticas = the RankedUnitsPanel/PanoramaDataTable ranking, Línea de
// tiempo = the real TimeScrubber with its temporal gating).
//
// English identifiers, es-AR user copy (project invariant #4).

import { Fragment, type ReactNode, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { OpButton } from "@/components/ui/dashboard/OpButton";

export type PanoramaDockTab = "registros" | "stats" | "referencias" | "timeline";

const TAB_LABELS: Record<PanoramaDockTab, string> = {
  stats: "Estadísticas",
  registros: "Registros",
  referencias: "Referencias",
  timeline: "Línea de tiempo",
};

// PO order: Estadísticas · Registros ‖ Referencias · Línea de tiempo — the DATA
// pair (what happened) then a subtle divider then the TOOLS pair (how to read
// the map / replay it over time). The divider renders between "registros" and
// "referencias" (see the tablist map below); it is decorative only, never a tab.
const TAB_ORDER: readonly PanoramaDockTab[] = ["stats", "registros", "referencias", "timeline"];

type Props = {
  /** Expanded (true) or the collapsed slim bar (false — the default state). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active pane. */
  tab: PanoramaDockTab;
  onTabChange: (tab: PanoramaDockTab) => void;
  /** Live record count shown in the Registros tab badge. */
  recordCount: number;
  /** Board meta line: scope · period · layer count. */
  meta: string;
  /** Optional CSV action rendered in the bar (e.g. a download link). */
  csvAction?: ReactNode;
  /** Pane contents (rendered only while expanded; the active one shows). */
  registros: ReactNode;
  stats: ReactNode;
  /** The map's scale legends (MapLegends) — the "how to read the map" pane. */
  referencias: ReactNode;
  timeline: ReactNode;
  /**
   * The timeline is PLAYING. Collapses the dock to the moving line so the map
   * it is animating stays visible. Ignored on every other tab.
   */
  timelinePlaying?: boolean;
  /**
   * Q6/P3.3: the opened link named a layer that no longer exists
   * (`droppedLayerIds` in PanoramaConsole) — PanoramaBoardNotices renders the
   * full warning, but that component lives INSIDE the "Línea de tiempo" pane
   * (`timeline` prop), so the warning was only ever visible while the dock
   * was open AND on that one tab. A compact badge on the bar surfaces the
   * fact that the notice exists whenever the full text is not on screen.
   */
  hasUnknownLayerNotice?: boolean;
};

export function PanoramaDock({
  open,
  onOpenChange,
  tab,
  onTabChange,
  recordCount,
  meta,
  csvAction,
  registros,
  stats,
  referencias,
  timeline,
  timelinePlaying = false,
  hasUnknownLayerNotice = false,
}: Props) {
  const panes: Record<PanoramaDockTab, ReactNode> = { registros, stats, referencias, timeline };

  // Roving tabindex (WAI-ARIA APG tab pattern, MANUAL activation): only one tab
  // is Tab-stoppable — the active one, or the tab the operator has arrowed to.
  // Left/Right/Home/End move FOCUS between tabs without switching the pane;
  // Enter/Space (native button activation via onClick) commit the switch. This
  // mirrors PresetPanel's radiogroup and gives role="tablist" the arrow-key
  // navigation a screen-reader user expects (WCAG 2.1.1 / ARIA APG conformance).
  const selectedIndex = Math.max(0, TAB_ORDER.indexOf(tab));
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rovingIndex = focusIndex ?? selectedIndex;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTabAt(index: number) {
    const clamped = (index + TAB_ORDER.length) % TAB_ORDER.length;
    setFocusIndex(clamped);
    tabRefs.current[clamped]?.focus();
  }

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTabAt(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTabAt(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTabAt(0);
        break;
      case "End":
        e.preventDefault();
        focusTabAt(TAB_ORDER.length - 1);
        break;
      default:
        // Enter/Space fall through to the native button click (onClick), which
        // commits the tab — manual activation (selection does NOT follow focus).
        break;
    }
  }

  return (
    <section
      aria-label="Datos de la vista"
      data-testid="panorama-dock"
      // op-dock (globals.css): the collapsed height + the open/close transition
      // (CSS-2 — v2C handoff "dock height .18s ease"). Only the COLLAPSED
      // length lives in the class; the EXPANDED heights below stay inline.
      className="op-dock absolute inset-x-3.5 bottom-3.5 z-20 flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card shadow-lg"
      // 42% of the MAP CONTAINER (the positioned ancestor) when expanded, BUT
      // capped to leave 26rem of clearance at the top so the expanded dock never
      // covers the top-left cluster (scope→vista→números→modo) on short viewports
      // — red-team-admin-2 P1.4 (the Capas/Per-cápita toggle lives at the bottom
      // of that cluster and was getting painted over). On tall maps 42% still
      // wins. Height lives here (not a class) because the token ratchet bans new
      // arbitrary values.
      //
      // EXCEPT the timeline (PO 2026-08-01). Every other pane is read INSTEAD of
      // the map — you look down at a table, a ranking, a legend. The timeline is
      // the only one you drive WHILE watching the map: you drag the scrubber to
      // see the country change. Giving it the same 42% covers the very thing it
      // exists to animate, and the taller the viewport the more it hides.
      //
      // So it sizes to its content (scrubber + ticks + basis selector ≈ 22% of a
      // typical map) under the SAME ceiling, instead of claiming a fixed share.
      // A ceiling and not a fixed height because the histogram and the notices
      // above it are conditional — pinning a number would either clip them or
      // leave a gap on the frames that have neither.
      //
      // CSS-2 risk accepted: this branch's `height: "auto"` cannot transition
      // (no resolvable start/end length) — opening/closing the dock WHILE on
      // the Línea de tiempo tab does not animate, unlike the other three tabs.
      // `maxHeight` on this same branch DOES transition (see .op-dock), so the
      // playing/not-playing swap still animates; only the open/close pop is
      // inert here. Not fixed with `interpolate-size` (repo-wide ban).
      style={
        open
          ? tab === "timeline"
            ? {
                height: "auto",
                // Playing: hand the map back as much as the line can spare. The
                // config controls are already folded away by then (TimeScrubber
                // gates them on !playing), so this ceiling is not clipping
                // anything — it is refusing to hold space for what is gone.
                maxHeight: timelinePlaying ? "14rem" : "min(42%, calc(100% - 26rem))",
              }
            : { height: "min(42%, calc(100% - 26rem))" }
          : undefined
      }
    >
      {/* flex-nowrap + a scrollable tablist (mobile-polish 2026-07): the old
          flex-wrap + overflow-hidden combo silently clipped tabs into
          truncation at 390px ("Línea de…"). The tab row now scrolls
          horizontally inside the bar (op-scroll = the repo's thin visible
          scrollbar affordance, + scroll snap) while the meta/CSV/expand
          cluster stays pinned right. >=md everything fits and nothing scrolls. */}
      <div className="flex h-10 flex-shrink-0 flex-nowrap items-center gap-x-2 overflow-hidden border-b border-ln-op-line-2 pl-3 pr-2">
        <span aria-hidden="true" className="flex-none text-ln-op-faint">
          ≡
        </span>
        <div
          role="tablist"
          aria-label="Paneles de datos"
          className="op-scroll flex h-full min-w-0 flex-1 snap-x items-stretch overflow-x-auto"
          onBlur={(e) => {
            // Focus left the whole tablist → drop the roving position so a later
            // Tab-in lands on the SELECTED tab again (APG).
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIndex(null);
          }}
        >
          {TAB_ORDER.map((key, index) => {
            const isActive = key === tab;
            return (
              <Fragment key={key}>
                {/* DATA | TOOLS boundary: a subtle separator between the data
                    panes (Estadísticas, Registros) and the tool panes
                    (Referencias, Línea de tiempo) — decorative only, not a
                    tab, so it never enters the roving-tabindex/arrow-key nav. */}
                {key === "referencias" && (
                  <span
                    aria-hidden="true"
                    className="my-2 w-px flex-none self-stretch bg-ln-op-line-2"
                  />
                )}
                <button
                  id={`pano-dock-tab-${key}`}
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  // The tabpanel is ALWAYS in the DOM now (hidden when collapsed),
                  // so aria-controls is a valid IDREF in both states — completing
                  // the WAI-ARIA tablist/tab/tabpanel contract the APG expects
                  // (prev: panel rendered only while expanded, so the relationship
                  // had to be dropped when collapsed — a11y review round 2).
                  aria-controls="pano-dock-panel"
                  // Roving tabindex: only the active/arrowed tab is Tab-stoppable.
                  tabIndex={index === rovingIndex ? 0 : -1}
                  onKeyDown={(e) => handleTabKeyDown(e, index)}
                  onClick={() => {
                    onTabChange(key);
                    // Sync the roving position to the clicked tab so a later
                    // Tab-in / arrow-nav starts from where the mouse last acted
                    // (prev: click left focusIndex stale, so mixed mouse+keyboard
                    // could leave tabIndex={0} on the wrong tab — a11y review).
                    setFocusIndex(index);
                    // Spec: clicking any tab while collapsed also expands.
                    if (!open) onOpenChange(true);
                  }}
                  className={`inline-flex flex-none snap-start snap-always items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm transition-colors ${
                    isActive
                      ? "border-ln-op-azul font-semibold text-ln-op-azul"
                      : "border-transparent text-ln-op-ink-2 hover:text-ln-op-ink"
                  }`}
                >
                  {TAB_LABELS[key]}
                  {key === "registros" && (
                    // T4.4: the bare pill reads as an event count, but it counts
                    // TABLE ROWS (units × layers, P4-U1) — name that so it stops
                    // contradicting the event totals shown elsewhere in the dock.
                    <span
                      className="rounded-full bg-ln-op-azul/10 px-1.5 text-xs font-medium tabular-nums text-ln-op-azul"
                      title="Filas en la tabla (unidades × capas), no eventos."
                      aria-label={`${recordCount.toLocaleString("es-AR")} filas en la tabla (unidades × capas), no eventos`}
                    >
                      {recordCount.toLocaleString("es-AR")}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="ml-auto flex flex-none items-center gap-2">
          {/* Q6/P3.3: the full "capa que ya no existe" warning lives inside the
              Línea de tiempo pane (PanoramaBoardNotices), so it is invisible
              whenever the dock isn't open on that exact tab — which is most of
              the time, including the entire collapsed state. This badge says
              the notice exists even when its text doesn't fit anywhere. */}
          {hasUnknownLayerNotice && !(open && tab === "timeline") && (
            <span
              className="inline-flex flex-none items-center rounded-full border border-ln-op-warn-bd bg-ln-op-warn-bg px-1.5 py-0.5 text-xs font-medium leading-none text-ln-op-warn"
              title="Este enlace pedía una capa que ya no existe. Abrí Línea de tiempo para ver el aviso completo."
            >
              <Icon name="alerta" size={12} decorative />
              <span className="sr-only">
                Aviso: este enlace pedía una capa que ya no existe. Abrí Línea de tiempo para ver el
                detalle.
              </span>
            </span>
          )}
          <span className="hidden text-xs tabular-nums text-ln-op-mute md:inline">{meta}</span>
          {csvAction}
          <OpButton
            size="sm"
            variant="ghost"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
          >
            {open ? "▾ Colapsar" : "▴ Expandir"}
          </OpButton>
        </div>
      </div>
      {/* The tabpanel is ALWAYS rendered (hidden while collapsed) so the
          tablist/tab/tabpanel APG contract is complete in both states and
          aria-controls always resolves. `hidden` removes it from the a11y tree
          and the layout when collapsed, so the slim bar keeps its height. */}
      <div
        id="pano-dock-panel"
        role="tabpanel"
        aria-labelledby={`pano-dock-tab-${tab}`}
        hidden={!open}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-3"
      >
        {open ? panes[tab] : null}
      </div>
    </section>
  );
}
