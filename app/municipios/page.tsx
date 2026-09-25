import type { Metadata } from "next";

// Landing chrome (lp-* layer), same as app/page.tsx. Imported here too on
// purpose: this is a second, legitimate landing-family surface, not an
// arbitrary route reaching for landing styles (see app/landing.css's own
// "promote to globals.css rather than importing this file somewhere else"
// note — that guard is about accidental cost creep, not about the future
// full /municipios build this placeholder stands in for).
import "@/app/landing.css";

import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";

export const metadata: Metadata = {
  title: "miMAR para municipios y provincias",
  description:
    "miMAR para organismos de Zoonosis y bienestar animal — información institucional, próximamente.",
  robots: { index: false, follow: false },
};

// Outside the (public) group nothing here reads the request, so Next would
// prerender it — and a prerendered page cannot carry the per-request CSP
// nonce, so its scripts (the nav's scroll state) would arrive dead
// (scripts/check-csp-prerender.ts).
export const dynamic = "force-dynamic";

/**
 * Minimal placeholder (WU4, landing redesign 2026-09-24).
 *
 * The home page's nav link, the Empezar door and the footer's Institucional
 * column all point at /municipios, and __tests__/link-integrity.test.ts
 * requires a real page.tsx behind every static href it scans — so this page
 * exists to keep that fence honest, not because WU5 (the real page: hero,
 * screenshots, the pilot-request form) has landed. noindex until it does, so
 * nothing half-built gets crawled or mistaken for the real offering.
 */
export default function MunicipiosPage() {
  return (
    <div className="lp flex min-h-screen flex-col" data-landing-root>
      <LandingNav />
      <main id="main-content" className="flex-1">
        <div className="mx-auto max-w-2xl px-6 py-24 text-center">
          <h1
            className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            miMAR para municipios y provincias
          </h1>
          <p className="mt-4 text-md text-[var(--color-ln-ink-2)]">Próximamente.</p>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
