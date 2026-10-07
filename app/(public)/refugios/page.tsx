// Public directory of verified organizations: shelters and rescue networks,
// plus the verified veterinary clinics that chose to appear (migration 0283,
// PO 2026-10-02). Filterable by type and province through the URL.
// No auth required. No PII exposed — only org display name, type, and
// jurisdiction (province / locality); contact details live on each profile.
//
// @no-auth-required: public directory — queryable by anonymous visitors.

import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";

import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { queryPublicDirectory } from "@/lib/infra/org-directory";
import { reportError } from "@/lib/infra/report-error";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { pluralizeEs } from "@/lib/utils/format";
import {
  DIRECTORY_ORG_TYPE_LABELS,
  type DirectoryFilters as Filters,
  applyDirectoryFilters,
  parseDirectoryFilters,
} from "@/src/modules/organizations/domain/public-directory";

import { DirectoryFilters } from "./DirectoryFilters";

// CI builds run without a database, so ISR prerender is not available.
// Use force-dynamic (matching every other public page in this repo) so
// Next.js never attempts a DB query at build time.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Directory query — Data-Cache'd (unstable_cache, revalidate 300s).
//
// WHY NOT response-level s-maxage/stale-while-revalidate: the (public) layout
// is auth-aware (D3 stranded-user fix) — a logged-in visitor's /refugios HTML
// carries THEIR nav, name chip, and unread count. Vercel's edge cache keys by
// URL (it does not vary on cookies), so caching the HTML would serve one
// viewer's chrome — PII — to every other visitor: the same privacy class the
// 2026-07-07 no-store fix closed. Caching the DATA instead gets the win that
// matters (the directory read drops to ≤1 per 5 min instead of every
// anonymous hit) while the chrome stays per-viewer and per-request.
//
// ONE cache entry for every filter combination: the whole directory is read
// once and filtered in memory, so `?tipo=` and `?provincia=` never multiply
// the reads (a few hundred rows of five short text columns).
//
// The cached body is bounded with withDbBudgetOrThrow — the panorama
// layer-cache incident discipline: Next's background stale-while-revalidate
// re-invocation would otherwise re-run the raw query with no budget and no
// rejection consumer, and by THROWING on budget the stale entry is kept
// rather than a degraded value being cached.
//
// Tag "org-directory": verification decisions, revocations and the org
// settings form (a clinic switching its listing on or off) invalidate it.
// ---------------------------------------------------------------------------

const DIRECTORY_BUDGET_MS = 4000;
const DIRECTORY_REVALIDATE_SECONDS = 300;

const loadDirectoryCached = unstable_cache(
  async () =>
    withDbBudgetOrThrow(queryPublicDirectory(), DIRECTORY_BUDGET_MS, "GET /refugios directory"),
  ["refugios-directory-v2"],
  { revalidate: DIRECTORY_REVALIDATE_SECONDS, tags: ["org-directory"] },
);

export const metadata: Metadata = {
  title: "Refugios y veterinarias — miMAR",
  description:
    "Refugios, redes de rescate y veterinarias verificados por miMAR. Encontrá los de tu provincia.",
  // Every filtered variant collapses onto the bare path (A03-G11, as /adoptar).
  alternates: { canonical: "/refugios" },
};

const PROVINCE_NAMES = PROVINCES.map((p) => p.name as string);

/** What the visitor is looking at, in words — for the count and the empty state. */
function subjectNoun(filters: Filters): { one: string; many: string } {
  if (filters.kind === "refugios") return { one: "refugio", many: "refugios" };
  if (filters.kind === "veterinarias") return { one: "veterinaria", many: "veterinarias" };
  return { one: "organización", many: "organizaciones" };
}

export default async function RefugiosIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseDirectoryFilters(await searchParams, PROVINCE_NAMES);
  const hasActiveFilters = filters.kind !== null || filters.province !== null;

  // Fail-soft: a DB failure or exhausted budget renders an HONEST unavailable
  // state (never a 500, never fake-empty presented as "no shelters exist").
  let allRows: Awaited<ReturnType<typeof loadDirectoryCached>>;
  try {
    allRows = await loadDirectoryCached();
  } catch (err) {
    reportError("public-refugios/directory", err);
    return (
      <div className="min-h-screen bg-[var(--color-ln-paper)]">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <LnEmptyState
            icon="edificio"
            title="No pudimos cargar el directorio. Reintentá en unos segundos."
          />
        </div>
      </div>
    );
  }

  const rows = applyDirectoryFilters(allRows, filters);
  const noun = subjectNoun(filters);

  // Group by province for display.
  const byProvince = new Map<string, typeof rows>();
  for (const row of rows) {
    const province = row.jurisdictionProvince ?? "Sin provincia";
    const existing = byProvince.get(province) ?? [];
    existing.push(row);
    byProvince.set(province, existing);
  }

  // Sort provinces using the canonical PROVINCES order.
  const provinceOrder = new Map(PROVINCE_NAMES.map((name, i) => [name, i]));
  const sortedProvinces = Array.from(byProvince.keys()).sort((a, b) => {
    const ia = provinceOrder.get(a) ?? 99;
    const ib = provinceOrder.get(b) ?? 99;
    return ia - ib;
  });

  return (
    <div className="min-h-screen bg-[var(--color-ln-paper)]">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        {/* Header */}
        <header className="space-y-2">
          <h1
            className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Refugios y veterinarias
          </h1>
          <p className="text-md text-[var(--color-ln-mute)] max-w-xl">
            Organizaciones verificadas por miMAR. Encontrá las de tu provincia: refugios y redes de
            rescate para adoptar o colaborar, y veterinarias que eligieron aparecer en el
            directorio.
          </p>
          <Link
            href="/adoptar"
            className="inline-block text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Ver animales en adopción →
          </Link>
        </header>

        <DirectoryFilters filters={filters} />

        {rows.length === 0 ? (
          hasActiveFilters ? (
            <LnEmptyState
              icon="edificio"
              title={`No hay ${noun.many} ${filters.province ? `en ${filters.province} ` : ""}en el directorio todavía.`}
              action={
                <a href="/refugios" className="text-sm text-[var(--color-ln-azul)] underline">
                  Limpiar filtros
                </a>
              }
            />
          ) : (
            <LnEmptyState
              icon="edificio"
              title="Todavía no hay organizaciones verificadas en el directorio."
            />
          )
        ) : (
          <div className="space-y-10">
            <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
              <strong className="text-[var(--color-ln-ink)] font-semibold">
                {rows.length} {pluralizeEs(rows.length, noun.one, noun.many)}
              </strong>
            </p>
            {sortedProvinces.map((province) => {
              const items = byProvince.get(province) ?? [];
              return (
                <section key={province} className="space-y-3">
                  <h2 className="text-sm font-bold uppercase tracking-[.1em] text-[var(--color-ln-mute)] border-b border-[var(--color-ln-line)] pb-1">
                    {province}
                  </h2>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {items.map((org) => (
                      <li key={org.publicToken}>
                        <Link
                          href={`/refugios/${org.publicToken}`}
                          className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-3 no-underline transition-colors hover:bg-[var(--color-ln-stripe)]"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-md font-semibold text-[var(--color-ln-ink)] truncate">
                              {org.displayName}
                            </p>
                            <p className="text-sm text-[var(--color-ln-mute)] mt-0.5">
                              {DIRECTORY_ORG_TYPE_LABELS[org.orgType] ?? org.orgType}
                              {org.jurisdictionLocality && ` · ${org.jurisdictionLocality}`}
                            </p>
                          </div>
                          <span
                            className="mt-0.5 flex-shrink-0 text-sm text-[var(--color-ln-azul)]"
                            aria-hidden="true"
                          >
                            →
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
