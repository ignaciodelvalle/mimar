"use client";

// Sticky landing nav — sits ABOVE the GobStripe (intentional order, handoff
// README §Estructura 1). Bottom border fades in after 8px of scroll.

import Link from "next/link";
import { useEffect, useState } from "react";

const NAV_LINKS: Array<[string, string]> = [
  ["La historia", "#idea"],
  ["Qué hace", "#features"],
  ["Empezar", "#empezar"],
];

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`lp-nav${scrolled ? " scrolled" : ""}`} data-section="landing-nav">
      <div className="lp-nav-in">
        <a className="lp-brand" href="#top" aria-label="miMAR — inicio">
          <span className="lp-brand-mark" aria-hidden="true">
            M
          </span>
          <span>
            <span className="lp-brand-name">miMAR</span>
            <span className="lp-brand-sub">Mi Mascota Argentina</span>
          </span>
        </a>
        <nav className="lp-nav-links" aria-label="Secciones">
          {NAV_LINKS.map(([label, href]) => (
            <a key={href} className="lp-nav-link" href={href}>
              {label}
            </a>
          ))}
        </nav>
        <span className="lp-spacer" />
        {/* Acquisition-first: the primary nav CTA is "Crear mi miMAR" (/signup);
            "Iniciar sesión" (/login, an existing-user action) is demoted to a
            ghost. Copy audit 2026-07-21: this was the one file saying
            "Ingresar" while 7 others say "Iniciar sesión" for the same
            destination — reconciled to the dominant/canonical verb. */}
        <Link
          href="/iniciar-sesion"
          className="lp-btn lp-btn--ghost lp-btn--nav lp-btn--nav-secondary"
        >
          Iniciar sesión
        </Link>
        <Link href="/registro" className="lp-btn lp-btn--primary lp-btn--nav">
          Crear mi miMAR
        </Link>
      </div>
    </header>
  );
}
