// Rate-limit constants for GET /api/v1/pets/[publicToken]/credential.
//
// A Next.js route file may only export HTTP handlers and segment config —
// `next build` type-checks that contract and rejects any other export (the
// typecheck/lint/test gates all passed over the old shape; only the build
// caught it). Constants the tests and the handler share therefore live here.
//
// ===========================================================================
// B13 — THE PER-IP CEILING vs ARGENTINE CARRIER NAT (re-derived 2026-08-25)
// ===========================================================================
// The numbers below used to be 60/min + 400/hr on the surface bucket and
// 20/min + 100/hr per lookup, inherited from `atender_lookup` — a limiter that
// bounds an ORGANIZATION'S staff, who each have their own office IP. This
// endpoint's caller is a phone, and a phone in Argentina is behind CGNAT.
//
// WHAT CGNAT DOES TO A PER-IP COUNTER
// ---------------------------------------------------------------------------
// Every mobile carrier here (Personal, Claro, Movistar) shares one public IPv4
// across many subscribers. The planning figure comes from port-block
// arithmetic: 65,536 TCP ports per address, allocated in blocks of 64-128 per
// subscriber, which is 512-1,024 subscribers per address before oversubscription
// is even counted. This file uses **1,000 subscribers per public IPv4** as the
// planning number — the realistic upper end, because a limit that only works at
// the optimistic end is not a limit, it is a coin flip on which gateway a
// finder happens to be behind.
//
// So a per-IP counter here is not "per user". It is per THOUSAND users, and it
// has to be read that way in every line below.
//
// ---------------------------------------------------------------------------
// SURFACE, per IP: 60/min → 600/min, 400/hr → 6,000/hr
// ---------------------------------------------------------------------------
// LEGITIMATE LOAD. Take a gateway where 10% of subscribers open a credential in
// a given hour — 100 people, ~6 reads each (open the card, refresh, re-open
// after a message) = 600/hr. The OLD 400/hr refused that gateway outright,
// during ordinary use, with nobody doing anything wrong. Per minute, the burst
// is a broadcast: if a quarter of the hour's readers land inside the same 60
// seconds, 25 people × 2 reads = 50/min, already at the old 60/min ceiling with
// zero headroom for anything else the same thousand people are doing.
//
// At 6,000/hr that same hour spends 10% of the budget, and 600/min gives ×12 on
// the burst. To exhaust the new ceiling a single carrier gateway would have to
// produce 1,000 credential reads an hour MORE than the modelled peak.
//
// WHAT THE CEILING GIVES UP. Almost nothing, and this is the part worth
// checking rather than asserting.
//
// THE KEYSPACE FIGURE HERE WAS WRONG UNTIL 2026-08-25, and it is corrected
// rather than quietly edited because the mistake was in the direction that
// flatters the decision. It read "36^8 ≈ 2.82 × 10^12". The generator
// (lib/infra/publicToken.ts) draws from a 31-CHARACTER alphabet —
// `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, with 0/O and 1/I/l removed so a human can
// read a token off a physical tag — so the real space is
// 31^8 = 852,891,037,441 ≈ 8.53 × 10^11. The original was 3.3× too generous.
//
//     at   400/hr — 2.13 × 10^9 hours to walk it ≈ 243,000 years
//     at 6,000/hr — 1.42 × 10^8 hours to walk it ≈  16,200 years
//
// Both are still beyond any attacker's patience by orders of magnitude, so the
// 15× relaxation moves enumeration-from-one-IP from impossible to impossible.
// The conclusion survives the correction, which is exactly why the correction is
// safe to state plainly instead of defended.
// The per-IP hourly ceiling never was an enumeration control; a DISTRIBUTED
// walk is what enumeration actually looks like and neither number touches it
// (D1 says so, and says closing it needs an aggregate limiter of its own).
// What the ceiling really buys is a COST backstop against a single abusive
// source: 6,000/hr is 1.7 req/s sustained, a load one IP can produce against
// any endpoint we have, and stopping it is the platform's DDoS layer's job, not
// a Postgres counter's.
//
// THE COST THAT IS REAL, stated rather than hidden: write amplification. The
// per-lookup counter is written for every caller the surface limit still
// allows, so the worst case grows with the surface's per-MINUTE ceiling — from
// 120 `rate_limit_buckets` rows/min per IP to 1,200. It is bounded, the cleanup
// job drains it (lib/infra/data-lifecycle.ts), and it is an ENUMERATOR-ONLY
// cost: legitimate CGNAT traffic reads few distinct tokens, and a repeat read
// of a token already counted this window writes no new row.
//
// ---------------------------------------------------------------------------
// PER LOOKUP, per token+IP: 20/min → 120/min, 100/hr → 1,200/hr
// ---------------------------------------------------------------------------
// THIS is the bucket the old numbers broke worst, and the case they broke is
// the one the product exists for. `${token}:${ip}` is exactly the hot key when
// a thousand people behind one carrier gateway scan the SAME lost-pet poster.
//
// Same gateway, same 10% in an hour: 100 neighbours × 2 reads = 200/hr on ONE
// (token, ip) pair. The old 100/hr refused the 51st neighbour — a finder
// standing over a lost animal, handed a 429, by a limit installed to protect
// that animal's owner. Per minute it was worse: 20/min refused the 11th person
// to scan a poster in the same sixty seconds.
//
// 1,200/hr puts that hour at 17% of budget. Reaching the ceiling takes ~600
// distinct neighbours reading the same poster twice within one hour behind ONE
// gateway; a story that size is on television, and television is many gateways,
// not one. 120/min is 60 simultaneous scanners behind one gateway.
//
// It stays the TIGHT one: exactly 1/5 of the surface ceiling in both windows.
// One credential may not spend more than a fifth of an IP's whole budget
// through this endpoint, so a caller that reaches the surface limit is provably
// spreading across at least five tokens — which is the shape the surface bucket
// exists to notice.
//
// ---------------------------------------------------------------------------
// A PER-TOKEN-ONLY CAP: CONSIDERED AGAIN, REJECTED AGAIN
// ---------------------------------------------------------------------------
// A counter keyed by the token alone is the only one that would see a scrape of
// ONE credential from many IPs. It is not available here, for three reasons
// that do not go away with tuning:
//
//   1. It cannot tell the scrape from the success case. "One token, many IPs,
//      fast" is also the exact signature of a viral lost-pet poster — the thing
//      this product is FOR. Any ceiling low enough to notice the scrape is low
//      enough to refuse the poster.
//   2. It is a griefing primitive. Anyone, from anywhere, could burn a specific
//      victim credential's global budget and make every real finder get a 429.
//      A limiter whose failure mode is "the lost animal's card stops answering"
//      is worse than the abuse it prevents.
//   3. Nothing behind this endpoint is secret to someone holding the token. The
//      limiter is an abuse control, not an authorization boundary.
//
// The honest home for scrape detection is OBSERVABILITY, not a limiter: alert
// on a token's distinct-IP count and let a person look. That is a different
// change with a different failure mode — a false alarm wakes somebody up
// instead of turning a finder away.
//
// ---------------------------------------------------------------------------
// THE FOUR HTML SURFACES — DEFERRED HERE, LANDED 2026-08-25
// ---------------------------------------------------------------------------
// This section used to say that `public_token_page`, `public_token_encontre`,
// `public_token_sighting` and `public_token_og_image` still ran at 60/min +
// 400/hr, that the arithmetic above applied to them WORD FOR WORD — arguably
// harder, since `/p/{token}` is what a stranger's camera actually opens — and
// that they were left alone only because moving them moves four public surfaces
// and the documented aggregate ceiling at once.
//
// That decision was taken. `PUBLIC_TOKEN_READ_LIMIT` in
// lib/infra/public-token-throttle.ts is now 600/min + 6,000/hr, the same numbers
// for the same reasons, and that file carries the aggregate arithmetic the
// deferral was waiting on. The HTML surfaces get NO per-lookup bucket: adding
// one would double `rate_limit_buckets` writes on the highest-traffic anonymous
// surface in the product to bound a case the surface bucket already bounds.
//
// AND THERE ARE FIVE OF THEM, NOT FOUR (later the same day). The public adoption
// ficha `/adoptar/{petToken}` carried no limiter at all and was exempt on a
// disclosure argument that was true and incomplete — see
// docs/architecture/api-invariants.md §1.1b. It now takes `public_token_adoptar`
// at the same default ceiling, which puts the per-IP aggregate across all
// token-resolving buckets at 6 × 600 = 3,600/min. The heading above is left as
// it was written on purpose: a count in a comment is what made a fifth surface
// of the same shape read as an exception rather than as a gap.
// ===========================================================================

import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/**
 * D3 — the per-lookup bucket, keyed by token AND caller.
 *
 * FOR THE TESTS. The route writes this bucket as a LITERAL at its call site
 * (the throttle coverage fence and `lint:api-v1` reject a computed per-lookup
 * bucket since 2026-08-22, G4); the tests import this name and pin the route's
 * literal to it through the limiter's recorded endpoint.
 */
export const LOOKUP_BUCKET = "public_token_api_credential_lookup";

/**
 * D1 — the per-IP abuse backstop for this endpoint, raised off the shared
 * page limit for CGNAT. Full arithmetic in the header.
 */
export const PUBLIC_TOKEN_API_SURFACE_LIMIT: RateLimitConfig = {
  maxPerMinute: 600,
  maxPerHour: 6_000,
};

/**
 * D3 — the tight one: how hard one caller may hammer ONE credential. Exactly
 * a fifth of the surface ceiling in both windows. Full arithmetic in the header.
 */
export const PUBLIC_TOKEN_API_LOOKUP_LIMIT: RateLimitConfig = {
  maxPerMinute: 120,
  maxPerHour: 1_200,
};
