import { STALE_BAND_SLOT_ID } from "@/lib/ui/degraded-states";
import type { ReactNode } from "react";

import { AppFooter } from "./AppFooter";
import { GobStripe } from "./GobStripe";
import { ScrollReset } from "./ScrollReset";

/**
 * AppShell — the single, role-variant application chrome (Item 7, spec §3).
 *
 * One shell, three variants, replacing the three legacy chrome systems
 * (`LnOwnerNav` / `AppHeader` / `OpShell`):
 *
 *   - `citizen`  → top horizontal masthead. Owner + public + public-logged-in.
 *                  Carries the thin Argentina institutional stripe (D7) and a
 *                  minimal footer (D9).
 *   - `operator` → left navy control-room rail + topbar. gob / admin / org.
 *                  No stripe, no footer (D7/D9). Absorbs OpShell/OpRail/OpTopbar.
 *   - `landing`  → minimal trust chrome for token-landing surfaces (D13):
 *                  brand + stripe + "Credencial registrada en miMAR", and NO
 *                  browse nav / footer. Protects the scan→action moment.
 *
 * STRANGLER — COMPLETE (Item 7, PRs #630-#634, docs/superpowers/README.md).
 * This component defined the structural contract for all three variants and
 * shipped in 4 phases: build the shell (A), migrate operators (B), migrate
 * citizen/public (C), delete the old chromes (D). All four phases have
 * landed — `LnOwnerNav` / `AppHeader` / `OpShell` no longer exist in this
 * codebase; AppShell is the only chrome, wired on every surface (app/(app),
 * /gob, /admin, /org, /(public), /p, /r/invite, /libreta/compartir).
 * AppShell is intentionally presentational: the
 * auth-aware decision of WHICH variant + nav to render lives in
 * `lib/shell-nav.ts` (`resolveShellNav`), which the caller invokes first.
 *
 * Server component. Any client interactivity (active-state nav, mobile drawer,
 * context switcher) lives in the slotted children, not here.
 */

type CommonProps = {
  children: ReactNode;
};

type CitizenProps = CommonProps & {
  variant: "citizen";
  /** The masthead element (brand + role/public nav + switcher + user). */
  masthead: ReactNode;
  /** Optional footer override; defaults to the minimal AppFooter (D9). */
  footer?: ReactNode;
  /** Optional max-width for the main content wrapper. */
  maxWidth?: string;
  /**
   * Optional fixed bottom tab bar (CitizenTabBar) — mobile primary nav for
   * the logged-in citizen (native-mobile audit §1). When present, the shell
   * reserves matching bottom padding below md so content and footer are never
   * hidden behind the fixed bar. Anonymous/public surfaces pass nothing.
   */
  tabBar?: ReactNode;
  /**
   * Optional full-width banner rendered above the rest of the chrome (e.g.
   * the offline banner). Mirrors the operator variant's `banner` slot — see
   * its JSDoc below for the placement rationale.
   */
  banner?: ReactNode;
};

type OperatorProps = CommonProps & {
  variant: "operator";
  /** The left rail element (brand + sectioned nav + user). */
  rail: ReactNode;
  /** The sticky topbar element (crumbs + scope + switcher + user). */
  topbar: ReactNode;
  /**
   * Optional full-width banner rendered INSIDE the 100vh shell, above the
   * rail+main row (e.g. the demo-mode banner). Keeping it inside the shell —
   * rather than as a sibling above it — means the document stays exactly 100vh
   * (no external scroll, no clipped rail footer). PR-1 V1.
   */
  banner?: ReactNode;
  /** Optional max-width for the scroll-area inner wrapper. */
  maxWidth?: string;
};

type LandingProps = CommonProps & {
  variant: "landing";
  /**
   * Optional discreet "back to my app" return for a logged-in viewer (D13).
   * Anonymous viewers pass nothing.
   */
  returnSlot?: ReactNode;
  /**
   * Optional full-width banner rendered above the trust header (e.g. the
   * demo-mode banner). This is the surface a stranger scans a QR into — the
   * single most important place NOT to skip the demo disclosure (PO interview
   * 2026-07-23, item 1: "todas las superficies", public included).
   */
  banner?: ReactNode;
};

type AppShellProps = CitizenProps | OperatorProps | LandingProps;

export function AppShell(props: AppShellProps) {
  switch (props.variant) {
    case "operator":
      return <OperatorShell {...props} />;
    case "landing":
      return <LandingShell {...props} />;
    case "citizen":
      return <CitizenShell {...props} />;
  }
}

// ---------------------------------------------------------------------------
// citizen — top masthead + institutional stripe + minimal footer
// ---------------------------------------------------------------------------

function CitizenShell({ masthead, footer, maxWidth, tabBar, banner, children }: CitizenProps) {
  return (
    // min-h-dvh (not 100vh): tracks the dynamic mobile viewport so the fixed
    // tab bar never floats above a stale browser-chrome offset. When the tab
    // bar is present, reserve its height below md: 3rem of tab content plus
    // the same max(0.75rem, safe-area-inset-bottom) the bar itself pads with.
    <div
      className={[
        "flex min-h-dvh flex-col bg-[var(--color-ln-paper)] text-[var(--color-ln-ink)]",
        tabBar ? "pb-[calc(3rem+max(0.75rem,env(safe-area-inset-bottom)))] md:pb-0" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Thin Argentina institutional stripe (D7). */}
      <GobStripe />
      {banner}
      {/* Top-of-shell slot the stale band portals into — see
          STALE_BAND_SLOT_ID. Empty (and zero-height) until data goes stale. */}
      <div id={STALE_BAND_SLOT_ID} />
      {masthead}
      {/* pb-safe: keep the last content row clear of the iOS home indicator
          now that viewport-fit=cover lets the PWA draw under it. */}
      <main id="main-content" data-scroll-reset className="pb-safe flex-1 overflow-auto">
        <ScrollReset />
        {maxWidth ? <div className={`${maxWidth} mx-auto`}>{children}</div> : children}
      </main>
      {footer ?? <AppFooter />}
      {tabBar}
    </div>
  );
}

// ---------------------------------------------------------------------------
// operator — navy control-room rail + topbar, no stripe / no footer
// ---------------------------------------------------------------------------

function OperatorShell({ rail, topbar, banner, maxWidth, children }: OperatorProps) {
  return (
    // Viewport-locked column: `fixed inset-0` pins the operator chrome to the
    // viewport and takes it OUT of document flow, so the document itself can
    // never scroll (the inner area scrolls instead). Scoped to the operator
    // shell — citizen/landing surfaces keep normal body-level scrolling.
    // Optional banner on top; the rail+main row fills the rest (min-h-0 so the
    // inner scroll area — not the document — scrolls).
    //
    // PRINT HOOKS (`op-shell-root` / `op-shell-row` / `op-shell-main` /
    // `op-shell-scroll`): the four nested boxes below are ALL clipping
    // containers, and together they cut any printed operator document to one
    // viewport (PRN-3, reproduced by the PO on the maltrato expediente). A print
    // surface cannot escape them with `position: absolute` — the root here is
    // `position: fixed`, i.e. a positioned ancestor. The named hooks let a
    // surface's print sheet neutralise the whole chain instead of tunnelling out
    // of it; see components/layout/operator-print-escape.css, which is the ONLY
    // consumer. `op-surface` stays what it always was: the operator SKIN
    // selector (globals.css), also worn by non-shell cards — never target it for
    // layout.
    <div className="op-shell-root op-surface fixed inset-0 flex flex-col overflow-hidden bg-ln-op-page text-ln-op-ink text-md leading-[1.45] [&_*]:box-border">
      {/* Skip-link (a11y) — visually hidden until keyboard-focused, jumps past
          the rail + topbar straight to the main content landmark below. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[var(--z-toast)] focus:rounded-[var(--radius-md)] focus:bg-ln-op-azul focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white"
      >
        Saltar al contenido
      </a>
      {banner}
      {/* Top-of-shell slot the stale band portals into — see
          STALE_BAND_SLOT_ID. Outside `op-shell-row` on purpose: as a sibling of
          the rail+main row it spans the full width and pushes the row down
          instead of scrolling away with the content. */}
      <div id={STALE_BAND_SLOT_ID} />
      <div className="op-shell-row flex min-h-0 flex-1 overflow-hidden">
        {rail}
        <main
          id="main-content"
          tabIndex={-1}
          className="op-shell-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none"
        >
          {topbar}
          <div
            data-scroll-reset
            className="op-shell-scroll min-h-0 flex-1 overflow-auto px-6 py-[22px]"
          >
            <ScrollReset />
            {maxWidth ? <div className={`${maxWidth} mx-auto`}>{children}</div> : children}
          </div>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// landing — minimal trust chrome for token-landing surfaces (D13)
// ---------------------------------------------------------------------------

function LandingShell({ returnSlot, banner, children }: LandingProps) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-ln-paper)] text-[var(--color-ln-ink)]">
      <GobStripe />
      {banner}
      {/* pt-safe: QR-scan landings open full-screen in the installed PWA too —
          keep the trust header clear of the notch/status bar. */}
      <header className="pt-safe flex items-center gap-3 border-b border-ln-line bg-white px-4 py-3 md:px-6">
        {/* font-ln-serif: the wordmark is IBM Plex Serif everywhere else in the
            product — the citizen masthead, the credential card, the landing —
            and this header sits ~50px above the card's own "miMAR" on /p, so
            the two rendered the SAME word in two families a glance apart
            (QA 2026-08-07). Without a family declared it fell through to
            Tailwind's `font-sans`, which this app maps to Encode Sans: the
            SITE CHROME face, not the brand's. PO decision 2026-08-08: the
            credential's serif is the one that wins. */}
        <span className="font-ln-serif text-lg font-bold text-ln-azul">miMAR</span>
        {/* "registrada", not "verificada" — the token resolving in the registry
            is the only claim this chrome can honestly make for EVERY /p page,
            regardless of the credential's verification provenance. */}
        <span className="hidden text-xs text-ln-mute sm:inline">
          Credencial registrada en miMAR
        </span>
        {/* Discreet "back to my app" — present only for logged-in viewers (D13). */}
        {returnSlot && <div className="ml-auto">{returnSlot}</div>}
      </header>
      <main id="main-content" data-scroll-reset className="pb-safe flex-1 overflow-auto">
        <ScrollReset />
        {children}
      </main>
    </div>
  );
}
