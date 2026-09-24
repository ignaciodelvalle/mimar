// Crisis fork (benchmark L1) — the anonymous visitor in crisis is the
// highest-value visitor. Three doors, no account, no code to remember:
// Perdí · Encontré · Vi maltrato.
//
// THE CODE LOOKUP USED TO LIVE HERE and was removed on 2026-08-19 (PO
// decision, after the blind QA run). It accepted a pet token or a DEN-
// tracking code — PO-locked decision #2, the 15-digit ISO chip deliberately
// excluded — and it occupied the widest column of the band (1.15fr against
// two 1fr cards) on the highest-traffic page in the product. Both of its jobs
// already had a better-labelled door: /denuncias/buscar explains the DEN case
// in a sentence ("volvé a tu denuncia con el código que recibiste"), and the
// "Encontré una mascota" card is the finder's path. The band was offering the
// FOLLOW-UP to a denuncia while the entry to making one sat in the footer.
// That is what the third card fixes.
//
// The card copy does NOT promise intervention. A denuncia is registered and
// issued a tracking code; it is not dispatched to an organism yet (the Ley
// 14.346 integration is still in development, disclosed in the wizard's final
// step and on /denuncias/seguimiento). A landing card that said "avisá a la
// autoridad" would be the one place in the flow that lied about it.
//
// No longer a client component: with the lookup gone there is no state and no
// router here.

import { Icon } from "@/components/Icon";
import Link from "next/link";

export function CrisisBand() {
  return (
    <section
      className="lp-crisis"
      id="crisis"
      aria-label="Emergencias — sin cuenta"
      data-section="crisis-band"
    >
      <div className="lp-wrap-wide lp-crisis-grid">
        {/* Owner job ("activá el modo perdido") lands on the owner's pets, not
            the finder board — /mis-mascotas preserves the destination through
            the auth flow (cursor citizen UX P2, verified 2026-07-24). */}
        <Link className="lp-crisis-card" data-t="perdi" href="/mis-mascotas">
          <span className="lp-cic" aria-hidden="true">
            <Icon name="perdida" size="md" decorative />
          </span>
          <span>
            <b>Perdí una mascota</b>
            <span className="lp-crisis-sub">Activá el modo perdido y alertá a los vecinos.</span>
          </span>
          <span className="lp-ar" aria-hidden="true">
            →
          </span>
        </Link>
        <Link className="lp-crisis-card" data-t="encontre" href="/perdidas">
          <span className="lp-cic" aria-hidden="true">
            <Icon name="qr" size="md" decorative />
          </span>
          <span>
            <b>Encontré una mascota</b>
            <span className="lp-crisis-sub">Escaneá su QR o buscala por señas. Sin cuenta.</span>
          </span>
          <span className="lp-ar" aria-hidden="true">
            →
          </span>
        </Link>
        <Link className="lp-crisis-card" data-t="maltrato" href="/denuncias/nueva">
          <span className="lp-cic" aria-hidden="true">
            <Icon name="denuncia" size="md" decorative />
          </span>
          <span>
            <b>Vi un caso de maltrato</b>
            <span className="lp-crisis-sub">
              Denunciá sin cuenta. Te damos un código para seguirla.
            </span>
          </span>
          <span className="lp-ar" aria-hidden="true">
            →
          </span>
        </Link>
      </div>
    </section>
  );
}
