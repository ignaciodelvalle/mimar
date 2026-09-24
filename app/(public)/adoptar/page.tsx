import Link from "next/link";

import { AdoptionListingCard } from "@/components/AdoptionListingCard";
import { buildSearchParams, parseSearchParams } from "@/lib/infra/adoption-listing";
import { resolveCanonicalTitleLocation } from "@/lib/infra/public-listing-metadata";
import { pluralizeEs } from "@/lib/utils/format";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";

import { AdoptionFiltersBar } from "./AdoptionFiltersBar";

// Public landing — no auth required. Each search param maps to a query
// filter; the URL is the source of truth (D11). Server-rendered for
// SEO and shareability.
//
// Cache policy: ALWAYS LIVE. force-dynamic + `Cache-Control: no-store` (stamped
// in middleware for the /adoptar subtree — see lib/infra/public-cache-policy.ts)
// so an adopted/unpublished pet drops off the public listing promptly.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { filters } = parseSearchParams(params);
  const bits: string[] = [];
  if (filters.species === "dog") bits.push("perros");
  else if (filters.species === "cat") bits.push("gatos");
  else bits.push("mascotas");
  // A03-G11 (mirrored from /perdidas): only a province/locality that
  // resolves against the real catalog earns a place in the title.
  const resolved = await resolveCanonicalTitleLocation({
    rawProvince: filters.province,
    rawLocality: filters.locality,
  });
  if (resolved.locality) bits.push(`en ${resolved.locality}`);
  else if (resolved.province) bits.push(`en ${resolved.province}`);
  const title = `${bits.join(" ")} en adopción — miMAR`;
  return {
    title,
    description:
      "Encontrá a tu próxima mascota en miMAR. Refugios verificados publican animales listos para ser adoptados.",
    // Every filtered variant collapses onto the bare path (A03-G11).
    alternates: { canonical: "/adoptar" },
  };
}

export default async function AdoptarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { filters, cursor } = parseSearchParams(params);
  const { items, nextCursor } = await queryAdoptionListing(filters, cursor, 24);

  const hasActiveFilters = Object.values(filters).some((v) => v !== undefined);

  return (
    <main className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">
        {/* Hero heading */}
        <header className="space-y-2 max-w-[720px]">
          <h1 className="m-0 font-ln-serif text-5xl font-semibold leading-[1.05] tracking-[-0.025em] text-[var(--color-ln-ink)]">
            Adoptar en miMAR
          </h1>
          <p className="text-base leading-[1.55] text-[var(--color-ln-ink-2)]">
            Mascotas publicadas por refugios verificados en Argentina. Si ves alguna que te resuene,
            postulate y el refugio te contacta.
          </p>
        </header>

        <AdoptionFiltersBar filters={filters} />

        {items.length === 0 ? (
          // UX 3.5 item 3: distinguish true-empty (no filters) from filter-empty.
          // "no hay resultados con esos filtros" is misleading when there are no
          // active filters — in that case the section simply has no listings yet.
          <div className="rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-6 py-10 text-center space-y-2">
            {hasActiveFilters ? (
              <>
                <p className="text-sm font-medium text-[var(--color-ln-ink)]">
                  No hay mascotas con esos filtros.
                </p>
                <Link href="/adoptar" className="text-sm text-[var(--color-ln-azul)] underline">
                  Limpiar filtros
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-[var(--color-ln-ink)]">
                  Todavía no hay animales en adopción.
                </p>
                <p className="text-xs text-[var(--color-ln-mute)]">
                  Volvé en unos días — los refugios suben mascotas seguido.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
              <strong className="text-[var(--color-ln-ink)] font-semibold">
                {items.length} {pluralizeEs(items.length, "mascota")}
              </strong>
              {/* The adjective agrees with the noun — "1 mascota publicadas"
                  shipped live (9-role external run, 2026-08-18). */}
              {` ${pluralizeEs(items.length, "publicada")}`}
              {nextCursor ? " · mostrando las más recientes" : ""}
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[18px]">
              {items.map((item) => (
                <AdoptionListingCard key={item.petId} item={item} />
              ))}
            </ul>

            {nextCursor && (
              <div className="flex justify-center pt-4">
                <Link
                  href={`/adoptar?${buildSearchParams(filters, nextCursor).toString()}`}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-5 py-2.5 text-sm font-semibold text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
                >
                  Mostrar más
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
