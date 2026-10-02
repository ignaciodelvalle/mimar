// Landing footer — brand + 4 short columns + a small bottom legal row + closing
// GobStripe (PO 2026-10-02). Rendered on `/`, /municipios and every page of
// the (institucional) group.

import { FOOTER_LEGAL, FOOTER_NAV } from "@/components/landing/landing-content";
import { GobStripe } from "@/components/layout/GobStripe";
import Link from "next/link";

export function LandingFooter() {
  return (
    <footer className="lp-foot" data-section="landing-footer">
      <div className="lp-wrap-wide">
        <div className="lp-foot-grid">
          <div className="lp-foot-brand">
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
                framing used across the rest of the honesty pass.
                Copy review 2026-09-30 (D1/D2/D3): the footer repeated the
                append-only mechanic, the anonymous-stats promise and the
                free-forever promise, all already stated in the hero and the
                FAQ — cut to the one sentence a footer needs. */}
            <p className="max-w-xs text-md leading-relaxed text-[var(--color-ln-mute)]">
              La libreta sanitaria digital de tu mascota.
            </p>
            {/* PO decision, orchestrator review 2026-09-24 (reverses D7): the
                celeste-and-white stripe, the "Estado" chapter and the "para
                municipios" page read together as an official signature —
                enough that Play's listing review could read it as implied
                government affiliation. This line forecloses that reading
                without claiming anything about who runs miMAR beyond "not the
                State". It is the footer's ONE disclaimer, kept near the brand
                because that is more visible than the small-print row;
                state-endorsement-fence.test.ts pins this exact substring's
                presence in THIS file. */}
            <p className="mt-2 text-md leading-relaxed text-[var(--color-ln-mute)]">
              miMAR es un proyecto independiente: no es un sitio oficial del Estado argentino.
            </p>
          </div>
          {FOOTER_NAV.map(([heading, items]) => (
            <div key={heading}>
              {/* The column headings are small caps, except the brand's own: uppercase
                  would print "MIMAR", and the brand is always "miMAR". */}
              <h4 className={heading === "miMAR" ? "lp-foot-h-brand" : undefined}>{heading}</h4>
              <ul>
                {items.map(([label, href]) => (
                  <li key={href}>
                    <Link href={href}>{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {/* The small legal row (PO 2026-10-02). The sentence that used to sit
            here — "Las denuncias de maltrato se encuadran en la Ley 14.346. Tus
            datos se tratan según la Ley 25.326." — was removed: /privacidad,
            /terminos, /leyes and the denuncia flow already say it where it
            applies, and the footer has its one disclaimer above. */}
        <div className="lp-foot-legal">
          <ul>
            {FOOTER_LEGAL.map(([label, href]) => (
              <li key={href}>
                <Link href={href}>{label}</Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <GobStripe height={6} />
    </footer>
  );
}
