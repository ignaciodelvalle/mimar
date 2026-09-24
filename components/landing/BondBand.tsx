// Bond band — the emotional pivot between the utility of the crisis fork and
// the "how it works" story. Everything else on this page (the credential, the
// QR, the four hands, the immutable libreta) is machinery in service of ONE
// thing: the bond between a person and their animal. This full-bleed
// photograph IS that thesis, stated once, without words competing with it.
//
// Placement rationale: it sits AFTER CrisisBand (so the high-value anonymous
// visitor still reaches "Perdí / Encontré" immediately) and BEFORE StorySection
// ("Una mascota. Muchas manos."), opening the emotional narrative — the why
// before the how. It is the single bold, full-bleed moment on an otherwise
// disciplined, contained page.
//
// Image: local static import → next/image auto-optimizes (responsive srcset +
// blur placeholder). Below the fold, so it lazy-loads (NO priority) to protect
// hero LCP. The copy carries `.lp-reveal`; RevealManager fades it in and
// already honors prefers-reduced-motion (the photo itself never hides).

import portada from "@/public/landing/portada.jpg";
import Image from "next/image";

export function BondBand() {
  return (
    <section
      className="lp-bond"
      id="vinculo"
      aria-label="El vínculo que miMAR protege"
      data-section="bond-band"
    >
      <div className="lp-bond-media">
        <Image
          src={portada}
          alt="Una mujer sonríe con los ojos cerrados y junta su nariz con la de su gato siamés, que sostiene entre las manos bajo la luz cálida del sol."
          fill
          sizes="100vw"
          quality={72}
          placeholder="blur"
          className="lp-bond-img"
        />
        <span className="lp-bond-scrim" aria-hidden="true" />
      </div>
      <div className="lp-wrap-wide lp-bond-inner">
        {/* Deliberate entrance sequencing (same .lp-reveal + data-d mechanism as
            the rest of the page): eyebrow first, then the thesis line, then the
            closing sub — instead of the whole block fading as one. */}
        <div className="lp-bond-copy">
          <p className="lp-eyebrow lp-bond-eyebrow lp-reveal">El porqué</p>
          <p className="lp-display lp-bond-title lp-reveal" data-d="1">
            Un vínculo para toda la vida.
          </p>
          <p className="lp-bond-sub lp-reveal" data-d="2">
            Todo lo que miMAR protege empieza acá.
          </p>
        </div>
      </div>
    </section>
  );
}
