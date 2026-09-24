import Link from "next/link";

import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

import { Icon } from "@/components/Icon";
import { LnCard, LnCardBody } from "@/components/ui/Card";
import { LnSectionHead } from "@/components/ui/DocElements";
import type { OrgPublicProfile } from "@/lib/infra/org-public-profile";

// "Cómo ayudar" panel (handoff P2-7) — Libreta Nacional look.
//
// Quad-grid of CTAs (2 cols mobile, 4 cols desktop). Cards that don't
// apply (e.g. no donation_methods → no "Doná") are omitted silently —
// the handoff is explicit that we don't greyed-out empty options.

interface Props {
  org: OrgPublicProfile;
  /** Whether the visitor has a session — drives the foster CTA target
   * (authed users get the sheet; anon get redirected to login with
   * returnTo preserved). */
  isAuthed: boolean;
}

type HelpCard = {
  key: string;
  icon: string;
  label: string;
  href: string;
  /** Same-route `?sheet=` target — must open via the History API, not a soft
   *  navigation (see lib/ui/sheet-nav.ts). "Doná" and "Sumate como voluntario"
   *  were plain <Link>s and neither did anything on click. */
  opensSheet?: boolean;
};

export function HelpPanel({ org, isAuthed }: Props) {
  // Foster CTA goes straight to the existing FosterVolunteerWizard at
  // /cuenta/ofrecerme-como-transito (a per-user surface). The handoff
  // mentioned a sheet variant pre-filled with ?org=… but the wizard
  // doesn't bind to a specific org today — foster preferences are
  // global and orgs match against them. Routing to the wizard keeps
  // the UX correct; anon users get bounced through /login first.
  const fosterHref = isAuthed
    ? "/cuenta/ofrecerme-como-transito"
    : `/iniciar-sesion?intent=foster&returnTo=${encodeURIComponent("/cuenta/ofrecerme-como-transito")}`;

  const cards: HelpCard[] = [
    {
      key: "adoptar",
      icon: "corazon",
      label: "Adoptá con nosotros",
      href: "#adopcion-title",
    },
    {
      key: "transito",
      icon: "casa",
      label: "Ofrecete como tránsito",
      href: fosterHref,
    },
  ];

  // Donar — only when at least one method is set. Falls through to
  // website if donation_methods is null but a website exists; otherwise
  // the card is omitted entirely (no greyed-out card per handoff).
  if (org.donationMethods && Object.values(org.donationMethods).some((v) => v)) {
    cards.push({
      key: "donar",
      icon: "regalo",
      label: "Doná",
      href: `/refugios/${org.publicToken}?sheet=donar`,
    });
  } else if (org.website) {
    cards.push({
      key: "donar",
      icon: "regalo",
      label: "Doná",
      href: org.website.startsWith("http") ? org.website : `https://${org.website}`,
    });
  }

  cards.push({
    key: "voluntario",
    icon: "usuarios",
    label: "Sumate como voluntario",
    href: `/refugios/${org.publicToken}?sheet=ser-voluntario`,
    opensSheet: true,
  });

  return (
    <section aria-label="Cómo ayudar">
      <LnSectionHead title="Cómo ayudar" className="mb-4" />
      <LnCard>
        <LnCardBody>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {cards.map((card) => {
              const Trigger = card.opensSheet ? SheetTriggerLink : Link;
              return (
                <Trigger
                  key={card.key}
                  href={card.href}
                  className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-6 text-center hover:bg-[var(--color-ln-stripe)] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] transition-colors"
                >
                  <span aria-hidden className="text-[var(--color-ln-azul)]">
                    <Icon name={card.icon} size={28} decorative />
                  </span>
                  <span className="text-sm font-medium text-[var(--color-ln-ink)]">
                    {card.label}
                  </span>
                </Trigger>
              );
            })}
          </div>
        </LnCardBody>
      </LnCard>
    </section>
  );
}
