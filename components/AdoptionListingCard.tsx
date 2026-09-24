import Link from "next/link";

import { ageBucketLabel, energyLabel, sizeLabel } from "@/lib/infra/adoption-listing";
import { petPhotoUrl } from "@/lib/infra/storage";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { sterilizedLabel } from "@/lib/utils/format";
import type { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";

// Single source of truth for the adoption-listing pet card. Consumed by:
//   - /adoptar (public landing — full grid)
//   - /refugios/[orgToken] (scoped to one org)
//
// Both surfaces previously inlined nearly-identical markup. Extracted as
// part of handoff P2-1 to (a) avoid drift and (b) let future tweaks
// (price chip, dangerous-breed badge, etc.) ship in one place.
//
// `variant` controls density. The default tracks the existing /adoptar
// look; `compact` drops the secondary subtitle line so the card fits in
// the 12-pet refugio panel without towering over the layout.

const PROVINCE_BY_NAME = new Map<string, (typeof PROVINCES)[number]>(
  PROVINCES.map((p) => [p.name as string, p]),
);

export type AdoptionListingItem = Awaited<ReturnType<typeof queryAdoptionListing>>["items"][number];

export function AdoptionListingCard({
  item,
  variant = "default",
  showPublisher = true,
}: {
  item: AdoptionListingItem;
  variant?: "default" | "compact";
  /** When false, the "Publica: ..." footer is hidden. Used by the org
   * profile where the publisher is implied by the page itself. */
  showPublisher?: boolean;
}) {
  const photoUrl = petPhotoUrl(item.primaryPhotoStoragePath);
  const provinceLabel =
    (item.jurisdictionProvince && PROVINCE_BY_NAME.get(item.jurisdictionProvince)?.name) ||
    item.jurisdictionProvince ||
    null;

  const facts: string[] = [];
  if (item.adoptionAgeBucket) facts.push(ageBucketLabel(item.adoptionAgeBucket, item.sex));
  if (item.adoptionSizeEstimate) facts.push(sizeLabel(item.adoptionSizeEstimate));
  if (item.adoptionEnergyLevel) facts.push(energyLabel(item.adoptionEnergyLevel, item.sex));

  // Shared so all four surfaces agree, and so an unknown-sex pet reads
  // "Castrado/a" instead of being silently called male.
  const sterilizedText = sterilizedLabel(item.sex);
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const isNew = Date.now() - new Date(item.adoptionListedAt).getTime() < SEVEN_DAYS_MS;

  const petHref = `/adoptar/${item.petPublicToken}`;

  return (
    <li className="rounded-xl border border-ln-line overflow-hidden bg-ln-card hover:shadow-lg transition-shadow relative">
      {/* Single anchor covering the image + name area — no nested anchors.
          The org publisher link below is positioned above this via z-index. */}
      <Link
        href={petHref}
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-azul"
      >
        <div className="aspect-square bg-ln-stripe relative">
          {photoUrl ? (
            <img
              src={photoUrl}
              // Decorative inside the card link: the heading below already
              // names the pet, so a non-empty alt reads the name twice.
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-5xl text-ln-mute">
              {item.name.charAt(0).toUpperCase()}
            </div>
          )}
          {/* Top-left: sterilized / chip health chips */}
          {(item.isSterilized || item.hasMicrochip) && (
            <div className="absolute top-2 left-2 flex flex-wrap gap-1">
              {item.isSterilized && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-ln-ok text-white">
                  {sterilizedText}
                </span>
              )}
              {/* The chip fill is ln-azul, not ln-celeste: white on celeste is
                  3.15:1 and fails WCAG AA (4.5:1) at this 12px size, while the
                  sterilized chip beside it clears at 5.05:1 on ln-ok. Same row,
                  same size, same treatment — only the blue was failing. A solid
                  fill is required here (the chip sits over the photo), so the
                  remedy is a darker fill, not a translucent one: white on
                  ln-azul is 7.14:1. */}
              {item.hasMicrochip && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-ln-azul text-white">
                  Con chip
                </span>
              )}
            </div>
          )}
          {/* Top-right: "Nuevo" badge for recently listed pets (≤7 days) */}
          {isNew && (
            <span
              className="absolute top-2 right-2 text-xs font-semibold px-2 py-0.5 rounded-full border"
              style={{
                background: "var(--color-ln-ok-050)",
                color: "var(--color-ln-ok)",
                borderColor: "var(--color-ln-ok-100)",
              }}
            >
              Nuevo
            </span>
          )}
        </div>
        <div className="p-4 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-ln-ink">{item.name}</h2>
            {provinceLabel && (
              <span className="text-xs text-ln-mute">
                {item.jurisdictionLocality
                  ? `${item.jurisdictionLocality}, ${provinceLabel}`
                  : provinceLabel}
              </span>
            )}
          </div>
          {facts.length > 0 && <p className="text-xs text-ln-ink-2">{facts.join(" · ")}</p>}
          {/* rehome-by-titular (REQ-12): a sponsored listing is an animal that
              lives with its current family while the org runs the evaluation.
              Said on the card, because "Publica: {org}" alone reads as "it is
              at that refugio". Surrender-path listings carry no line. */}
          {item.livesWithFamily && (
            <p className="text-xs text-ln-ink-2">
              Vive con su familia; {item.orgDisplayName} acompaña la adopción.
            </p>
          )}
          {variant === "default" && item.adoptionStory && (
            <p className="text-xs text-ln-ink-2 line-clamp-3">{item.adoptionStory}</p>
          )}
          {/* Publisher slot: empty placeholder keeps card height consistent when
              showPublisher is false and prevents layout shift. */}
          {showPublisher && <div className="pt-1 border-t border-ln-stripe" />}
        </div>
      </Link>
      {/* Publisher link — rendered outside the card anchor so it is never
          nested inside another <a>. Positioned at the bottom of the card. */}
      {showPublisher && (
        <p className="text-sm text-ln-mute px-4 pb-4 -mt-2 relative z-10">
          Publica:{" "}
          <Link href={`/refugios/${item.orgPublicToken}`} className="underline hover:text-ln-ink">
            {item.orgDisplayName}
          </Link>
        </p>
      )}
    </li>
  );
}
