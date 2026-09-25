import type { Metadata } from "next";

// Landing chrome (lp-* layer), same as app/page.tsx. Imported here too on
// purpose: this is a second, legitimate landing-family surface, not an
// arbitrary route reaching for landing styles (see app/landing.css's own
// "promote to globals.css rather than importing this file somewhere else"
// note — that guard is about accidental cost creep).
import "@/app/landing.css";

import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";
import { resolvePlayStoreUrl } from "@/lib/ui/play-store";

import { PilotRequestForm } from "./PilotRequestForm";
import { CAPABILITIES, QUESTIONS, faqs, pilotSteps } from "./content";

export const metadata: Metadata = {
  title: "miMAR para municipios y provincias",
  description:
    "Para oficinas de Zoonosis y bienestar animal: padrón sanitario, cobertura por localidad, campañas, mordeduras, denuncias y mascotas perdidas de tu jurisdicción, en un solo tablero.",
  // Relative on purpose: resolved against the root layout's metadataBase
  // (NEXT_PUBLIC_SITE_URL), never a hardcoded origin. The image is the
  // sibling opengraph-image.tsx.
  alternates: { canonical: "/municipios" },
  openGraph: {
    title: "miMAR para municipios y provincias",
    description:
      "Padrón sanitario, cobertura por localidad, campañas y vigilancia de tu jurisdicción, en un solo tablero.",
    type: "website",
    url: "/municipios",
    siteName: "miMAR",
    locale: "es_AR",
  },
  twitter: { card: "summary_large_image" },
};

// Outside the (public) group nothing here reads the request, so Next would
// prerender it — and a prerendered page cannot carry the per-request CSP
// nonce, so its scripts (the nav's scroll state, the contact form) would
// arrive dead (scripts/check-csp-prerender.ts). It also keeps the Play
// listing check below a per-request read of the env.
export const dynamic = "force-dynamic";

/**
 * /municipios — the page for Zoonosis and animal-welfare offices (WU5,
 * landing redesign 2026-09-24; reworked after the PO review of 2026-09-25:
 * "queremos ofrecerle soluciones, no generar dudas").
 *
 * All copy lives in ./content.ts, next to the code path that backs each line.
 * NOT ON THIS PAGE, ON PURPOSE (PO): how citizens are identified (each
 * municipio negotiates it; /privacidad covers the current handling), a price,
 * a pilot length, a response time, and anything only partly built.
 */
export default function MunicipiosPage() {
  const playStoreUrl = resolvePlayStoreUrl(process.env);
  const steps = pilotSteps(playStoreUrl);
  const faq = faqs(playStoreUrl);

  return (
    <div className="lp flex min-h-screen flex-col" data-landing-root>
      <LandingNav />
      <main id="main-content" className="flex-1">
        <section className="lp-mun-hero" aria-labelledby="mun-title">
          <div className="lp-wrap">
            <p className="lp-mun-kicker">Para oficinas de Zoonosis y bienestar animal</p>
            <h1 id="mun-title" className="lp-display lp-mun-title">
              La sanidad animal de tu territorio, en un solo tablero.
            </h1>
            <p className="lp-mun-hero-lead">
              Vacunas, castraciones, mordeduras, denuncias y mascotas perdidas: lo que cargan
              vecinos, veterinarias y refugios llega sumado a tu oficina, localidad por localidad.
            </p>
            <div className="lp-mun-hero-cta">
              <a href="#contacto" className="lp-btn lp-btn--primary">
                Contactate con el equipo
              </a>
              <a href="#que-resuelve" className="lp-btn lp-mun-btn--line">
                Ver qué resuelve
              </a>
            </div>
          </div>
        </section>

        <section
          className="lp-section lp-section--paper lp-mun-section"
          id="preguntas"
          aria-labelledby="mun-q-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-q-title" className="lp-display lp-h-sec lp-mun-h">
              Las cuatro preguntas de tu oficina
            </h2>
            <ul className="lp-mun-questions">
              {QUESTIONS.map(({ q, screen, a }) => (
                <li key={q} className="lp-mun-question">
                  <p className="lp-mun-q">{q}</p>
                  <div>
                    <p className="lp-mun-screen">{screen}</p>
                    <p className="lp-mun-a">{a}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          className="lp-section lp-section--card lp-mun-section"
          id="que-resuelve"
          aria-labelledby="mun-cap-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-cap-title" className="lp-display lp-h-sec lp-mun-h">
              Lo que resuelve para tu oficina
            </h2>
            <p className="lp-lead lp-mun-sublead">
              Cada dato entra donde ocurre —en la casa, en la veterinaria, en el refugio— y llega a
              tu tablero sin pedir planillas a nadie.
            </p>
            <ul className="lp-mun-caps">
              {CAPABILITIES.map(({ title, body }) => (
                <li key={title}>
                  <h3 className="lp-mun-cap-h">{title}</h3>
                  <p className="lp-mun-cap-b">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          className="lp-section lp-section--paper lp-mun-section"
          aria-labelledby="mun-pilot-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-pilot-title" className="lp-display lp-h-sec lp-mun-h">
              Cómo es un piloto
            </h2>
            {/* A real sequence, so it is numbered. */}
            <ol className="lp-mun-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lp-mun-request" id="contacto" aria-labelledby="mun-form-title">
          <div className="lp-wrap lp-mun-request-grid">
            <div>
              <h2 id="mun-form-title" className="lp-display lp-h-sec">
                Contactate con el equipo
              </h2>
              <p className="lp-mun-request-lead">
                Te respondemos a la brevedad para coordinar una demo de cinco minutos sobre tu
                territorio.
              </p>
            </div>
            <div className="lp-mun-form-card">
              <PilotRequestForm />
            </div>
          </div>
        </section>

        <section
          className="lp-section lp-section--paper lp-mun-section"
          aria-labelledby="mun-faq-title"
        >
          <div className="lp-wrap lp-mun-narrow">
            <h2 id="mun-faq-title" className="lp-display lp-h-sub">
              Preguntas frecuentes
            </h2>
            <div className="lp-faq mt-6">
              {faq.map(({ q, a }) => (
                <details className="op-disclosure" key={q}>
                  <summary>{q}</summary>
                  <p className="lp-faq-a">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
