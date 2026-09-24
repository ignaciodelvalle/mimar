// Empezar — EXACTLY two doors (PO-locked): owner (primary CTA) + organization.
// Government/admin do NOT appear (invite-only, implicit). PO landing feedback:
// heading trimmed to just "Empezar"; the eyebrow + "antes del día que se
// pierda" lead were removed so the two doors carry the section.

import { Icon } from "@/components/Icon";
import { ROLES } from "@/components/landing/landing-content";
import Link from "next/link";

export function EmpezarSection() {
  return (
    <section className="lp-section lp-section--card" id="empezar" data-section="empezar">
      <div className="lp-wrap">
        <div className="lp-maxw-sec mx-auto text-center">
          <h2 className="lp-display lp-h-sec lp-reveal" data-d="1">
            Empezar
          </h2>
        </div>
        {/* Entrance sequencing (existing .lp-reveal + data-d mechanism):
            heading first, then the two doors stagger in — owner door leads. */}
        <div className="lp-role-grid mt-[clamp(36px,5vw,54px)]">
          {ROLES.map((r, i) => (
            <article
              className="lp-role-card lp-reveal"
              data-d={i + 1}
              data-tone={r.tone}
              key={r.tone}
            >
              <span className="lp-ric" aria-hidden="true">
                <Icon name={r.icon} size="lg" decorative />
              </span>
              <p className="lp-eyebrow mb-2">{r.eyebrow}</p>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
              <div className="flex flex-wrap gap-2">
                <Link href={r.ctaHref} className="lp-btn lp-btn--primary lp-btn--compact">
                  {r.cta} <span className="lp-ar">→</span>
                </Link>
                <Link href={r.cta2Href} className="lp-btn lp-btn--ghost lp-btn--compact">
                  {r.cta2}
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
