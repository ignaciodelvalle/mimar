// capture-nav — shared same-route/cross-route classification for the
// quick-capture flow (CaptureBox).
//
// WHY: same-route `?sheet=`/`?tab=` targets go through pushSheetUrl (History
// API, no router — see lib/ui/sheet-nav.ts for the router-hot-path
// rationale), while a genuinely different route (a full `/eventos/nuevo/*`
// page) is a real navigation via next/navigation's router. CaptureBox (the
// /anotar fallback page AND the ?sheet=anotar sheet body — SheetMounter
// mounts it at `/mis-mascotas/{token}`) used to call router.push/
// router.replace regardless of destination, so a routeOverride landing back
// on the SAME profile route (e.g. `?sheet=marcar-perdida`) regressed into
// the exact router-hot-path defect this module exists to avoid (engram #621,
// verify-report #617 CRITICAL-1).
//
// This helper is the ONE place capture-flow navigation resolves "same route
// or not" — CaptureBox is the sole consumer (mount-redirect + submit) today;
// a former embedded-capture component (EventCatcherSingle, dormant since the
// mid-face textarea was removed) also used to share it before it was deleted
// (owner-ia-redesign P1).

import { isSameRouteUrl, pushSheetUrl } from "@/lib/ui/sheet-nav";

export type CaptureRouter = {
  push: (href: string) => void;
  replace: (href: string) => void;
};

/**
 * Navigates to a capture-flow destination URL.
 *
 * - `href` targets the SAME route as `pathname` (only search params differ,
 *   e.g. `?sheet=marcar-perdida` reached from `/mis-mascotas/{token}`) →
 *   pushSheetUrl (shallow History API push, never touches the router).
 * - Otherwise (a different route, e.g. `/eventos/nuevo/vacuna`) → the
 *   caller's chosen router method (`push` by default; pass `"replace"` for a
 *   redirect that shouldn't add its own history entry, e.g. CaptureBox's
 *   mount-time intent resolution).
 */
export function goToCaptureUrl(
  pathname: string,
  href: string,
  router: CaptureRouter,
  method: "push" | "replace" = "push",
): void {
  if (isSameRouteUrl(pathname, href)) {
    pushSheetUrl(href);
    return;
  }
  router[method](href);
}
