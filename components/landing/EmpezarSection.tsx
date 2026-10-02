// Empezar — 3 doors: owner + organization + municipio/provincia (WU4, landing
// redesign 2026-09-24). The third door leads to /municipios, a PUBLIC
// information page — institutional accounts stay invite-only, this only lets a
// funcionario learn about the offering before being invited.
//
// LAYOUT (PO 2026-10-02): ONE row of three equal cards (stacked on a phone),
// each with a title, one line and one button. The owner keeps the only primary
// button; the organization's "Solicitar acceso" goes to its own request form,
// not to the owner's sign-up. No "Ya tengo cuenta" links (the nav's "Iniciar
// sesión" is the way back in) and no numbered steps.

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
                <h3>{r.title}</h3>
                <p>{r.body}</p>
                <Link
                  href={r.ctaHref}
                  className={`lp-btn lp-btn--compact ${primary ? "lp-btn--primary" : "lp-btn--ghost"}`}
                >
                  {r.cta} <span className="lp-ar">→</span>
                </Link>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
