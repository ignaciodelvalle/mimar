// Landing chrome (lp-* layer), same as app/page.tsx and app/municipios. Imported
// here because this group is a landing-family surface: the pages the landing
// footer's "Institucional" column links to read as a continuation of the
// landing, not as a jump into the app shell. See app/landing.css.
import "@/app/landing.css";

import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";

// Outside the (public) group nothing here reads the request, so Next would
// prerender these pages — and a prerendered page cannot carry the per-request
// CSP nonce, so the nav's scroll state would arrive dead
// (scripts/check-csp-prerender.ts). Same declaration as app/municipios.
export const dynamic = "force-dynamic";

/**
 * Layout for the institutional reading pages (/acerca, /transparencia,
 * /funcionalidades, /leyes, /privacidad, /terminos, /cookies, /accesibilidad,
 * /ayuda) — PO decision 2026-10-01: pages linked from the landing footer keep
 * the landing chrome (LandingNav + LandingFooter). Product pages (/perdidas,
 * /adoptar, /refugios, /denuncias, /p/*, ...) stay in (public) with the app
 * masthead.
 *
 * Mirrors app/municipios: same wrapper, same nav, same footer, same
 * `<main id="main-content">` the root layout's skip-link targets. The pages
 * themselves render no `<main>` (AppShell used to provide it), so it lives
 * here. Never an auth gate: it renders for anonymous and signed-in visitors
 * alike, and the nav links are root-relative so they work off `/`.
 */
export default function InstitucionalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="lp flex min-h-screen flex-col" data-landing-root>
      <DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />
      <LandingNav />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <LandingFooter />
    </div>
  );
}
