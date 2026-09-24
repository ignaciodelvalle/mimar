"use client";

// SavedViewsControl — named bookmarks, shared by EVERY searchParam-driven
// dashboard (Fase C, saved-views, 2026-07-21).
//
// The full popover UI (name input, save, list, apply, delete) started as
// Panorama's SavedViewsPopover (task #66b) and now lives HERE as the single
// shared presentational primitive — Panorama's own component
// (components/panorama/SavedViewsPopover.tsx) is a thin wrapper pinning
// `storageKey`/`triggerClassName` to its own values, and OpFilterBar renders
// this directly via its `savedViewsKey` prop. One implementation, two skins
// (via `triggerClassName`), so a fix/improvement here reaches both instead of
// drifting into two parallel copies (the exact island-avoidance this
// extraction was for — see dim-interno:docs/reviews/results/2026-07-19-plan-maestro-consistencia.md
// §"Fase C").
//
// Sits next to "Copiar vista" (OpFilterBar) / "Copiar vista" (Panorama) —
// that button already yields the full, reproducible view URL (period +
// jurisdiction + every domain axis are searchParams); this lets the operator
// NAME and keep those views: save the current URL under a name, then list /
// apply / delete. localStorage only (client preference, no backend, no
// migration) — via the shared lib/ui/saved-views + lib/ui/use-saved-views
// primitives.
//
// Applying a view does a full navigation (window.location.assign) rather than
// a client-router push — every OpFilterBar screen is a Server Component that
// reads searchParams per request (no App Router client-side re-fetch path
// here), so a hard nav is the ONLY way a stored view faithfully reproduces
// itself. This mirrors OpFilterBar's own commit model (serverNavCommit).
//
// English identifiers, es-AR user copy (project invariant #4).

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { OpInput } from "@/components/ui/dashboard/OpField";
import { useSavedViews } from "@/lib/ui/use-saved-views";

export type SavedViewsControlProps = {
  /**
   * Storage key scoping this screen's saved views — MUST be stable and
   * unique per screen/console (e.g. "op-saved-views:perdidas:v1",
   * "panorama:views:v1") so one screen's bookmarks never leak into another's
   * list. Bump the trailing version segment only on a breaking shape change.
   */
  storageKey: string;
  /**
   * Overrides the trigger button's classes — lets a caller match its OWN
   * surrounding chrome (Panorama's briefing rail vs OpFilterBar's header)
   * without forking the popover markup. Defaults to the OpFilterBar-header
   * look (matches CopyViewButton).
   */
  triggerClassName?: string;
  className?: string;
};

const TRIGGER_BTN =
  "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-ln-op-line " +
  "px-2 py-1 text-xs font-medium text-ln-op-ink-2 transition-colors " +
  "hover:bg-ln-op-stripe hover:text-ln-op-ink " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul";

export function SavedViewsControl({
  storageKey,
  triggerClassName = TRIGGER_BTN,
  className = "",
}: SavedViewsControlProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const { views, refresh, save, remove } = useSavedViews(storageKey);

  // Re-read on open — the list may have changed in another tab/session.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Close on Escape or an outside click while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const saveCurrent = useCallback(() => {
    if (typeof window === "undefined") return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    save(trimmed, window.location.href);
    setName("");
  }, [name, save]);

  const applyView = useCallback((url: string) => {
    if (typeof window === "undefined") return;
    window.location.assign(url);
  }, []);

  return (
    <div ref={rootRef} className={["relative", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        Vistas guardadas
      </button>
      {open && (
        // The trigger's aria-controls + aria-expanded establish this region; its
        // controls are individually labelled, so the container needs no role.
        <div
          id={panelId}
          className="absolute right-0 top-full z-30 mt-2 w-64 space-y-2 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-2 text-ln-op-ink-2 shadow-lg"
        >
          <div className="flex items-center gap-1.5">
            <OpInput
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCurrent();
              }}
              placeholder="Nombre de la vista"
              aria-label="Nombre de la vista a guardar"
              className="min-w-0 flex-1"
              size="xs"
              block={false}
            />
            <button
              type="button"
              onClick={saveCurrent}
              disabled={name.trim().length === 0}
              className="shrink-0 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe px-2 py-1 text-xs font-medium text-ln-op-ink-2 hover:bg-ln-op-line/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Guardar
            </button>
          </div>
          {views.length === 0 ? (
            <p className="px-1 py-1 text-xs text-ln-op-mute">
              Guardá la vista actual (período, jurisdicción, filtros) con un nombre para volver más
              tarde.
            </p>
          ) : (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto">
              {views.map((v) => (
                <li key={v.name} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => applyView(v.url)}
                    className="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] px-2 py-1 text-left text-xs text-ln-op-ink hover:bg-ln-op-stripe"
                    title={`Aplicar "${v.name}"`}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(v.name)}
                    aria-label={`Eliminar la vista ${v.name}`}
                    className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-1 text-xs text-ln-op-mute hover:bg-ln-op-stripe hover:text-ln-op-ink"
                  >
                    <Icon name="close" size="sm" decorative />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
