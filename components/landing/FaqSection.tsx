// FAQ de objeciones (benchmark L7, NZ DIA pattern) + trust row (L4).
// Beta disclosure = subtle chip in the trust row (PO-locked decision #3 —
// NOT a full-width banner).

import { Icon } from "@/components/Icon";
import { FAQS } from "@/components/landing/landing-content";
import { LnBadge } from "@/components/ui/Badge";

export function FaqSection() {
  return (
    <section className="lp-section lp-section--paper" id="faq" data-section="faq">
      <div className="lp-wrap">
        <div className="lp-maxw-sec mx-auto text-center">
          <h2 className="lp-display lp-h-sec lp-reveal" data-d="1">
            Preguntas frecuentes
          </h2>
        </div>
        {/* Entrance sequencing (existing .lp-reveal + data-d mechanism):
            heading first, then the five objections stagger in 1..5. */}
        <div className="lp-faq mt-[clamp(30px,4vw,48px)]">
          {FAQS.map(([q, a], i) => (
            <details className="op-disclosure lp-reveal" data-d={i + 1} key={q}>
              <summary>{q}</summary>
              <p className="lp-faq-a">{a}</p>
            </details>
          ))}
        </div>
        <div className="lp-trust-row lp-reveal" data-section="trust-row">
          {/* "Gratis para siempre" and "Ley 25.326" already live in the
              hero/FAQ answer and the footer legal line respectively (PO
              copy-trim decision 2026-07-21) — kept out of this row so the
              same claims aren't repeated a third/second time. */}
          {/* Was "Operado por la autoridad sanitaria nacional" — no sanitary
              authority operates miMAR. The slot wants a trust claim the
              product can back: the event spine is append-only, which is the
              first invariant of the system. */}
          <span>
            <Icon name="candado" size="sm" decorative /> Historial inmutable
          </span>
          <span>
            <Icon name="chart-line" size="sm" decorative /> Datos abiertos
          </span>
          <span>
            <LnBadge variant="info">beta</LnBadge>
          </span>
        </div>
      </div>
    </section>
  );
}
