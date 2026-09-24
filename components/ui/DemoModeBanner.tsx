// DemoModeBanner — INESCAPABLE honest disclosure for non-production
// environments (PO interview 2026-07-23, item 1).
//
// Activation: NEXT_PUBLIC_DEMO_MODE=true.
// Default: off — never appears in production (see dim-interno:docs/ops/env-handling.md).
// Mounted on EVERY shell — public, citizen, and operator — via each AppShell
// variant's `banner` slot (already reserves layout space; see
// components/layout/AppShell.tsx). Branding is untouched — this is a chrome
// overlay, not a rebrand.
//
// Deliberately NOT dismissible: no close button, no local-storage "seen"
// flag, no state at all. "Inescapable" is the point (item 1) — a funcionario
// working with synthetic data must never be able to make the disclosure go
// away and forget it's there.
//
// Tone mirrors the existing "Datos de demostración" disclosure in
// components/panorama/PanoramaShell.tsx:79 — same design-token palette. The
// ln-op-warn-* tokens are global @theme values (app/globals.css), not scoped
// to `.op-surface` — the amber warn tone renders correctly on the citizen
// (Ln) skin too, not just inside the operator shell.

"use client";

import { usePathname } from "next/navigation";

import { demoBannerAppliesTo } from "@/lib/domain/demo-mode";

// shouldShowDemoBanner is defined in the server-safe lib/demo-mode module so the
// server admin layout can import it too. Re-exported here for backward compat
// with existing consumers/tests that import it from this component.
export { shouldShowDemoBanner } from "@/lib/domain/demo-mode";

interface DemoModeBannerProps {
  /** Pass process.env.NEXT_PUBLIC_DEMO_MODE === "true" from the layout. */
  enabled: boolean;
}

export function DemoModeBanner({ enabled }: DemoModeBannerProps) {
  // TWO GATES, AND THEY ANSWER DIFFERENT QUESTIONS. `enabled` is the
  // environment — is this deployment serving synthetic data at all — and it is
  // decided by the layout that mounts this. `demoBannerAppliesTo` is the page:
  // does the sentence have anything to be about here. The reasoning for the
  // second, and the list of pages that are deliberately NOT exempt, lives with
  // the function in lib/domain/demo-mode.ts.
  //
  // The path is read HERE rather than threaded through six layouts on purpose:
  // this component is already a client component, every mount would otherwise
  // have to repeat the decision, and a rule repeated six times is a rule that
  // will disagree with itself. `usePathname` resolves during SSR too, so the
  // server renders the same thing the client does and no banner flashes in and
  // back out.
  const pathname = usePathname();
  if (!enabled || !demoBannerAppliesTo(pathname)) return null;

  return (
    // <output> carries the implicit ARIA role "status" (a polite live
    // region) — the explicit aria-live="polite" below is redundant belt-
    // and-suspenders for assistive tech that doesn't resolve <output>'s
    // implicit role, not a correction of it.
    <output
      aria-live="polite"
      className="block w-full border-b border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-1.5 text-center text-sm font-semibold uppercase tracking-[0.04em] text-ln-op-ink-2"
    >
      Entorno de demostración — datos sintéticos
    </output>
  );
}
