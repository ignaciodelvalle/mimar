"use client";

// DegradedFallback — timed escalation for stalled Suspense/loading boundaries
// (degraded-states 2026-08-06, design D1/D2).
//
// Wraps a surface's existing skeleton as children and prepends two blocks that
// reveal on a pure-CSS schedule (`.degraded-reveal` in app/globals.css, delays
// inline from lib/ui/degraded-states.ts):
//   - waiting text at DEGRADED_TEXT_MS ("Esto está tardando más de lo normal.")
//   - degraded card at DEGRADED_CARD_MS (LnEmptyState + Reintentar +
//     "Seguir esperando")
//
// WHY CSS animation-delay AND NOT JS TIMERS (load-bearing): the failure mode
// this mitigates is a hydration stall mid-shell — precisely the state where a
// useEffect timer never fires. This component is "use client" but SSR'd like
// any client component: the full escalation ships in the fallback HTML and
// needs zero JS to reveal. When Suspense resolves, the whole fallback tree
// unmounts — no timers, no cleanup, no state updates after unmount.
//
// "Reintentar" is a plain `<a href="">`: a full-document GET on the current
// URL. Hydration-independent, and outside the router fence on purpose —
// router.refresh() has an EMPTY allowlist (scripts/check-router-refresh.ts).
//
// "Seguir esperando" is progressive enhancement (hydration-gated behind a
// mounted flag): it bumps a React key on the card wrapper, restarting the
// CSS reveal cycle. It never navigates — the in-flight fetch keeps streaming.
//
// The card reuses LnEmptyState (sk-*/st-* skin-aware tokens — renders on both
// skins). `nature` is deliberately OMITTED: this is a load failure, not an
// epistemic gap, and LnEmptyState's own contract forbids pairing `action`
// with a no-signal nature.
//
// Reduced motion: the global rule in app/globals.css zeroes animation-duration
// but NOT animation-delay — the reveal still waits its full 8s/20s and pops
// instead of fading. Guard comments live at both ends; the coupling is pinned
// by DegradedFallback.test.tsx.

import { LnButton } from "@/components/ui/Button";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { DEGRADED_CARD_MS, DEGRADED_COPY, DEGRADED_TEXT_MS } from "@/lib/ui/degraded-states";
import { type ReactNode, useEffect, useState } from "react";

// Primary-styled like LnButton primary (institutional azul, filled, pill) —
// but a real <a>, not LnButton's anchor mode: that mode renders next/link,
// which is a SOFT client navigation and needs hydration; this one must not.
const RETRY_ANCHOR_CLASS =
  "inline-flex items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] px-4 py-2 text-sm font-semibold text-white no-underline transition-colors hover:bg-[var(--color-ln-azul-700)]";

function RetryAnchor() {
  return (
    // biome-ignore lint/a11y/useValidAnchor: empty href IS the contract — a full-document GET of the CURRENT URL, resolvable with zero JS. The exact URL cannot be known here (SSR'd Suspense fallback, any route), router.refresh() is fenced (empty allowlist), and window.location needs the very hydration whose stall this covers (design D2, reconciliation #1979).
    <a href="" className={RETRY_ANCHOR_CLASS}>
      {DEGRADED_COPY.retry}
    </a>
  );
}

export function DegradedFallback({ children }: { children: ReactNode }) {
  // Gate for the JS-only "Seguir esperando" affordance. False during SSR and
  // until hydration completes — exactly the situations where a key bump could
  // never work anyway, so the link simply doesn't render there.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Bumping the key remounts the card wrapper, which restarts its CSS
  // animation-delay from zero — another full DEGRADED_CARD_MS of quiet waiting.
  const [cycle, setCycle] = useState(0);

  return (
    <div>
      {/* Degraded card — in flow ABOVE the retained skeleton (design D2). */}
      <div
        key={`degraded-cycle-${cycle}`}
        data-degraded-cycle={cycle}
        className="degraded-reveal mb-4"
        style={{ animationDelay: `${DEGRADED_CARD_MS}ms` }}
      >
        <LnEmptyState
          icon="reloj"
          variant="dashed"
          title={DEGRADED_COPY.cardTitle}
          description={DEGRADED_COPY.cardDescription}
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <RetryAnchor />
              {mounted && (
                <LnButton variant="ghost" size="sm" onClick={() => setCycle((c) => c + 1)}>
                  {DEGRADED_COPY.keepWaiting}
                </LnButton>
              )}
            </div>
          }
        />
      </div>

      {/* Waiting text — the skeleton below stays visible alongside it. */}
      <p
        className="degraded-reveal mb-3 text-center text-sm text-[var(--color-sk-mute)]"
        style={{ animationDelay: `${DEGRADED_TEXT_MS}ms` }}
      >
        {DEGRADED_COPY.slowText}
      </p>

      {children}
    </div>
  );
}
