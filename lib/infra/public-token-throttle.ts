// The per-IP read guard for every anonymous route that resolves a public
// credential token.
//
// WHY THIS IS A SHARED HELPER AND NOT A BLOCK COPIED PER PAGE
// ---------------------------------------------------------------------------
// The guard was written once, inline, in /p/[publicToken]/page.tsx, with a
// comment stating it runs "before touching any pet data". That was true of that
// file and of nothing else: `/p/[publicToken]/encontre` and
// `/p/[publicToken]/sighting` resolve the SAME token through the same
// `publicPetByToken()` lookup and had no limiter at all (found 2026-08-17).
//
// The gap mattered most on `encontre`, whose "allowFinderFormWhenLost=false"
// branch renders the owner's `tel:` and `mailto:` and calls the Supabase ADMIN
// API (`auth.admin.getUserById`) to resolve their email — an unthrottled,
// unauthenticated path to a privileged lookup, once per request, for as many
// requests as anyone cares to make.
//
// Middleware would not have covered it either: `middleware.ts` only refreshes
// the Supabase session. So the limit lives here, and each route calls it as its
// first statement. A new sibling gets the guard by importing it rather than by
// someone remembering the rule — which is how the fifth one
// (`/adoptar/{petToken}`, 2026-08-25) finally got it.
//
// WHAT IT DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
// It does not render. Each route owns its own throttle screen because each has
// different chrome, and a helper that returned JSX would force one shape on all
// of them.
//
// It CHARGES ONCE PER BUCKET PER REQUEST, however many callers ask — and that
// is now enforced by `React.cache` below, not by convention (2026-09-23). The
// convention used to be "call it from the page component only", and it cost a
// documented hole: /p/[publicToken]'s `generateMetadata` resolved the token
// OUTSIDE the guard, because guarding it too would have billed one visit twice.
// Then the 404 fix put a second honest caller in the route — the landing
// layout, the only code outside `loading.tsx`'s Suspense boundary and so the
// only place `notFound()` still sets a real 404 status. With the charge
// memoised per request, the layout, the page (through the door's port) and
// `generateMetadata` all read ONE answer from ONE increment, and all three read
// the pet row through the same guarded, memoised probe
// (app/(public)/p/[publicToken]/credential-probe.ts). The old residual — a
// caller over the limit still got one metadata read per request — is closed:
// a throttled caller now gets the generic title and no pet read at all.
//
// It FAILS OPEN on limiter infrastructure failure, on purpose and unchanged
// from the original: the limiter is itself a DB write, and the credential is
// the one page an anonymous finder in the street depends on. A degraded
// database must not make the limiter the thing that breaks the page before its
// own degraded render can happen. Rate limiting is an abuse control here, not
// an authorization boundary — nothing behind it is secret to someone holding
// the token.

import { headers } from "next/headers";
import { cache } from "react";

import { withDbBudget } from "@/lib/infra/db-budget";
import {
  type RateLimitConfig,
  RateLimitError,
  callerIp,
  enforceRateLimit,
} from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import type { PublicTokenThrottle } from "@/src/modules/pets/application/read/lookup-public-credential";

/**
 * DEFAULT per-IP limit for public credential reads — the five HTML surfaces.
 *
 * THE COMMENT THAT USED TO BE HERE WAS WRONG, and it is worth saying so rather
 * than quietly editing it. It read: "60/min is generous enough for a legitimate
 * user refreshing behind carrier-grade NAT (many people, one IP)". The
 * arithmetic disagrees. Argentine mobile carriers put 500-1,000 subscribers
 * behind one public IPv4 (port-block allocation: 65,536 ports in blocks of
 * 64-128), so 400/hr was 0.4 credential reads per subscriber per hour before the
 * whole gateway is refused. A barrio WhatsApp group passing around a lost-pet
 * poster exceeds it during ordinary use, and the person it turns away is a
 * finder standing over the animal.
 *
 * ===========================================================================
 * RAISED 2026-08-25 — B13's arithmetic finally applied where it bites hardest
 * ===========================================================================
 * 60/min + 400/hr → 600/min + 6,000/hr, the same numbers and the same reasoning
 * as `PUBLIC_TOKEN_API_SURFACE_LIMIT`. That file's header carries the full
 * derivation and it is not repeated here; what IS worth stating is why these
 * went second and why they should not have stayed behind.
 *
 * ===========================================================================
 * THERE WERE ALWAYS FIVE, AND THE COUNT IN THE PROSE IS WHY ONE WAS MISSING
 * ===========================================================================
 * This paragraph said "the four HTML surfaces" from the day it was written, and
 * the fifth — `/adoptar/{petToken}`, the public adoption ficha — was exempt with
 * a written reason about disclosure that was true and was not the whole
 * question. A count in a comment is a claim about a SET, and it quietly turned
 * "the surfaces that carry the limiter" into "the surfaces that are supposed to
 * carry it": a fifth of the same shape then reads as an exception rather than as
 * a gap. It joined on 2026-08-25 (`public_token_adoptar`) and the arithmetic
 * below moved with it. The lesson is not the number; it is that the number
 * should not have been load-bearing.
 *
 * B13 raised the `/api/v1` credential endpoint first because its caller is
 * obviously a phone. But `/p/{token}` is WHAT A STRANGER'S CAMERA OPENS — it is
 * the surface a QR code actually resolves to, reached by someone standing over a
 * lost animal on a street, on mobile data, behind the same carrier NAT. The
 * argument applies to these harder than to the endpoint it was written for, and
 * leaving them at 0.4 reads per subscriber per hour meant the product's central
 * promise was the most throttled thing in it.
 *
 * THE AGGREGATE, which is the reason this was deferred rather than an oversight.
 * Each surface keeps its own bucket, so a per-IP ceiling is additive across
 * them. The HTML surfaces moved from 240/min to 2,400/min combined (4 × 600) on
 * 2026-08-25, and to 3,000/min later the same day when the adoption ficha joined
 * them (5 × 600). With the API bucket's 600/min the whole token-resolving
 * surface is 3,600/min per IP — 6 × 600 (was 840/min after B13's first half,
 * which is 4 × 60 + 600, and 300/min before it, 5 × 60).
 *
 * ARITHMETIC CORRECTED 2026-08-25 (pre-push review). This paragraph read
 * "6,000/min combined … 6,600/min per IP" — the HOURLY figure (6,000/hr)
 * transplanted into the per-minute slot and then carried into the sum, which
 * overstated the ceiling this very paragraph exists to state honestly by 2.2×.
 * docs/architecture/api-invariants.md §1.1 had 3.000/min right the whole time,
 * so the doc and the code disagreed about the one number the section is for.
 * (It is 3,600/min now, and for a real reason rather than an arithmetic one: a
 * sixth bucket.)
 *
 * That number is large and it is the honest one to write down. What makes it
 * acceptable is that the per-IP hourly ceiling never was the enumeration
 * control, and 15× more of not-being-one is still not one.
 *
 * THE KEYSPACE, CORRECTED 2026-08-25. B13's original arithmetic said 36^8 ≈ 2.82
 * × 10^12. That is wrong: `lib/infra/publicToken.ts` draws from a 31-character
 * alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, with 0/O and 1/I/l removed so a
 * human can read a token off a tag), so the space is 31^8 ≈ 8.53 × 10^11 — 3.3×
 * SMALLER than claimed. Corrected here and in limits.ts rather than left to be
 * rediscovered. Walking it from one IP:
 *
 *     at    400/hr — ≈ 243,000 years   (the old per-surface ceiling)
 *     at  6,000/hr — ≈  16,200 years   (the new one)
 *     at 36,000/hr — ≈   2,700 years   (all six buckets, combined, per IP)
 *
 * The conclusion survives the correction with room to spare, which is why the
 * decision stands and only the numbers moved. A DISTRIBUTED walk — which is what
 * enumeration actually looks like — is untouched by any of these figures, before
 * or after. Closing THAT needs an aggregate limiter keyed per IP across all
 * token reads, a different mechanism that still does not exist (§8 D1 says so).
 *
 * What this ceiling really buys is a cost backstop against one abusive source,
 * and 6,000/hr per surface is still a bound. The write amplification is the real
 * price: these five have no per-lookup bucket, so each allowed request writes at
 * most the surface's own two rows per window, not two more.
 *
 * NO PER-LOOKUP BUCKET IS ADDED HERE, deliberately. The `/api/v1` endpoint has
 * one because it bounds how hard a caller may hammer ONE credential. Giving
 * these five the same would DOUBLE the `rate_limit_buckets` writes on the
 * highest-traffic anonymous surface in the product — a new cost paid by every
 * legitimate scan — to bound a case the surface bucket already bounds at a
 * coarser resolution. If per-credential hammering on the HTML pages ever needs
 * bounding, the mechanism is already here (`publicTokenThrottle`'s `perLookup`
 * option) and it should be a decision with its own measurement.
 *
 * What remains true: a genuinely viral QR is scanned from MANY IPs, so a per-IP
 * limit never sees that case as one caller.
 */
export const PUBLIC_TOKEN_READ_LIMIT: RateLimitConfig = { maxPerMinute: 600, maxPerHour: 6_000 };

/** Budget for the limiter's own DB write. Short: it gates the whole render. */
const RATE_LIMIT_BUDGET_MS = 1500;

async function callerIpFromHeaders(): Promise<string> {
  try {
    const reqHeaders = await headers();
    return callerIp(reqHeaders);
  } catch {
    return "unknown";
  }
}

/**
 * Applies the per-IP read limit for a public-token route.
 *
 * Returns `true` when the caller is over the limit and the route should render
 * its throttle notice INSTEAD of doing any pet lookup. Returns `false` when the
 * route should proceed — including when the limiter itself failed (see the
 * fail-open note in the header).
 *
 * `bucket` names the route in the limiter's own storage so one abusive scraper
 * cannot spend a legitimate finder's budget on a different page, and so the
 * counters stay readable when someone asks which surface is being hammered.
 *
 * `limit` defaults to `PUBLIC_TOKEN_READ_LIMIT`. It is an argument because the
 * surfaces do not have the same caller: an HTML page is opened by a person with
 * a browser, and `/api/v1/.../credential` is called by an app whose thousand
 * neighbours share its IP (B13). A per-surface bucket that could not carry a
 * per-surface CEILING was only half of the separation it claimed to provide.
 */
export function isPublicTokenReadThrottled(
  bucket: string,
  limit: RateLimitConfig = PUBLIC_TOKEN_READ_LIMIT,
): Promise<boolean> {
  // The default is resolved HERE, before the cached call, so a caller that
  // omits `limit` and one that passes PUBLIC_TOKEN_READ_LIMIT explicitly (the
  // adapter below always does) hit the SAME cache entry.
  return chargePublicTokenReadOncePerRequest(bucket, limit);
}

/**
 * ONE CHARGE PER BUCKET PER REQUEST (2026-09-23).
 *
 * `enforceRateLimit` INCREMENTS a counter, so every call is a charge. Until
 * this date that was kept to one per request by convention alone — "called
 * ONCE PER REQUEST, from the page component only" (header). The /p/{token}
 * 404 fix made the convention impossible to keep by hand: the landing LAYOUT
 * has to consult the limiter before it reads the pet row (it is the only code
 * outside `loading.tsx`'s Suspense boundary, so the only place a `notFound()`
 * still sets a real 404), and the page below it consults the same bucket
 * through the door. Two honest callers, one visit.
 *
 * `React.cache` makes it structural: within one server render (layout, page
 * and `generateMetadata` share it) the same `(bucket, limit)` pair is charged
 * once and every later caller reads the same answer. Keys are primitives or
 * module constants on purpose — `cache` compares arguments by identity, so a
 * fresh options object per call would silently defeat it. Outside a React
 * render (route handlers, scripts, vitest) `cache` does not memoise and this
 * is exactly the old function.
 */
const chargePublicTokenReadOncePerRequest = cache(
  (bucket: string, limit: RateLimitConfig): Promise<boolean> =>
    chargePublicTokenRead(bucket, limit),
);

async function chargePublicTokenRead(bucket: string, limit: RateLimitConfig): Promise<boolean> {
  const ip = await callerIpFromHeaders();
  try {
    await withDbBudget(
      enforceRateLimit(bucket, ip, limit).then(() => null),
      RATE_LIMIT_BUDGET_MS,
      `${bucket} rate-limit`,
      null,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return true;
    reportError(`public-token-throttle/${bucket}`, err);
    // Fall through — see the fail-open note in the header.
  }
  return false;
}

/**
 * A SECOND, narrower limiter to consult after the per-IP surface bucket.
 *
 * The `/api/v1` credential endpoint bounds two different things and needs both:
 * the surface bucket bounds how much of the token space one IP can walk, and
 * this one bounds how hard one caller may hammer ONE credential — which on a
 * lost pet means re-reading a disclosed phone number and last-seen location.
 */
export type PerLookupLimit = {
  /** Its OWN bucket, so the two counters stay separately readable. */
  readonly bucket: string;
  /** The narrower key, e.g. `${publicToken}:${ip}`. */
  readonly key: string;
  readonly limit: RateLimitConfig;
};

/**
 * The narrow limiter, with the same fail-open contract as the surface one.
 *
 * `withDbBudget` RESOLVES with its fallback when the write outruns the budget
 * rather than throwing, so a limiter that simply never answers lands on the
 * `return false` below and not in the catch — both are the fail-open path, and
 * both are covered by __tests__/api-v1-credential-route.test.ts.
 */
async function isPerLookupThrottled({ bucket, key, limit }: PerLookupLimit): Promise<boolean> {
  try {
    await withDbBudget(
      enforceRateLimit(bucket, key, limit).then(() => null),
      RATE_LIMIT_BUDGET_MS,
      `${bucket} rate-limit`,
      null,
    );
  } catch (err) {
    if (err instanceof RateLimitError) return true;
    reportError(`public-token-throttle/${bucket}`, err);
    // Fall through — see the fail-open note in the header.
  }
  return false;
}

/**
 * The same guard, bound to a bucket, as the `PublicTokenThrottle` PORT the
 * application layer takes.
 *
 * WHY AN ADAPTER AND NOT A DIRECT IMPORT. `isPublicTokenReadThrottled` calls
 * `next/headers` to read the caller IP, and the application fence bans that
 * specifier inside every `src/modules/<m>/application` tree — a use-case must
 * be runnable without a Next request, because a React Native app has no Next
 * request to give it. So the use-case declares the shape it needs and this
 * module, which already lives on the Next side of the boundary, supplies it.
 *
 * The type is imported TYPE-ONLY: the port is owned by the application layer
 * (the adapter depends on the port, never the reverse), and a type import
 * erases at compile time, so this adds no runtime edge from lib/ into
 * src/modules/.
 *
 * Usage — one statement, the bucket visible at the call site:
 *   lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_page") })
 *
 * WHY `perLookup` LIVES HERE AND NOT IN THE ROUTE (fixed 2026-08-21)
 * ---------------------------------------------------------------------------
 * The `/api/v1` handler used to apply its per-lookup limiter itself, before
 * calling the door — which meant it ran BEFORE the surface bucket, because the
 * surface bucket is applied inside the door through this port. The consequence
 * was write amplification with attacker-chosen cardinality: an IP already over
 * 60/min still wrote TWO `rate_limit_buckets` rows (a minute row and an hour
 * row) for every distinct token it named, and the token space is 31^8 (see THE
 * KEYSPACE above — this line said 36^8 until the same review, in the very file
 * that corrects the figure ninety lines earlier).
 *
 * Moving the surface check earlier in the ROUTE would have double-counted it,
 * because the door applies it again. So both limiters became one port, ordered
 * here: surface first, and the narrower write only for a caller the surface
 * limit still allows. The route is left with one statement and no ordering to
 * get wrong.
 *
 * KNOWN RESIDUAL, stated rather than hidden: UNDER the surface limit, a caller
 * walking distinct tokens still writes two rows per (token, ip) per window.
 * That is the per-lookup limiter working — it cannot count without a counter —
 * and the growth is bounded by the surface limit itself: 2 rows per allowed
 * request, so at most 2 × the surface's per-minute ceiling per IP per minute
 * (1,200 rows/min on the `/api/v1` endpoint, B13). Draining those rows is the
 * cleanup job's problem (lib/infra/data-lifecycle.ts), not this file's.
 *
 * This residual belongs to `perLookup` and therefore to the `/api/v1` endpoint
 * ALONE. The five HTML surfaces pass no `perLookup`, so they write one bucket's
 * rows and not two — which is also why raising their surface ceiling to 600/min
 * (2026-08-25) does not multiply their write cost the way the same raise did on
 * the endpoint that has both counters.
 *
 * `surfaceLimit` overrides the default per-IP ceiling for THIS bucket. See the
 * note on PUBLIC_TOKEN_READ_LIMIT: a per-surface bucket that cannot carry a
 * per-surface ceiling is half a separation, and the half it was missing is the
 * one CGNAT needs.
 */
export function publicTokenThrottle(
  bucket: string,
  options?: { surfaceLimit?: RateLimitConfig; perLookup?: PerLookupLimit },
): PublicTokenThrottle {
  const perLookup = options?.perLookup;
  const surfaceLimit = options?.surfaceLimit ?? PUBLIC_TOKEN_READ_LIMIT;
  return {
    bucket,
    isThrottled: async () => {
      // ORDER IS THE POINT. The surface bucket is the cheap check that bounds
      // enumeration; the per-lookup bucket is the WRITE. A caller the surface
      // limit already refused must not cost the table a row.
      if (await isPublicTokenReadThrottled(bucket, surfaceLimit)) return true;
      if (!perLookup) return false;
      return isPerLookupThrottled(perLookup);
    },
  };
}
