import Link from "next/link";

import { AdoptionListingCard } from "@/components/AdoptionListingCard";
import { LnCard, LnCardBody } from "@/components/ui/Card";
import { LnSectionHead } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import type { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";

// "Mascotas en adopción" panel (handoff P2-4) — Libreta Nacional look.
//
// Wraps the AdoptionListingCard grid inside an LnCard with LnSectionHead.
// Renders:
//   - section head with count + "Ver todas →" link when nextCursor present
//   - 1/2/3-column grid of AdoptionListingCard (showPublisher=false)
//   - EmptyState fallback when items.length === 0
//
// Variant=compact on the cards when items.length >= 12 (per handoff)
// keeps the card density readable inside the panel.

type ListingItems = Awaited<ReturnType<typeof queryAdoptionListing>>["items"];

interface Props {
  orgToken: string;
  displayName: string;
  items: ListingItems;
  hasMore: boolean;
}

export function AdoptionPanel({ orgToken, displayName, items, hasMore }: Props) {
  const cardVariant = items.length >= 12 ? "compact" : "default";

  return (
    <section aria-label="Mascotas en adopción">
      <LnSectionHead
        title="Mascotas en adopción"
        meta={items.length > 0 ? <span>{items.length}</span> : undefined}
        className="mb-4"
      />
      {hasMore && (
        <div className="mb-3 flex justify-end">
          <Link
            href={`/adoptar?org=${orgToken}`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] hover:underline focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
          >
            Ver todas →
          </Link>
        </div>
      )}
      <LnCard>
        <LnCardBody>
          {items.length === 0 ? (
            <LnEmptyState
              title={`${displayName} no tiene mascotas publicadas en adopción en este momento.`}
              description="Cuando publiquen una, va a aparecer acá."
              action={
                <Link
                  href="/adoptar"
                  className="inline-flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-2 text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
                >
                  Ver mascotas de otros refugios
                </Link>
              }
            />
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.slice(0, 12).map((item) => (
                <AdoptionListingCard
                  key={item.petId}
                  item={item}
                  variant={cardVariant}
                  showPublisher={false}
                />
              ))}
            </ul>
          )}
        </LnCardBody>
      </LnCard>
    </section>
  );
}
