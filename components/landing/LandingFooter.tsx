// Landing footer — brand + 3 columns + legal line + closing GobStripe.

import { FOOTER_NAV } from "@/components/landing/landing-content";
import { GobStripe } from "@/components/layout/GobStripe";
import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="lp-foot" data-section="landing-footer">
      <div className="lp-wrap-wide">
        <div className="lp-foot-grid">
          <div>
            <div className="lp-brand mb-3">
              <span className="lp-brand-mark" aria-hidden="true">
                M
              </span>
              <span>
                <span className="lp-brand-name">miMAR</span>
                <span className="lp-brand-sub">Mi Mascota Argentina</span>
              </span>
            </div>
            {/* "Una iniciativa pública" read, in es-AR, as "run by the State"
                — the opposite of "pública" as in open. No state body operates
                or endorses miMAR, so the sentence is replaced by two claims
                the product can actually back: it is free, and its aggregate
                data is published under CC BY at /transparencia. */}
            <p className="max-w-xs text-md leading-relaxed text-[var(--color-ln-mute)]">
              El registro nacional de identidad y salud de las mascotas de la Argentina. Gratis y
              con datos abiertos.
            </p>
          </div>
          {FOOTER_NAV.map(([heading, items]) => (
            <div key={heading}>
              <h4>{heading}</h4>
              <ul>
                {items.map(([label, href]) => (
                  <li key={label}>
                    <Link href={href}>{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {/* This line used to open with "Ministerio de Salud · República
            Argentina" and the ministry's own domain, which stated an
            endorsement that does not exist. What replaces it is the inverse
            claim — stated plainly, because a visitor arriving at a page in
            gob.ar's visual language will otherwise assume it. Citing the laws
            miMAR complies with stays: a norm citation claims nothing about who
            backs the product. */}
        <div className="lp-foot-legal">
          <span>
            miMAR es un servicio independiente: no es un sitio oficial del Estado argentino.
          </span>
          <span className="lp-spacer" />
          <span>
            miMAR opera bajo la Ley 14.346 (protección animal) y la Ley 25.326 (protección de datos
            personales).
          </span>
        </div>
      </div>
      <GobStripe height={6} />
    </footer>
  );
}
