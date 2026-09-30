// Empezar — 3 doors: owner (primary CTA) + organization + municipio/provincia
// (WU4, landing redesign 2026-09-24). The third door leads to /municipios, a
// PUBLIC information page — institutional accounts stay invite-only, this
// only lets a funcionario learn about the offering before being invited. PO
// landing feedback: heading trimmed to just "Empezar"; the eyebrow +
// "antes del día que se pierda" lead were removed so the doors carry the
// section.
//
// HIERARCHY (critique 2026-09-29, M8, PO-approved). The owner, who this page
// is for, had the lightest card while the municipios door was the heaviest
// (navy) and sat orphaned on a second row. Now the owner's door runs full
// width with the primary style and a full-size CTA; organizations and
// municipios share the second row as two equal, secondary cards. The
// organization's "Solicitar acceso" goes to its own request form, not to the
// owner's sign-up.

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
            heading first, then the doors stagger in — owner door leads. */}
        <div className="lp-role-grid mt-[clamp(36px,5vw,54px)]">
          {ROLES.map((r, i) => {
            const primary = r.tone === "dueno";
            const size = primary ? "" : " lp-btn--compact";
            return (
              <article
                className={`lp-role-card lp-reveal${primary ? " lp-role-card--primary" : ""}`}
                data-d={i + 1}
                data-tone={r.tone}
                key={r.tone}
              >
                <span className="lp-ric" aria-hidden="true">
                  <Icon name={r.icon} size="lg" decorative />
                </span>
                <p className="lp-eyebrow mb-2">{r.eyebrow}</p>
                <h3>{r.title}</h3>
                {r.body && <p>{r.body}</p>}
                {r.steps && (
                  <ol className="lp-role-steps" data-section="empezar-steps">
                    {r.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={r.ctaHref}
                    className={`lp-btn ${primary ? "lp-btn--primary" : "lp-btn--ghost"}${size}`}
                  >
                    {r.cta} <span className="lp-ar">→</span>
                  </Link>
                  <Link href={r.cta2Href} className={`lp-btn lp-btn--ghost${size}`}>
                    {r.cta2}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
