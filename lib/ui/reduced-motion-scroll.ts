// reduced-motion-scroll — the one guard every imperative `scrollIntoView`
// call needs and CSS cannot supply.
//
// `app/globals.css:522-530` collapses transition/animation durations under
// prefers-reduced-motion for free, but that global rule cannot reach an
// IMPERATIVE JS scroll (documented at `app/globals.css:533-538`). Field.tsx
// (`components/ui/Field.tsx:340-342`) established the fix for its one call
// site; this factors the same check out for the deep-link / reveal call
// sites that share it (ScrollToSignal, CredentialActionBar,
// PetDetailTabsPanel — CSS-4 / M3, 2026-08-05).

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Scrolls `el` into view, downgrading to an instant ("auto") scroll when the
 * user prefers reduced motion. No-op when `el` is null (the common "target
 * not found yet" case at every call site). `window.matchMedia` is guarded
 * rather than assumed — some test environments (jsdom) do not implement it —
 * so an environment without it simply gets the un-guarded "smooth" default.
 */
export function scrollIntoViewRespectingMotion(
  el: Element | null,
  options: Omit<ScrollIntoViewOptions, "behavior">,
): void {
  if (!el) return;
  const prefersReduced =
    typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
  el.scrollIntoView({ ...options, behavior: prefersReduced ? "auto" : "smooth" });
}
