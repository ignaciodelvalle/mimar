import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

import { Icon } from "@/components/Icon";
import { LnBadge } from "@/components/ui/Badge";
import { LnGuilloche } from "@/components/ui/DocElements";
import type { OrgPublicProfile } from "@/lib/infra/org-public-profile";
import { orgLogoUrl } from "@/lib/infra/storage";
import { BRANDING } from "@/lib/ui/branding";

// Hero del refugio público — Libreta Nacional institutional band look.
//
// Layout:
//   - guilloché accent bar (4px top, full-width)
//   - azul gradient band (96px, repeating diagonal cross-hatch)
//   - logo overlap: 88×88 rounded-[14px] avatar rising from the band
//   - info row: serif org name + verified chip + org-type chip + year chip
//   - meta line: locality, legal name (secondary)
//   - action buttons: primary "Contactar" + ghost "Compartir"
//   - stats row: card grid below (adoptions count, services count)
//     — rendered only when items > 0 (passed from page)
//
// OrgHero receives `adoptionCount` and `serviceCount` from the parent
// page so the stats row can be populated without an extra query here.

interface Props {
  org: OrgPublicProfile;
  /** Pre-rendered locality + province display string from the page so
   * we don't re-resolve the province name here. */
  localityLabel: string | null;
  /** Number of pets currently in the adoption listing (from page query). */
  adoptionCount: number;
  /** Number of public service offerings (from page query). */
  serviceCount: number;
}

const TRUST_COPY = `Refugio verificado por ${BRANDING.appName}. Las postulaciones llegan directo al equipo del refugio, que coordina los próximos pasos por email con cada candidato.`;

export function OrgHero({ org, localityLabel, adoptionCount, serviceCount }: Props) {
  const logoUrl = orgLogoUrl(org.logoStoragePath);
  const initial = org.displayName.charAt(0).toUpperCase();

  // "Desde {año}" chip — only when verified more than a year ago.
  const showYearChip =
    org.verifiedAt && Date.now() - org.verifiedAt.getTime() > 365 * 24 * 60 * 60 * 1000;
  const verifiedYear = org.verifiedAt?.getFullYear();

  const orgTypeChipLabel = org.orgType === "shelter" ? "Refugio" : "Red de rescate";

  const showStats = adoptionCount > 0 || serviceCount > 0;

  return (
    <header className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
      {/* Guilloché top accent */}
      <LnGuilloche />

      {/* Institutional band — diagonal cross-hatch over azul gradient */}
      <div
        aria-hidden="true"
        className="h-[96px]"
        style={{
          background:
            "repeating-linear-gradient(135deg,rgba(255,255,255,.4) 0 1px,transparent 1px 10px)," +
            "linear-gradient(120deg,var(--color-ln-azul-900),var(--color-ln-azul) 60%,var(--color-ln-celeste))",
        }}
      />

      {/* Main content — logo overlaps the band by margin-top: -36px */}
      <div className="flex flex-col gap-4 px-6 pb-5 md:flex-row md:items-flex-end md:gap-5">
        {/* Logo — overlaps the band */}
        <div className="-mt-9 shrink-0">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={`Logo de ${org.displayName}`}
              className="h-[88px] w-[88px] rounded-[14px] border-[3px] border-[var(--color-ln-card)] object-cover bg-[var(--color-ln-card)]"
            />
          ) : (
            <div
              role="img"
              aria-label={`Logo de ${org.displayName}`}
              className="h-[88px] w-[88px] rounded-[14px] border-[3px] border-[var(--color-ln-card)] bg-[var(--color-ln-azul)] text-white text-5xl font-semibold flex items-center justify-center font-ln-serif"
            >
              {initial}
            </div>
          )}
        </div>

        {/* Info + actions */}
        <div className="flex-1 space-y-3 pt-2 md:pt-3">
          {/* Name + chips */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)] leading-tight">
                {org.displayName}
              </h1>
              {/* Verified chip (inline with name) */}
              <SheetTriggerLink href={`/refugios/${org.publicToken}?sheet=verificacion-info`}>
                <LnBadge variant="success" icon="shield-check">
                  Verificado
                </LnBadge>
              </SheetTriggerLink>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LnBadge variant="neutral">{orgTypeChipLabel}</LnBadge>
              {showYearChip && verifiedYear && (
                <LnBadge variant="neutral" icon="calendario">
                  Desde {verifiedYear}
                </LnBadge>
              )}
            </div>
            {(localityLabel || (org.legalName && org.legalName !== org.displayName)) && (
              <p className="text-md text-[var(--color-ln-mute)]">
                {[
                  localityLabel,
                  org.legalName && org.legalName !== org.displayName ? org.legalName : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>

          {/* Trust copy */}
          <p className="text-sm text-[var(--color-ln-ink-2)] max-w-prose leading-relaxed">
            {TRUST_COPY}
          </p>

          {/* CTA buttons */}
          <div className="flex flex-col sm:flex-row gap-2">
            <SheetTriggerLink
              href={`/refugios/${org.publicToken}?sheet=contactar`}
              className="inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] text-white text-sm font-semibold px-4 py-2.5 hover:bg-[var(--color-ln-azul-700)] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] transition-colors"
            >
              <Icon name="mail" size="sm" decorative />
              Contactar al refugio
            </SheetTriggerLink>
            <SheetTriggerLink
              href={`/refugios/${org.publicToken}?sheet=compartir-org`}
              className="inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] text-sm font-medium px-4 py-2.5 hover:bg-[var(--color-ln-stripe)] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] transition-colors"
            >
              <Icon name="externo" size="sm" decorative />
              Compartir
            </SheetTriggerLink>
          </div>
        </div>
      </div>

      {/* Stats row — only when there's something to show */}
      {showStats && (
        <div className="grid grid-cols-2 border-t border-[var(--color-ln-line)] sm:grid-cols-4">
          <div className="border-r border-[var(--color-ln-line-2)] px-[18px] py-[15px]">
            <div className="font-ln-serif text-3xl font-semibold leading-none text-[var(--color-ln-azul)]">
              {adoptionCount}
            </div>
            <div className="mt-[5px] text-sm text-[var(--color-ln-mute)]">En adopción ahora</div>
          </div>
          {serviceCount > 0 && (
            <div className="border-r border-[var(--color-ln-line-2)] px-[18px] py-[15px] sm:border-r-0 md:border-r">
              <div className="font-ln-serif text-3xl font-semibold leading-none text-[var(--color-ln-azul)]">
                {serviceCount}
              </div>
              <div className="mt-[5px] text-sm text-[var(--color-ln-mute)]">Servicios</div>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
