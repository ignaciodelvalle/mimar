// GET /api/v1/pets/{publicToken}/credential — the first `/api/v1` endpoint.
//
// It answers the same question `app/(public)/p/[publicToken]/page.tsx` answers,
// as data instead of HTML, over the SAME door (`lookupPublicCredential`). Not a
// second implementation of the four branches: a handler that re-derived
// throttled / not_found / degraded / ok is how the JSON and the HTML start
// disagreeing about what "degraded" means, which is the exact failure the
// per-section contract exists to prevent (RN-8 #6).
//
// Every line of docs/architecture/api-invariants.md §9 has an answer here; the
// "first endpoint" note in that document maps each one to a file:line.
//
// ---------------------------------------------------------------------------
// TWO LIMITERS, AND WHAT EACH ONE ACTUALLY BOUNDS
// ---------------------------------------------------------------------------
// D1 and D3 are two decisions, not one, and they bound different things. Both
// are applied, in this order, and neither substitutes for the other.
//
// Both were re-derived on 2026-08-25 (B13) against Argentine carrier NAT, which
// puts 500-1,000 subscribers behind one public IPv4. The arithmetic — legitimate
// load, what the ceiling gives up, and why a per-token-only cap is still not
// available — is in `limits.ts`, next to the constants, not restated here.
//
// 1. PER-LOOKUP (D3) — `public_token_api_credential_lookup`, keyed
//    `${publicToken}:${ip}`, 120/min + 1,200/hr.
//
//    BOUNDS: how hard ONE caller may hammer ONE credential. Below the surface
//    ceiling on purpose — a fifth of it, in both windows — so a single IP
//    cannot spend its whole read budget re-reading one animal's card, which on
//    a lost pet means re-reading a disclosed phone number and last-seen
//    location.
//
//    DOES NOT BOUND: enumeration. A caller walking the token space touches a
//    fresh counter with every token and never trips this one; that is the
//    surface bucket's job, below. Nor does it bound a distributed read of one
//    token — and it deliberately must not. A token-only key (no IP) would give
//    exactly that, and would also hand anyone a way to burn a victim
//    credential's global budget so real finders get a 429. On the one surface
//    an anonymous finder in the street depends on, that trade is not available.
//
//    IT USED TO BE ATENDER'S NUMBERS (20/min + 100/hr), because D3 named
//    `atender_lookup` as the model. That model bounds an ORGANIZATION'S staff,
//    who sit on office IPs; this endpoint's caller is a phone. Keyed
//    `${token}:${ip}`, 100/hr refused the 51st neighbour behind one carrier
//    gateway to scan the same lost-pet poster — the success case, not the abuse
//    case.
//
// 2. PER-IP SURFACE (D1) — `public_token_api_credential`, keyed by IP,
//    600/min + 6,000/hr, applied INSIDE the door through the throttle port.
//
//    BOUNDS: how much of the token space one IP can walk, at all, through this
//    endpoint. Its own bucket, so a client hammering the API cannot starve the
//    person loading the credential in the street on `public_token_page` — and
//    since B13, its own CEILING too, which is what makes the separation real
//    rather than nominal. (This line said "the four HTML surfaces keep 60/min +
//    400/hr" until 2026-08-25; B13's second half raised them to the same
//    600/min + 6,000/hr, so the HTML surfaces and the API now differ by BUCKET,
//    not by ceiling. The separation is still real — a client hammering the API
//    cannot spend the street reader's budget — but it is no longer a difference
//    in numbers, and pretending otherwise misleads whoever tunes this next. The
//    count moved too: there are FIVE HTML surfaces since the adoption ficha
//    joined, api-invariants.md §1.1b.)
//
//    DOES NOT BOUND: a distributed walk from many IPs. Closing that needs an
//    aggregate limiter layered on top, which D1 says must be its own change and
//    must not be smuggled into an endpoint. Nor, at any of these numbers, does
//    it meaningfully bound enumeration from ONE IP: walking 31^8 tokens takes
//    ~16,200 years at 6,000/hr and ~243,000 years at the old 400/hr. It is a
//    cost backstop, and it always was.
//
//    The keyspace is 31^8 ≈ 8.53 × 10^11, not the 36^8 ≈ 2.82 × 10^12 this
//    comment asserted until 2026-08-25: `lib/infra/publicToken.ts` draws from
//    `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, with 0/O and 1/I/l removed so a human
//    can read a token off a tag. 3.3× smaller than claimed, and the conclusion
//    survives anyway — which is why the correction is written down instead of
//    quietly edited.
//
// ORDER: SURFACE FIRST, THEN THE WRITE (fixed 2026-08-21)
// ---------------------------------------------------------------------------
// Both limiters arrive through ONE port, and the adapter consults them in that
// order. It used to be the other way round — the per-lookup limiter ran here,
// in the handler, and the surface bucket ran inside the door — so an IP already
// over the surface limit still wrote TWO `rate_limit_buckets` rows (minute +
// hour) for every distinct token it named. The token is attacker-chosen out of a 31^8
// space, so the table's cardinality was bounded by someone's patience rather
// than by the limit that exists to bound exactly that.
//
// The fix could not be "check the surface bucket earlier in this file": the
// door applies it again, and one visit would have billed it twice. So the
// ordering moved into the adapter, where there is exactly one of each check.
//
// BOTH FAIL OPEN on limiter infrastructure failure, matching every sibling: the
// limiter is itself a DB write, and it must not become the thing that breaks
// the credential before the degraded answer can be produced. Rate limiting here
// is an abuse control, not an authorization boundary — nothing behind it is
// secret to someone already holding the token.
//
// KNOWN RESIDUALS, stated rather than hidden:
//   • UNDER the surface limit, a caller walking distinct tokens still writes two
//     rows per (token, ip) per window. That is the per-lookup limiter doing its
//     job — it cannot count without a counter — and the growth is now bounded by
//     the surface limit itself: 2 rows per allowed request, so at most 1,200
//     rows/min per IP at the B13 ceiling (it was 120 at the old 60/min), not one
//     pair per token for as long as anyone keeps typing. The 10× is an
//     ENUMERATOR-only cost: legitimate traffic reads few distinct tokens, and a
//     repeat read of a token already counted this window writes no new row.
//     Draining them is the cleanup job's problem (lib/infra/data-lifecycle.ts).
//   • The token is used verbatim, not upper-cased, because the page resolves it
//     verbatim and the two must agree about which tokens exist. So a caller can
//     vary the case to get a fresh PER-LOOKUP counter. They cannot escape the
//     surface bucket that way, which is the limiter that bounds enumeration.
//
// ---------------------------------------------------------------------------
// WHY NO `Retry-After` ON 429
// ---------------------------------------------------------------------------
// Only one of the two rate-limit branches could carry an honest one. The
// per-lookup limiter throws `RateLimitError`, which knows its `resetAt`; the
// surface limiter arrives as a boolean-returning PORT, because a use-case may
// not import `next/headers` and must run without a Next request at all. Setting
// the header on one branch and not the other would make the two 429s
// distinguishable, and inventing a constant for both would be a fabricated
// hint. A client backs off on the status. When the port can report a reset
// instant, both branches get the header in the same change.
//
// The 503 does carry one: there is no second branch to stay indistinguishable
// from, and "the read failed, come back shortly" is a genuine hint rather than
// a disclosure about a limiter window.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { publicTokenThrottle } from "@/lib/infra/public-token-throttle";
import { callerIp } from "@/lib/infra/rate-limit";
import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";

import { PUBLIC_TOKEN_API_LOOKUP_LIMIT, PUBLIC_TOKEN_API_SURFACE_LIMIT } from "./limits";
import { buildDegradedPublicCredentialV1, buildPublicCredentialV1 } from "./payload";

// The handler reads the request's own headers for the caller IP, so it can
// never be statically rendered. Declared explicitly, matching the sibling
// handlers, rather than relying on Next inferring it from a header read.
export const dynamic = "force-dynamic";

// BOTH buckets — D1's `public_token_api_credential` and D3's
// `public_token_api_credential_lookup` — are written as LITERALS at the call
// site below rather than lifted to constants. That is a requirement, not a
// style choice: __tests__/public-token-throttle-coverage.test.ts and
// scripts/check-api-v1-envelope.ts reject any non-literal bucket, surface or
// per-lookup, because a computed bucket is exactly how one surface starts
// spending another's counter, and it makes "which surface is being hammered"
// unanswerable from the limiter's own storage. The fence caught this file with
// a constant on the first run, and the per-lookup half joined the rule on
// 2026-08-22 (G4) — `limits.ts` keeps `LOOKUP_BUCKET` for the TESTS, which pin
// the literal here to it.
//
// The fences read the source with comments stripped, so this note names the
// rule instead of illustrating it with a call.

/** Advisory backoff on a degraded read. Not a limiter window. */
const DEGRADED_RETRY_AFTER_SECONDS = 30;

// HOW THIS ROUTE ANSWERS: only through apiV1Json / apiV1Error
// (lib/infra/api-v1.ts). `Cache-Control: no-store` is NOT inherited (§4):
// `middleware.ts` stamps it from a path-prefix allowlist that `/api/...` does
// not match. The privacy class that closed on 2026-07-07 was real — a revoked
// share and a found pet served stale from the CDN at the exact shared URL —
// and a JSON endpoint reopens it unless every response sets the header itself.
// This file used to own a private `credentialJson()` for that; the helper is
// now shared and `pnpm lint:api-v1` refuses any `/api/v1` route that builds a
// response by hand, so "every response" is a property of the SURFACE rather
// than of one author's memory.

// @no-auth-required: the public credential is public BY DESIGN — the pet is the
// credential (invariant #1), and this endpoint discloses exactly what
// /p/{publicToken} already shows to anyone holding the token: no owner PII
// beyond the lost-mode fields the owner opted to disclose, no microchip number,
// no internal ids, no DNI. Anonymous access is the product, not an oversight.
// It is bounded instead of authorized: a per-lookup limiter (token+IP) and the
// per-IP surface bucket, both applied before any pet data is read.
export async function GET(
  // A plain `Request`, not `NextRequest`: the only thing this handler needs
  // from it is the header bag, and typing it wider than the need keeps the
  // handler callable from a test without constructing a Next request object.
  request: Request,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  // Derived from the REQUEST, never from a middleware-stamped header: those
  // default silently when the matcher does not run, and a value the request
  // influences must not decide what a caller may do (check-api-guard-headers).
  const ip = callerIp(request.headers);

  // The door. Its FIRST statement is the throttle port, so both limiters run
  // before any pet row is read — D1's surface bucket, then D3's per-lookup
  // bucket for a caller the surface limit still allows. Both fail open; see the
  // header and lib/infra/public-token-throttle.ts.
  const lookup = await lookupPublicCredential({
    publicToken,
    throttle: publicTokenThrottle("public_token_api_credential", {
      surfaceLimit: PUBLIC_TOKEN_API_SURFACE_LIMIT,
      perLookup: {
        bucket: "public_token_api_credential_lookup",
        key: `${publicToken}:${ip}`,
        limit: PUBLIC_TOKEN_API_LOOKUP_LIMIT,
      },
    }),
  });

  switch (lookup.status) {
    // Over one of the two limits. ONE response for both, and identical for a
    // token that exists and one that does not — a rate-limit response must
    // never be an existence oracle, nor a probe for which budget ran out.
    case "throttled":
      return apiV1Error("rate_limited", 429);

    // The token resolves to nothing the caller may see. A SOFT-DELETED pet
    // reaches this same branch, because the filter lives in the query
    // (`publicPetByToken`, PO-4) — an erased subject's credential must be
    // indistinguishable from one that never existed, byte for byte.
    case "not_found":
      return apiV1Error("not_found", 404);

    // A read failed or blew its budget. NOT 404: a database outage is not "this
    // token does not exist", and answering 404 to a finder standing over a lost
    // animal is the worst lie this surface can tell. The body carries the error
    // code ALONGSIDE whatever survived, per-section — the shape
    // app/api/panorama/kpis/route.ts prototyped and §5 prescribes.
    case "degraded":
      return apiV1Json(buildDegradedPublicCredentialV1(lookup, new Date()), {
        status: 503,
        headers: { "retry-after": String(DEGRADED_RETRY_AFTER_SECONDS) },
      });

    case "ok":
      return apiV1Json(buildPublicCredentialV1(lookup, new Date()), { status: 200 });

    default: {
      // Exhaustiveness: a new status added to the union without a branch here
      // is a compile error, not a silent 200 with an empty body.
      const unhandled: never = lookup;
      throw new Error(`Unhandled credential lookup status: ${JSON.stringify(unhandled)}`);
    }
  }
}
