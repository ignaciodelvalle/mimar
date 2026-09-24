"use client";

// SavedViewsPopover — named bookmarks for the panorama console (task #66b).
//
// Thin wrapper pinning the shared SavedViewsControl (components/ui/dashboard/
// SavedViewsControl.tsx — extracted Fase C 2026-07-21 so the OpFilterBar
// dashboards can reuse the exact same popover instead of forking it) to
// Panorama's own storage key and its v2C light-chrome trigger look. Sits in
// the map's briefing chrome next to "Copiar vista".
//
// English identifiers, es-AR user copy (project invariant #4).

import { SAVED_VIEWS_KEY } from "@/components/panorama/saved-views";
import { SavedViewsControl } from "@/components/ui/dashboard/SavedViewsControl";

// v2C light chrome (dark skin retired) — matches the sibling briefing actions.
const CHROME_BTN =
  "rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card px-2.5 py-1 text-xs font-medium text-ln-op-ink-2 hover:bg-ln-op-stripe";

export function SavedViewsPopover() {
  return <SavedViewsControl storageKey={SAVED_VIEWS_KEY} triggerClassName={CHROME_BTN} />;
}
