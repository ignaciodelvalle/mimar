// sheet-nav — client-side URL state machine for the pet profile's
// quick-capture sheets (pet-document-redesign, router-hot-path fix).
//
// WHY: Next.js 15.5.x's App Router has a known production-mode defect where
// a Link/router.push soft navigation's own fetch can resolve 200 with a
// fully valid payload, yet the client router silently drops it — no
// history.pushState, no re-render, no error (engram #621, verify-report
// #617 CRITICAL-1). On the pet profile this made the Anotar icon fail
// 3/3 in production. The sheets are the profile's primary interaction
// surface, so the router must never sit on their hot path.
//
// FIX: open/close sheets via the native History API directly instead of
// router.push/router.replace/<Link> navigation. Next's App Router patches
// window.history.pushState/replaceState on mount specifically to support
// this ("shallow routing"): calling them on the SAME route updates
// usePathname()/useSearchParams() reactively WITHOUT a server round-trip —
// there is no RSC fetch to drop, so the defect cannot reproduce.
// https://nextjs.org/docs/app/api-reference/functions/use-router (native
// History API / shallow routing).
//
// Only use these helpers for same-route transitions — `?sheet=` (the
// original router-hot-path fix) and, as of the face-flip/tab-button fix,
// `?tab=`/`?lente=` (the pet profile's Credencial|Libreta face switch). A
// target URL on a DIFFERENT route (e.g. a full /eventos/nuevo/* page) is a
// real navigation and must go through next/navigation's router as usual —
// see isSameRouteUrl.

/**
 * Set to true by pushSheetUrl() and read by closeSheetNav() to decide
 * between `history.back()` (undo our own pushState) and `replaceState`
 * (the sheet was open from a direct URL load / SSR, so closing must not
 * traverse history away from the profile). Module-scoped: this file is
 * only ever imported by "use client" components, so its lifetime matches
 * a single page load — exactly the scope this flag needs.
 */
let openedViaPush = false;

/**
 * Opens a sheet by pushing `url` onto the history stack. `url` must target
 * the SAME route as the current page (only search params differ) so Next's
 * shallow-routing patch picks it up reactively — see module docblock.
 */
export function pushSheetUrl(url: string): void {
  if (typeof window === "undefined") return;
  openedViaPush = true;
  window.history.pushState(null, "", url);
}

/**
 * Closes the currently open sheet.
 *
 * - If the open sheet was reached via pushSheetUrl() during this page's
 *   lifetime, pops that history entry (`back()`) so the back button and the
 *   sheet's own close ("×") button stay consistent — both undo the same
 *   history step.
 * - Otherwise (the sheet was open from a direct URL load / SSR — e.g. a
 *   bookmarked or shared `?sheet=` link), there is no pushed entry to pop:
 *   `replaceState` strips the param in place so closing never navigates
 *   away from the profile.
 */
export function closeSheetNav(closeUrl: string): void {
  if (typeof window === "undefined") return;
  if (openedViaPush) {
    window.history.back();
  } else {
    window.history.replaceState(null, "", closeUrl);
  }
}

/**
 * Closes the currently open sheet via a FULL document navigation instead of
 * closeSheetNav()'s history-API shallow close.
 *
 * Use this (not closeSheetNav) when the sheet's action just mutated
 * server-rendered content elsewhere on the page that a shallow close does
 * NOT re-fetch — e.g. EmergencyContactSheet saving `profiles.emergency_*`,
 * which LibretaFace's EmergenciaBlock (a Server Component) renders as part
 * of page.tsx's initial SSR output. The server action already calls
 * revalidatePath(), but that only marks the RSC cache stale — nothing in
 * this shallow-routing architecture ever issues the follow-up RSC fetch
 * that would pick it up, so the card kept showing the old phone until a
 * hard reload.
 *
 * `router.refresh()` is NOT a safe substitute: it goes through the SAME
 * client-router transition machinery as router.push/replace, so it's
 * exposed to the identical silent-drop defect this whole module exists to
 * route around (engram #621/#622, reproduced 3/3 in production for the
 * Anotar icon before this file existed). A full document navigation is the
 * one mechanism proven immune — same reasoning JurisdictionSwitcher.tsx and
 * PeriodPicker.tsx use for their own post-mutation `window.location.assign`.
 */
export function closeSheetNavWithFullReload(closeUrl: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(closeUrl);
}

/**
 * Switches the pet profile's active face/tab (`?tab=`/`?lente=`) by pushing
 * `url` onto the history stack — same primitive as pushSheetUrl, same
 * router-hot-path rationale (module docblock), and the same reason it must
 * be `pushState` rather than `replaceState`: a face switch needs its own
 * history entry so the browser back button can undo it (restoring the prior
 * face via popstate → useSearchParams() reactivity), the same way back
 * already undoes an opened sheet.
 *
 * `url` must target the SAME route as the current page (only `tab`/`lente`
 * search params differ) — see isSameRouteUrl.
 *
 * Used by the "Girar" flip affordance (PetDetailTabsPanel) and the
 * Credencial|Libreta tab buttons (PetDetailTabs) so both click paths agree
 * on the same ?tab= write and never touch router.push/router.replace.
 */
export function pushTabUrl(url: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", url);
}

/**
 * Normalizes the pet profile's active face/tab URL (`?tab=`/`?lente=`)
 * WITHOUT pushing a new history entry — i.e. `replaceState`, not
 * `pushState`.
 *
 * Use this (not pushTabUrl) for a SILENT, one-time normalization the user
 * didn't ask for — e.g. PetDetailTabsPanel's legacy `#hash`→`?tab=` mount
 * migration. That migration fires because the URL is stale/legacy, not
 * because the user took a new navigation action; pushTabUrl would add a
 * spurious history entry the back button would have to skip through to get
 * back to wherever the user actually came from. pushTabUrl remains correct
 * for an explicit user-driven face switch (the "Girar" affordance / tab
 * buttons), which DOES want its own undo-able history entry — see
 * pushTabUrl's docblock.
 *
 * `url` must target the SAME route as the current page (only `tab`/`lente`
 * search params differ) — see isSameRouteUrl. Same router-hot-path
 * rationale as the rest of this module (module docblock): native History
 * API instead of router.replace, since Next's App Router patches
 * window.history.replaceState on mount to support shallow routing.
 */
export function replaceTabUrl(url: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", url);
}

/**
 * True when `targetUrl`'s pathname matches `currentPathname` — i.e. the
 * target is a same-route `?sheet=` shorthand reachable via shallow routing
 * (pushSheetUrl). False for a genuinely different route (a full page),
 * which must use a real navigation (router.push) instead.
 */
export function isSameRouteUrl(currentPathname: string, targetUrl: string): boolean {
  const targetPath = targetUrl.split("?")[0].split("#")[0];
  return targetPath === currentPathname;
}

/**
 * Test-only escape hatch: resets the module-scoped `openedViaPush` flag.
 * Production code never needs this (the flag's lifetime naturally matches
 * one page load); unit tests importing this module across multiple `it()`
 * blocks do, since the module instance is shared within a test file.
 */
export function __resetSheetNavStateForTests(): void {
  openedViaPush = false;
}
