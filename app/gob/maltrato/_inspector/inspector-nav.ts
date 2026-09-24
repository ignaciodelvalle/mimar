// inspector-nav — shallow-history URL state for the /gob/maltrato master-detail
// inspector (task #12). Selection lives in the URL (`?caso=<id>`, then
// `&mascota=<token>` for the pet drill) and is written via the NATIVE History
// API, NOT next/navigation's router.
//
// WHY native History: same router-hot-path defect the whole helper family works
// around (lib/ui/sheet-nav.ts docblock — Next 15.5.x can silently drop a
// router.push/replace soft navigation in production, engram #621/#622). A
// same-route pushState/replaceState updates useSearchParams() reactively WITHOUT
// an RSC fetch, so the queue Server Component NEVER re-runs — the list's tab
// (`?queue=`), keyset cursor (`?cursor=`) and scroll are physically preserved
// (DOM state in a never-unmounted node). `?caso=` is a third consumer of the
// same native-History family as sheet-nav + map-layer-nav; zero collision.
//
// HISTORY SEMANTICS (spec §Interaction & state preservation):
//   - FIRST selection from the list  → pushState (one new entry). Back strips
//     `?caso=` → the exact list state is restored.
//   - SUBSEQUENT selection (browsing) → replaceState (no history growth). Back
//     still closes the inspector in one press.
//   - Pet drill (`&mascota=`)        → pushState (its own entry). "← Volver a la
//     denuncia" = history.back() pops `mascota`, keeps `caso`.
//   - Inspector close (✕ / Esc)      → pop ALL entries this session pushed at
//     once (history.go(-depth)) so we land on the pre-inspector list state; if
//     nothing was pushed (deep-loaded `?caso=` via SSR), replaceState strips.
//
// `pushedDepth` is module-scoped: this file is only imported by "use client"
// components, so its lifetime matches a single page load — exactly the scope the
// counter needs (mirrors sheet-nav's `openedViaPush`).

let pushedDepth = 0;

/**
 * Select a case. `currentHasCaso` = does the CURRENT URL already carry `?caso=`?
 * First open pushes a history entry; browsing to another case replaces in place.
 */
export function selectCaso(url: string, currentHasCaso: boolean): void {
  if (typeof window === "undefined") return;
  if (currentHasCaso) {
    window.history.replaceState(null, "", url);
  } else {
    pushedDepth += 1;
    window.history.pushState(null, "", url);
  }
}

/** Drill into the subject pet — always its own history entry (back pops it). */
export function openMascota(url: string): void {
  if (typeof window === "undefined") return;
  pushedDepth += 1;
  window.history.pushState(null, "", url);
}

/** Pop exactly one pushed entry (pet "← Volver a la denuncia"). */
export function popMascota(): void {
  if (typeof window === "undefined") return;
  if (pushedDepth > 0) pushedDepth -= 1;
  window.history.back();
}

/**
 * Close the inspector entirely (✕ / Esc). Pops every entry this session pushed
 * so we return to the exact pre-inspector list state; if none were pushed (the
 * inspector opened from a deep-loaded/SSR `?caso=`), strips the params in place.
 */
export function closeInspector(cleanListUrl: string): void {
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
 * Reconcile the pushed-entry counter after a browser-driven popstate. When the
 * URL no longer carries `?caso=`, the inspector is closed by definition, so any
 * remaining pushed depth is stale — reset it. Called by the mounter's popstate
 * listener so a manual browser Back can't desync the next selection.
 */
export function syncDepthAfterPop(urlHasCaso: boolean): void {
  if (!urlHasCaso) pushedDepth = 0;
}

/** Test-only: reset the module-scoped counter between it() blocks. */
export function __resetInspectorNavForTests(): void {
  pushedDepth = 0;
}
