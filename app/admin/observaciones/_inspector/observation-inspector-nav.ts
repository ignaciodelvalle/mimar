// observation-inspector-nav — shallow-history URL state for the
// /admin/observaciones inline-close inspector (structural convergence
// 2026-08-02: the list's "Cerrar profesionalmente" action opens an inline
// slide-over hosting CloseObservationForm instead of forcing a full
// navigation to the [publicToken] detail route — which stays as the
// deep-link fallback). Selection lives in the URL (`?cerrar=<publicToken>`)
// and is written via the NATIVE History API, NOT next/navigation's router —
// same router-hot-path defect the whole helper family works around
// (lib/ui/sheet-nav.ts docblock; app/gob/maltrato/_inspector/inspector-nav.ts
// is the proven template). A same-route pushState/replaceState updates
// useSearchParams() reactively WITHOUT an RSC fetch, so the list Server
// Component never re-runs — filters and scroll are physically preserved.
//
// This is a deliberate sibling of maltrato's inspector-nav rather than an
// import: that module's pushedDepth counter is module-scoped state shared by
// all its callers, and the two inspectors must never share a depth counter
// (a stale count from one page would desync the other's close). The state
// machine is the same, minus the pet drill (this inspector has no sub-view).
//
// HISTORY SEMANTICS:
//   - FIRST selection from the list  → pushState (one new entry). Back strips
//     `?cerrar=` → the exact list state is restored.
//   - SUBSEQUENT selection (browsing) → replaceState (no history growth).
//   - Inspector close (✕ / Esc)      → pop the pushed entry (history.go) so
//     we land on the pre-inspector list state; if nothing was pushed
//     (deep-loaded `?cerrar=` via SSR), replaceState strips in place.

let pushedDepth = 0;

/**
 * Select an observation to close. `currentHasCerrar` = does the CURRENT URL
 * already carry `?cerrar=`? First open pushes a history entry; browsing to
 * another observation replaces in place.
 */
export function selectObservacion(url: string, currentHasCerrar: boolean): void {
  if (typeof window === "undefined") return;
  if (currentHasCerrar) {
    window.history.replaceState(null, "", url);
  } else {
    // At most ONE pushed entry per inspector session: this branch only runs
    // when the current URL has no `?cerrar=` (so nothing is pushed yet), and
    // pushState makes it carry one — a subsequent select hits the replaceState
    // branch above. `= 1` (not `+= 1`) so close() always pops exactly one,
    // even if two selects race before the URL reflects the first push.
    pushedDepth = 1;
    window.history.pushState(null, "", url);
  }
}

/**
 * Close the inspector (✕ / Esc). Pops every entry this session pushed so we
 * return to the exact pre-inspector list state; if none were pushed (the
 * inspector opened from a deep-loaded/SSR `?cerrar=`), strips the param in
 * place.
 */
export function closeObservationInspector(cleanListUrl: string): void {
  if (typeof window === "undefined") return;
  if (pushedDepth > 0) {
    const depth = pushedDepth;
    pushedDepth = 0;
    window.history.go(-depth);
  } else {
    window.history.replaceState(null, "", cleanListUrl);
  }
}

/**
 * Reconcile the pushed-entry counter after a browser-driven popstate. When
 * the URL no longer carries `?cerrar=`, the inspector is closed by
 * definition, so any remaining pushed depth is stale — reset it.
 */
export function syncDepthAfterPop(urlHasCerrar: boolean): void {
  if (!urlHasCerrar) pushedDepth = 0;
}

/** Test-only: reset the module-scoped counter between it() blocks. */
export function __resetObservationInspectorNavForTests(): void {
  pushedDepth = 0;
}
