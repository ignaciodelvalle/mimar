import { deepLinkUrl } from "@dim/contract/links";
import { and, eq, inArray } from "drizzle-orm";
import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";

import { db, organizations } from "@/db";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { queryAdoptionListing } from "@/src/modules/adoption/infrastructure/adoption-listing-read";
import { queryLostListing } from "@/src/modules/lost/infrastructure/lost-listing-read";

// Sitemap hits the DB to enumerate adoptable pets + lost pets + verified
// refugios — keep it out of the build-time prerender path so CI doesn't
// need DATABASE_URL. The ROUTE runs per request; the DATA it reads does not
// (see "THE CACHE WINDOW" below).
//
// WHY THERE IS NO `export const revalidate` HERE. Under `force-dynamic` Next
// treats the route as revalidate 0 whatever else the file exports, so a
// `revalidate = 3600` next to it would read as a cache window and be none. The
// window is real only on the data: `unstable_cache` below, the same shape
// app/(public)/refugios/page.tsx uses for the same reason (force-dynamic
// because CI has no database, Data Cache because the reads are shared).
export const dynamic = "force-dynamic";

// NEXT_PUBLIC_SITE_URL is the single source of truth for the app's public
// origin (see dim-interno:docs/ops/production-deploy-plan.md "Site URL consistency").
// A wrong or missing value here is worse than a build failure: it ships a
// sitemap that silently advertises the wrong domain to search engines. Fail
// loud in production instead of falling back to a hardcoded guess; keep a
// harmless localhost fallback for local dev/CI where the route isn't hit.
function resolveSiteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is not set. Refusing to generate a sitemap with a guessed domain in production.",
    );
  }
  return "http://localhost:3000";
}

// The ceiling on each of the three feeds, and it has to be passed to each of
// them in the form that function actually honours — which is not the same form
// for all three.
//
// THE COMMENT THAT USED TO BE HERE WAS FALSE, and the falseness is why nobody
// saw the cost. It said both listing queries were "already bounded by the same
// guards used everywhere else". True for `queryAdoptionListing`, which turns the
// page size into `.limit(pageSize + 1)`. False for `queryLostListing`: its
// superset cap is `Math.max(500, pageSize * 5)`, built for /perdidas, which
// filters that superset in JS by time bucket and criticality before it keeps
// 24. The sitemap filters nothing, so the ×5 bought it nothing — and turned
// 5,000 into a 25,000-row ordered scan with a correlated subquery per row, on
// every anonymous GET /sitemap.xml (audit A03-G3/G8). The lost feed now gets the
// cap as its FOURTH argument, so its scan is 5,000 rows like the adoption
// feed's. The organizations select had no bound at all and now takes the same
// one; there are a few dozen verified shelters, so it is a ceiling, not a cut.
const SITEMAP_PAGE_SIZE = 5000;

// THE CACHE WINDOW. The three reads are the same for every caller, so they are
// read at most once per window instead of once per request — which is also why
// this route takes no per-IP bucket: with the data cached, a caller hammering
// /sitemap.xml costs Node a render and costs Postgres nothing.
//
// FIFTEEN MINUTES, and the number is set by what a stale entry can do, not by
// crawl cadence. A crawler re-reads a sitemap a few times a day, so any window
// under an hour is invisible to it. What a window DOES change is how long a
// pet erased under Ley 25.326 art. 16 keeps appearing here after its
// `/p/{token}` has started answering 404 — the erased-vs-never-existed
// distinction PO-4 exists to hide. The reads themselves already exclude erased
// pets; the window only delays when that takes effect, so it is kept short. The
// price is four sitemap refreshes an hour, independent of traffic.
const SITEMAP_REVALIDATE_SECONDS = 900;

// Two budgets, in the order the panorama layer-cache incident taught: the
// cached BODY is bounded with withDbBudgetOrThrow, because Next re-runs it in
// the background on stale-while-revalidate with no caller waiting and no
// rejection consumer, and throwing keeps the stale entry instead of caching a
// degraded one. The CALL SITE is bounded with loadWithTimeout, so a cold cache
// against a degraded database cannot hang the request.
const SITEMAP_DB_BUDGET_MS = 8_000;
const SITEMAP_LOAD_TIMEOUT_MS = 10_000;

/** One sitemap entry's data, JSON-safe so it survives the Data Cache round trip. */
type SitemapRow = { token: string; lastModified: string | null };
type SitemapRows = { adoption: SitemapRow[]; lost: SitemapRow[]; shelters: SitemapRow[] };

// The Data Cache stores JSON, so a Date comes back from a cache HIT as a
// string while the MISS that filled it returned a Date. Normalising here means
// the two paths hand the render the same shape.
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

async function readSitemapRows(): Promise<SitemapRows> {
  const [{ items: adoptItems }, { items: lostItems }, orgs] = await Promise.all([
    queryAdoptionListing({}, null, SITEMAP_PAGE_SIZE),
    queryLostListing({}, null, SITEMAP_PAGE_SIZE, SITEMAP_PAGE_SIZE),
    // Public refugio profiles — same visibility gate as queryOrgPublicProfile
    // (verified AND orgType in shelter | rescue_network). Handoff P2-10.
    db
      .select({ token: organizations.publicToken, updatedAt: organizations.updatedAt })
      .from(organizations)
      .where(
        and(
          eq(organizations.verified, true),
          inArray(organizations.orgType, ["shelter", "rescue_network"]),
        ),
      )
      .limit(SITEMAP_PAGE_SIZE),
  ]);

  return {
    adoption: adoptItems.map((pet) => ({
      token: pet.petPublicToken,
      lastModified: isoOrNull(pet.adoptionListedAt),
    })),
    lost: lostItems.map((pet) => ({
      token: pet.petPublicToken,
      lastModified: isoOrNull(pet.markedLostAt),
    })),
    shelters: orgs.map((org) => ({ token: org.token, lastModified: isoOrNull(org.updatedAt) })),
  };
}

const loadSitemapRowsCached = unstable_cache(
  () => withDbBudgetOrThrow(readSitemapRows(), SITEMAP_DB_BUDGET_MS, "GET /sitemap.xml"),
  ["sitemap-rows"],
  { revalidate: SITEMAP_REVALIDATE_SECONDS },
);

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Resolved per-request (not at module load) so this never runs during
  // `next build`'s static route analysis — only when the dynamic route is
  // actually hit, matching the lazy fail-closed pattern in lib/utils/dni-hash.ts.
  const SITE_URL = resolveSiteUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE_URL}/adoptar`, changeFrequency: "hourly", priority: 0.9 },
    // /perdidas surfaces every pet currently in status='lost'. Hourly because
    // marked-lost / marked-found are owner actions that can land any moment.
    { url: `${SITE_URL}/perdidas`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/denuncias/nueva`, changeFrequency: "monthly", priority: 0.6 },
  ];

  // A MISSED DEADLINE FAILS THE ROUTE, deliberately, instead of degrading to the
  // four static entries. A crawler that gets a 5xx keeps the sitemap it already
  // has and retries; a crawler that gets a 200 with four URLs takes it as the
  // new truth. The truncated answer is the confident wrong one.
  const load = await loadWithTimeout(loadSitemapRowsCached(), SITEMAP_LOAD_TIMEOUT_MS);
  if (!load.ok) {
    throw new Error(
      `sitemap: listing reads unavailable (${load.reason}, ref ${load.id ?? "none"})`,
    );
  }
  const { adoption, lost, shelters } = load.value;

  // The three token-bearing shapes come from `@dim/contract/links` rather than
  // from template literals here. A sitemap is the one surface where a stale path
  // is invisible for months: nothing renders it, nobody clicks it, and the only
  // reader is a crawler that answers with a 404 it never reports back.
  const petRoutes: MetadataRoute.Sitemap = adoption.map((pet) => ({
    url: deepLinkUrl(SITE_URL, "adoptionListing", { petToken: pet.token }),
    lastModified: pet.lastModified ?? undefined,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  // Lost pets land on the public credential at /p/{token} — same surface
  // the QR code points to. The credential auto-promotes to Tier 1 LOST when
  // the pet's status is 'lost', so there is no /perdidas/{token} sub-route.
  const lostRoutes: MetadataRoute.Sitemap = lost.map((pet) => ({
    url: deepLinkUrl(SITE_URL, "credential", { publicToken: pet.token }),
    lastModified: pet.lastModified ?? undefined,
    changeFrequency: "daily",
    priority: 0.85,
  }));

  const refugioRoutes: MetadataRoute.Sitemap = shelters.map((org) => ({
    url: deepLinkUrl(SITE_URL, "shelter", { orgToken: org.token }),
    lastModified: org.lastModified ?? undefined,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...staticRoutes, ...petRoutes, ...lostRoutes, ...refugioRoutes];
}
