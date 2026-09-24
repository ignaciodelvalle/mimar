"use client";

// PanoramaRail — the v3 vertical modifier rail (task #38 item 1 + 2).
//
// A single floating column of LARGE icon buttons pinned to the RIGHT edge of the
// map, replacing the v2C top-left (Vista/Capas) and top-right (period/actions)
// clusters. Icons top-to-bottom: Vista · Filtro · Período · Línea de tiempo ·
// Exportar · Actualizar · Acerca. The scope pill is NOT in the rail (it stays
// floating over the map — the keyboard path); zoom stays bottom-right.
//
// ONE uniform floating panel pattern (item 2): every "panel" item opens the SAME
// non-modal RailPanel — anchored to the rail, Esc closes + restores focus to the
// trigger, outside-click closes, the map stays LIVE underneath (no dim, no
// re-layout). This is the OverlayDisclosure idiom formalized for the rail; the
// two candidate shells the PO named (the anotar Vaul sheet, the DetailDrawer
// <dialog>) are both MODAL — they dim/trap/block the map, which violates the
// "map stays dominant + never re-layouts" invariant — so neither is used here.
// The Simple/Detalle toggle is opt-in per panel (panorama QA root-cause #2/
// 3a/5/6): only Capas carries it (layers legitimately have a simple-vs-
// detailed view); Vista/Período/Exportar/Acerca always render full detail.
// "action" items (Línea de tiempo, Actualizar) fire immediately with no panel.
//
// Controlled: the console owns `open` so only ONE panel is ever open (the
// "Acerca" icon here is the sole methodology entry point — #49 item 10).

import { type ReactNode, useEffect, useId, useRef } from "react";

import { Icon } from "@/components/Icon";
import { SimpleDetalleToggle } from "@/components/panorama/SimpleDetalleToggle";

export type RailPanelItem = {
  id: string;
  /** Icon name (components/Icon.tsx). */
  icon: string;
  /** aria-label + tooltip + panel title (es-AR). */
  label: string;
  kind: "panel";
  /** Optional count badge over the icon (e.g. the Filtro modifier counter). */
  badge?: number;
  /**
   * Accessible name + tooltip for the badge (Item 3). Without it the bare number
   * reads as a layer count; with it a screen reader / hover announces WHAT the
   * number means (e.g. "2 ajustes sobre la vista"). Absent → the badge stays
   * aria-hidden (decorative), announced through the trigger's own label.
   */
  badgeLabel?: string;
  /** Simple (false) / Detalle (true). */
  detail: boolean;
  /**
   * Present → the panel header renders the Simple/Detalle toggle. Absent →
   * no toggle (panorama QA root-cause #2/3a/5/6: the toggle earns its place
   * only on Capas, where simple-vs-detailed is a real information-density
   * choice; Vista/Período/Exportar/Acerca always render full detail, so
   * callers omit this and pass `detail: true`).
   */
  onDetailChange?: (detail: boolean) => void;
  /** Panel body for the current tier. */
  render: (detail: boolean) => ReactNode;
};

export type RailActionItem = {
  id: string;
  icon: string;
  label: string;
  kind: "action";
  onClick: () => void;
  /** Reflected as aria-pressed (e.g. the timeline tab being open). */
  active?: boolean;
  disabled?: boolean;
};

export type RailItem = RailPanelItem | RailActionItem;

type Props = {
  items: readonly RailItem[];
  /** The open panel id, or null. Controlled by the console. */
  open: string | null;
  onOpenChange: (id: string | null) => void;
};

export function PanoramaRail({ items, open, onOpenChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelBaseId = useId();

  // Esc closes (restoring focus to the trigger); a pointer/press outside closes.
  // Non-modal: no focus trap, the map stays interactive underneath.
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

  const activeItem = items.find((i): i is RailPanelItem => i.id === open && i.kind === "panel");

  return (
    <div ref={rootRef} className="absolute right-3.5 top-3.5 z-20">
      <div className="relative">
        <div
          role="toolbar"
          aria-label="Controles del panorama"
          aria-orientation="vertical"
          className="flex flex-col gap-1 rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card p-1 shadow-lg"
        >
          {items.map((item) => {
            const isOpen = item.kind === "panel" && open === item.id;
            const panelId = `${panelBaseId}-${item.id}`;
            return (
              <button
                key={item.id}
                type="button"
                ref={(el) => {
                  triggerRefs.current[item.id] = el;
                }}
                title={item.label}
                aria-label={item.label}
                aria-expanded={item.kind === "panel" ? isOpen : undefined}
                aria-controls={item.kind === "panel" ? panelId : undefined}
                aria-pressed={item.kind === "action" ? (item.active ?? undefined) : undefined}
                disabled={item.kind === "action" ? item.disabled : undefined}
                onClick={() => {
                  if (item.kind === "action") item.onClick();
                  else onOpenChange(isOpen ? null : item.id);
                }}
                className={`relative flex h-11 w-11 items-center justify-center rounded-[var(--radius-md)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  isOpen || (item.kind === "action" && item.active)
                    ? "bg-ln-op-azul/10 text-ln-op-azul"
                    : "text-ln-op-ink-2 hover:bg-ln-op-stripe"
                }`}
              >
                <Icon name={item.icon} size="lg" decorative />
                {item.kind === "panel" && item.badge != null && item.badge > 0 && (
                  <span
                    // Item 3: the bare number masqueraded as a layer count. When a
                    // badgeLabel is provided it becomes the badge's accessible name
                    // + tooltip ("N ajustes sobre la vista"); otherwise the badge is
                    // decorative and announced via the trigger's own aria-label.
                    aria-label={item.badgeLabel}
                    title={item.badgeLabel}
                    aria-hidden={item.badgeLabel ? undefined : true}
                    className="absolute -right-0.5 -top-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-ln-op-azul px-1 text-xs font-semibold tabular-nums text-white"
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {activeItem && (
          <RailPanel
            item={activeItem}
            panelId={`${panelBaseId}-${activeItem.id}`}
            onClose={() => {
              onOpenChange(null);
              triggerRefs.current[activeItem.id]?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
}

// The single uniform floating panel — non-modal, anchored to the LEFT of the rail
// (right-full), top-aligned, with an internal-scroll body (spec: the Filtro must
// scroll INSIDE the viewport, never overflow below it).
function RailPanel({
  item,
  panelId,
  onClose,
}: {
  item: RailPanelItem;
  panelId: string;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <div
      id={panelId}
      aria-labelledby={titleId}
      className="absolute right-full top-0 mr-2 flex max-h-[calc(100dvh-8rem)] w-[min(23rem,calc(100vw-6rem))] flex-col rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card shadow-lg"
    >
      <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-ln-op-line px-3 py-2">
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-ln-op-ink">
          {item.label}
        </h2>
        <div className="flex flex-shrink-0 items-center gap-2">
          {item.onDetailChange && (
            <SimpleDetalleToggle
              detail={item.detail}
              onChange={item.onDetailChange}
              labelSuffix={`de ${item.label}`}
            />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-[var(--radius-md)] border border-ln-op-line px-2 py-1 text-sm text-ln-op-ink-2 hover:bg-ln-op-stripe focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul"
          >
            <Icon name="close" size="sm" decorative />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{item.render(item.detail)}</div>
    </div>
  );
}
