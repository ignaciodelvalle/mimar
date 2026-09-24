import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

import { StaticFirstMap } from "@/components/maps/StaticFirstMap";
import { LnCard, LnCardBody } from "@/components/ui/Card";
import { LnSectionHead } from "@/components/ui/DocElements";
import type { OrgPublicProfile } from "@/lib/infra/org-public-profile";

// "Dónde estamos" panel (handoff P2-6) — Libreta Nacional look.
//
// Three render branches:
//   1. lat/lng set AND disclose_address=true (gated by queryOrgPublicProfile,
//      which nulls lat/lng when disclose_address is false) → mapa
//      embebido + "Cómo llegar" link
//   2. only jurisdiction (province + locality, no point) → solo texto
//      "Operan en {Localidad}, {Provincia}"
//   3. disclose_address=false → panel doesn't render
//
// map-QOL P3: the previous OSM iframe embed (which loaded openstreetmap.org
// third-party content — and its cookies — as soon as it scrolled into view)
// is replaced by the STATIC-FIRST embed (components/maps/StaticFirstMap): a
// static placeholder by default, and the interactive map + tiles load only
// after the visitor explicitly activates it. No third-party request happens
// until then.

interface Props {
  org: OrgPublicProfile;
  /** Pre-computed jurisdiction label "Localidad, Provincia" or null. */
  localityLabel: string | null;
}

export function LocationPanel({ org, localityLabel }: Props) {
  const hasPoint = org.latitude != null && org.longitude != null;

  if (!hasPoint && !localityLabel) return null;

  return (
    <section aria-label="Dónde estamos">
      <LnSectionHead title="Dónde estamos" className="mb-4" />
      <LnCard>
        <LnCardBody>
          {hasPoint && org.latitude != null && org.longitude != null ? (
            <>
              <StaticFirstMap
                lat={org.latitude}
                lng={org.longitude}
                label={org.displayName}
                precision="exact"
                heightClassName="h-56 md:h-64"
              />
              {localityLabel && (
                <p className="mt-3 text-sm font-medium text-[var(--color-ln-ink)]">
                  {localityLabel}
                </p>
              )}
              <SheetTriggerLink
                href={`/refugios/${org.publicToken}?sheet=como-llegar`}
                className="inline-flex items-center gap-1 mt-2 text-sm text-[var(--color-ln-azul)] hover:underline focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] rounded"
              >
                Cómo llegar →
              </SheetTriggerLink>
            </>
          ) : (
            localityLabel && (
              <p className="text-sm text-[var(--color-ln-ink)]">
                Operan en <span className="font-medium">{localityLabel}</span>.
              </p>
            )
          )}
        </LnCardBody>
      </LnCard>
    </section>
  );
}
