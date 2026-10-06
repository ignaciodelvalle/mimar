// PublicLostSections — the lost-mode BODY of the public credential.
// Document facts only. Finder verbs live under the card in
// PublicCredentialActions (PO 2026-10-03: the paper is the animal).
//
// What strangers read on the card:
//   1) Who is searching (first name if disclosed)
//   2) Who is housing it (caretaker, two-key model)
//   3) Last-seen place as text (no map, no Google Maps)
//   4) Señas, tattoo, special conditions, lost description
//
// All props are server-resolved AFTER applying the disclosure prefs on
// `pets`. The component itself never decides what to show — the page
// passes only what's actually disclosable.

import { Icon } from "@/components/Icon";
import { lostTimeLabel } from "@/lib/infra/lost-listing";
import { tattooLocationLabel } from "@/lib/reference/lookups";
import { lastSeenHeadingLabel } from "@/lib/utils/format";
import Image from "next/image";

interface Props {
  petName: string;
  /** Pet sex ('male' | 'female' | 'unknown') — genders the lost-mode copy. */
  petSex: string | null;
  /** "Canino · marrón · collar rojo" — short identifying line. EMPTY STRING when
   *  the pet has no colour and no señas: the caller builds it (page.tsx) and
   *  deliberately returns "" rather than a lone species word. */
  identityLine: string;
  /** Owner first name, or null if hidden by prefs. */
  ownerFirstName: string | null;
  /**
   * Contact fields the page still threads so the PII spy can see the
   * publication-boundary nulls. This component does not render them — they
   * belong to PublicCredentialActions.
   */
  ownerPhoneE164?: string | null;
  ownerEmail?: string | null;
  finderFormHref?: string | null;
  sightingFormHref?: string | null;
  /**
   * Alternate contact: the pet's temporary caretaker (custodia-temporal).
   * NULL unless BOTH keys of the two-key model hold. Resolved server-side.
   */
  caretakerContact?: { firstName: string | null; phoneE164: string | null } | null;
  lastSeenPlaceName: string | null;
  lastSeenLocality: string | null;
  lastSeenCoords?: string | null;
  lastSeenAt?: Date | null;
  distinguishingFeatures: string | null;
  lostSince: Date;
  tattooCode?: string | null;
  tattooLocation?: string | null;
  tattooDescription?: string | null;
  tattooPhotoUrl?: string | null;
  lastSeenLat?: number | null;
  lastSeenLng?: number | null;
  lostDescription?: {
    accessoriesWhenLost: string | null;
    behaviorNotes: string | null;
    lastSeenContext: string | null;
  } | null;
  specialConditions?: { labels: string[]; other: string | null } | null;
  custodyDisputed?: boolean;
}

export function PublicLostSections({
  petName,
  petSex,
  identityLine,
  ownerFirstName,
  caretakerContact = null,
  lastSeenPlaceName,
  lastSeenLocality,
  lastSeenAt = null,
  lastSeenLat = null,
  lastSeenLng = null,
  distinguishingFeatures,
  tattooCode = null,
  tattooLocation = null,
  tattooDescription = null,
  tattooPhotoUrl = null,
  lostDescription = null,
  specialConditions = null,
}: Props) {
  const tattooLocLabel = tattooLocationLabel(tattooLocation);
  // Lat/lng arrive only when the owner disclosed the last location (page.tsx
  // gates them on `discloseLastLocationWhenLost`), so a pin here IS disclosed.
  const hasLastSeenCoords =
    lastSeenLat != null &&
    lastSeenLng != null &&
    Number.isFinite(lastSeenLat) &&
    Number.isFinite(lastSeenLng);
  // WHERE + HOW FRESH, in that order (UI review M3). Pin-only records (a map
  // tap, no address) say so in words — the same phrase the owner surface uses
  // — instead of leading with a bare recency or the raw coordinate pair, which
  // never reach this line.
  const lastSeenWhere =
    lastSeenPlaceName ??
    (!lastSeenLocality && hasLastSeenCoords ? "Punto marcado en el mapa" : null);
  const lastSeenLead =
    lastSeenWhere || lastSeenLocality
      ? [lastSeenWhere, lastSeenLocality, lastSeenAt ? formatLostSince(lastSeenAt) : null]
          .filter(Boolean)
          .join(" · ")
      : "";

  return (
    <div data-section="lost-sections">
      {/* Keep this hook: e2e crisis specs still look for the lost body here.
          The red urgent strip and its CTAs left the paper. */}
      <div data-section="lost-urgent-strip" className="px-4 pb-3">
        {identityLine && <p className="text-sm text-ln-ink-2">{identityLine}</p>}
        {ownerFirstName && (
          <p data-section="lost-owner-name" className="mt-0.5 text-sm font-medium text-ln-ink-2">
            Lo busca {ownerFirstName}.
          </p>
        )}
        {caretakerContact?.firstName && (
          <p
            data-section="lost-caretaker-contact"
            className="mt-0.5 text-sm font-medium text-ln-ink-2"
          >
            Mientras tanto la cuida {caretakerContact.firstName}.
          </p>
        )}
        {distinguishingFeatures && (
          <p className="mt-1 text-sm italic text-ln-ink-2">"{distinguishingFeatures}"</p>
        )}
      </div>

      {specialConditions && (specialConditions.labels.length > 0 || specialConditions.other) && (
        <section
          role="note"
          aria-label="Necesita cuidados especiales"
          data-section="special-conditions"
          className="border-t border-l-4 border-t-ln-line-2 border-l-ln-warn bg-[var(--color-ln-warn-050)] px-4 py-3"
        >
          <p className="flex items-center gap-2 text-sm font-bold text-ln-warn">
            <Icon name="alert-triangle" size="sm" decorative />
            Necesita cuidados especiales
          </p>
          {specialConditions.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {specialConditions.labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex rounded-full bg-ln-warn px-3 py-1 text-xs font-semibold text-white"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          {specialConditions.other && (
            <p className="mt-2 text-sm text-ln-ink-2">{specialConditions.other}</p>
          )}
        </section>
      )}

      {lastSeenLead && (
        <section className="border-t border-ln-line-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
            {lastSeenHeadingLabel(petSex)}
          </p>
          <p className="mt-1 text-sm font-medium text-ln-ink">{lastSeenLead}</p>
        </section>
      )}

      {tattooCode && (
        <section className="border-t border-ln-line-2 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">Tatuaje</p>
          <p className="mt-1 font-ln-mono text-sm font-medium text-ln-ink">
            {tattooCode}
            {tattooLocLabel && (
              <span className="ml-2 font-sans text-xs text-ln-mute">· {tattooLocLabel}</span>
            )}
          </p>
          {tattooDescription && (
            <p className="mt-1 text-xs italic text-ln-ink-2">{tattooDescription}</p>
          )}
          {tattooPhotoUrl && (
            <div className="relative mt-3 aspect-video w-full overflow-hidden rounded-xl">
              <Image
                src={tattooPhotoUrl}
                alt={`Tatuaje de ${petName}`}
                fill
                sizes="(max-width: 480px) 100vw, 480px"
                className="pointer-events-none object-cover"
              />
            </div>
          )}
          <p className="mt-2 text-xs text-ln-mute">
            Compará el código y la foto con el animal que tenés en frente antes de confirmar la
            coincidencia.
          </p>
        </section>
      )}

      {lostDescription &&
        (lostDescription.accessoriesWhenLost ||
          lostDescription.behaviorNotes ||
          lostDescription.lastSeenContext) && (
          <section className="border-t border-ln-line-2 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
              Detalles cuando se perdió
            </p>
            {lostDescription.accessoriesWhenLost && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
                  Accesorios
                </p>
                <p className="mt-0.5 text-sm text-ln-ink">{lostDescription.accessoriesWhenLost}</p>
              </div>
            )}
            {lostDescription.behaviorNotes && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
                  Comportamiento
                </p>
                <p className="mt-0.5 text-sm text-ln-ink">{lostDescription.behaviorNotes}</p>
              </div>
            )}
            {lostDescription.lastSeenContext && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ln-mute">
                  Contexto
                </p>
                <p className="mt-0.5 text-sm text-ln-ink">{lostDescription.lastSeenContext}</p>
              </div>
            )}
          </section>
        )}
    </div>
  );
}

export function formatLostSince(d: Date, now: number = Date.now()): string {
  return lostTimeLabel(d, new Date(now));
}
