// Per-IP ceiling for the anonymous BROWSE pages a crawler is wanted on:
//
//   /perdidas            bucket `lost_listing`        (audit A03-G7)
//   /refugios/{orgToken} bucket `org_public_profile`  (audit A03-3)
//
// Both carried no limiter at all. /perdidas is the bulk lost-pet feed — every
// card links a credential token, `?cursor=` walks the population, and each
// render is the heaviest anonymous read in the product. /refugios/{orgToken}
// fans out three queries per hit (four for a signed-in visitor), and the
// directory at /refugios publishes every org token, so nothing needs guessing.
//
// ONE NUMBER, TWO BUCKETS. The buckets are separate so a scraper of one page
// cannot spend the budget of a visitor on the other, and so the counters say
// which page is being hit. The number is shared because the derivation is: the
// same anonymous caller, the same crawler case, the same act (reading a page
// that lists things). Written once here so the two cannot drift.
//
// ---------------------------------------------------------------------------
// THE DERIVATION
// ---------------------------------------------------------------------------
// POPULATION. Anonymous, so the planning figure is the one
// `app/api/v1/pets/[publicToken]/credential/limits.ts` derives for the other
// anonymous public surface: 1,000 subscribers behind one carrier IPv4 (port
// blocks of 64-128 out of 65,536). A per-IP counter here is a per-thousand-
// people counter.
//
// ONE VISIT IS SEVERAL RENDERS. The URL is the state on both pages: every
// quick-filter chip and every "Mostrar más" on /perdidas is a navigation and a
// server render, and so is every sheet on a shelter's profile (?sheet=contactar,
// ?sheet=donar, …). Six renders is a visit: the landing plus a handful of taps.
// Link PREFETCHES spend nothing: both routes have a loading.tsx, and Next's
// automatic prefetch of a dynamic route stops at that boundary without running
// the page.
//
// THE GATEWAY'S HOUR. A barrio-wide lost-pet alert, sized with credential/
// limits.ts's own fractions: 10% of the gateway opens the board within the
// hour, 100 people × 6 renders = 600/hr. Its minute: a quarter of them inside
// the same sixty seconds, 25 × 2 renders = 50/min.
//
// THE CRAWLER. robots.txt opens both pages on purpose and the sitemap lists
// every shelter. A crawler does not sit behind a carrier gateway, and one that
// crawls from a single address at a sustained ONE REQUEST PER SECOND is taken
// as the upper bound: 60/min, 3,600/hr. A well-behaved crawler slows down on
// its own long before that against a page this expensive.
//
//   per hour   3,600 = that crawler, the whole hour, never refused
//                    = 6× the gateway's alert hour
//   per minute   120 = 2× the crawler's minute
//                    = 2.4× the gateway's alert minute
//
// WHY NOT THE CREDENTIAL'S ×12 HEADROOM (600/min + 6,000/hr). Both differences
// point down. (1) What a refusal costs: here, a browsing visitor waits a minute
// and sees the page's own chrome with a notice where the grid was; on
// /p/{token} it is a finder standing over an animal losing the only page that
// helps — and that finder is not on this bucket, the credential has its own.
// (2) What a render costs: /p/{token} is essentially one indexed read; a
// /perdidas render is an ordered scan of up to 500 lost pets with a correlated
// subquery per row, up to three event reads and three sitewide counts; a
// shelter profile is three or four. At
// 3,600/hr one address sustains about one render a second, which lands in the
// same order of queries per second the credential's 6,000/hr allows at one
// read per request.
//
// WHAT THE SOFT FAIL COSTS A CRAWLER. The throttled response is a 200 — a
// server component cannot set a status — carrying the page's chrome and a
// notice instead of the grid, the same shape as the page's existing "No
// pudimos cargar el listado" state. That is why the ceiling is set so that the
// crawler case above is never refused, rather than relying on the notice being
// harmless to an index.
//
// FAILS OPEN on limiter infrastructure failure, like every caller of
// `isPublicTokenReadThrottled`: the limiter is itself a DB write, and on a
// degraded database it must not be the thing that breaks a page whose own
// degraded render is already written.

import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/** Per IP, for `lost_listing` and `org_public_profile`. Derivation above. */
export const PUBLIC_BROWSE_READ_LIMIT: RateLimitConfig = {
  maxPerMinute: 120,
  maxPerHour: 3_600,
};
