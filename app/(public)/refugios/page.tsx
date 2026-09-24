// Public index of verified shelters and rescue networks.
// No auth required. No PII exposed — only org display name, type, and
// jurisdiction (province / locality).
//
// @no-auth-required: public directory — queryable by anonymous visitors.

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";

import { db, organizations } from "@/db";
import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { reportError } from "@/lib/infra/report-error";
import { PROVINCES } from "@/lib/reference/ar-provincias";

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
// The cached body is bounded with withDbBudgetOrThrow — the panorama
// layer-cache incident discipline: Next's background stale-while-revalidate
// re-invocation would otherwise re-run the raw query with no budget and no
// rejection consumer, and by THROWING on budget the stale entry is kept
// rather than a degraded value being cached.
// ---------------------------------------------------------------------------

const DIRECTORY_BUDGET_MS = 4000;
const DIRECTORY_REVALIDATE_SECONDS = 300;

const loadVerifiedOrgsCached = unstable_cache(
  async () =>
    withDbBudgetOrThrow(
      (async () =>
        db
          .select({
            publicToken: organizations.publicToken,
            displayName: organizations.displayName,
            orgType: organizations.orgType,
            jurisdictionProvince: organizations.jurisdictionProvince,
            jurisdictionLocality: organizations.jurisdictionLocality,
          })
          .from(organizations)
          .where(
            and(
              inArray(organizations.orgType, ["shelter", "rescue_network"]),
              eq(organizations.verified, true),
            ),
          )
          .orderBy(asc(organizations.jurisdictionProvince), asc(organizations.displayName))
          .limit(500))(),
      DIRECTORY_BUDGET_MS,
      "GET /refugios directory",
    ),
  ["refugios-directory"],
  { revalidate: DIRECTORY_REVALIDATE_SECONDS, tags: ["org-directory"] },
);

export const metadata: Metadata = {
  title: "Refugios y redes de rescate — miMAR",
  description:
    "Refugios y redes de rescate verificados en el Registro Nacional de Mascotas. Encontrá una organización en tu provincia.",
};

const ORG_TYPE_LABELS: Record<string, string> = {
  shelter: "Refugio",
  rescue_network: "Red de rescate",
};

export default async function RefugiosIndexPage() {
  // Fail-soft: a DB failure or exhausted budget renders an HONEST unavailable
  // state (never a 500, never fake-empty presented as "no shelters exist").
  let rows: Awaited<ReturnType<typeof loadVerifiedOrgsCached>>;
  try {
    rows = await loadVerifiedOrgsCached();
  } catch (err) {
    reportError("public-refugios/directory", err);
    return (
      <div className="min-h-screen bg-[var(--color-ln-paper)]">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <LnEmptyState
            icon="edificio"
            title="No pudimos cargar el listado de refugios. Reintentá en unos segundos."
          />
        </div>
      </div>
    );
  }

  // Group by province for display.
  const byProvince = new Map<string, typeof rows>();
  for (const row of rows) {
    const province = row.jurisdictionProvince ?? "Sin provincia";
    const existing = byProvince.get(province) ?? [];
    existing.push(row);
    byProvince.set(province, existing);
  }

  // Sort provinces using the canonical PROVINCES order.
  const provinceOrder = new Map(PROVINCES.map((p, i) => [p.name as string, i]));
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
            Refugios y redes de rescate
          </h1>
          <p className="text-md text-[var(--color-ln-mute)] max-w-xl">
            Organizaciones verificadas en el Registro Nacional de Mascotas. Si buscás un animal para
            adoptar o querés colaborar, encontrá una cerca tuyo.
          </p>
          <Link
            href="/adoptar"
            className="inline-block text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Ver animales en adopción →
          </Link>
        </header>

        {rows.length === 0 ? (
          <LnEmptyState icon="edificio" title="No hay refugios verificados registrados todavía." />
        ) : (
          <div className="space-y-10">
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
                              {ORG_TYPE_LABELS[org.orgType] ?? org.orgType}
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
