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
                <img src="/logo-mimar-mark.svg" alt="" width={26} height={26} />
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
                data is published under CC BY at /transparencia.
                WU1 honesty pass (2026-09-24): "registro nacional" also
                overclaimed (no convenio with any state body — see
                state-endorsement-fence.test.ts). Replaced with the libreta
                framing used across the rest of the honesty pass. */}
            <p className="max-w-xs text-md leading-relaxed text-[var(--color-ln-mute)]">
              La libreta sanitaria digital de las mascotas de Argentina, con historial que solo se
              agrega. Gratis y con datos abiertos.
            </p>
            {/* PO decision, orchestrator review 2026-09-24 (reverses D7): the
                celeste-and-white stripe, the "Estado" chapter and (once WU5
                ships) a "para municipios" page read together as an official
                signature — enough that Play's listing review could read it as
                implied government affiliation. This line forecloses that
                reading without claiming anything about who runs miMAR beyond
                "not the State".
                Corrected 2026-09-24 (fresh review): this used to duplicate
                the disclaimer that lived in .lp-foot-legal below, with a
                different noun ("proyecto" here, "servicio" there) — two
                sentences saying almost the same thing in two places. Merged
                into ONE line, kept here (near the brand, above the fold of
                the footer) because it is more visible than the small-print
                legal row; state-endorsement-fence.test.ts still pins this
                exact substring's presence in THIS file. */}
            <p className="mt-2 text-md leading-relaxed text-[var(--color-ln-mute)]">
              miMAR es un proyecto independiente: no es un sitio oficial del Estado argentino.
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
            endorsement that does not exist. The independence disclaimer that
            replaced it lived here too, duplicating the brand-block line
            above with a different noun ("servicio" vs "proyecto") — merged
            into that one line above (fresh review, 2026-09-24). What's left
            here is a norm citation, which claims nothing about who backs the
            product. */}
        <div className="lp-foot-legal">
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
