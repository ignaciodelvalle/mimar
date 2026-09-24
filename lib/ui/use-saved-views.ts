"use client";

// useSavedViews — the client-state wrapper around lib/ui/saved-views' pure
// storage primitive. One hook, one storage key per screen: pass a stable,
// screen-scoped `storageKey` (e.g. "op-saved-views:perdidas:v1") and the hook
// owns the load/save/delete round-trip against localStorage, keeping React
// state in sync so the popover re-renders immediately after each mutation.
//
// Shared by both consumers of the saved-views primitive:
//   - components/panorama/SavedViewsPopover.tsx (Panorama console — could
//     migrate onto this hook; kept on its own thin wrapper for now since it
//     predates this extraction and already has passing tests)
//   - components/ui/dashboard/SavedViewsControl.tsx (OpFilterBar dashboards)

import { useCallback, useEffect, useState } from "react";

import {
  type SavedView,
  loadSavedViews,
  persistSavedViews,
  removeView,
  upsertView,
} from "@/lib/ui/saved-views";

export type UseSavedViewsResult = {
  /** Newest-first list of saved views for this storage key. */
  views: SavedView[];
  /** Re-reads from localStorage (e.g. on popover open — another tab may have changed it). */
  refresh: () => void;
  /** Saves `url` under `name` (trims, replaces an existing same-name entry, moves to front). */
  save: (name: string, url: string) => void;
  /** Deletes the view with the given exact name. */
  remove: (name: string) => void;
};

export function useSavedViews(storageKey: string): UseSavedViewsResult {
  const [views, setViews] = useState<SavedView[]>([]);

  // Load once on mount (client-only — SSR has no localStorage).
  useEffect(() => {
    setViews(loadSavedViews(storageKey));
  }, [storageKey]);

  const refresh = useCallback(() => {
    setViews(loadSavedViews(storageKey));
  }, [storageKey]);

  const save = useCallback(
    (name: string, url: string) => {
      const next = upsertView(loadSavedViews(storageKey), name, url, Date.now());
      persistSavedViews(storageKey, next);
      setViews(next);
    },
    [storageKey],
  );

  const remove = useCallback(
    (name: string) => {
      const next = removeView(loadSavedViews(storageKey), name);
      persistSavedViews(storageKey, next);
      setViews(next);
    },
    [storageKey],
  );

  return { views, refresh, save, remove };
}
