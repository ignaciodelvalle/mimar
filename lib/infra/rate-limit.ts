// Persistent rate limiter backed by rate_limit_buckets (rate-limit.ts).
//
// All anonymous public-write and public-read rate limiting uses enforceRateLimit
// (DB-backed, atomic UPSERT, cross-worker). This is the only implementation;
// the former makeMemoryRateLimiter (per-worker, not cold-start-safe) has been
// removed. Do NOT re-introduce in-memory limiting for multi-instance deployments.
//
// Usage:
//   try {
//     await enforceRateLimit("welfare_anon", ip, { maxPerHour: 3, maxPerMinute: 1 });
//   } catch (err) {
//     if (err instanceof RateLimitError) return { error: "rate_limited" };
//     throw err;
//   }

// ---------------------------------------------------------------------------
// Persistent rate limiter — backed by rate_limit_buckets
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { db, rateLimitBuckets } from "@/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// emailRateLimitKey — stable, non-reversible identifier for per-email budgets.
//
// The auth surfaces (login, password-reset) add a per-EMAIL rate-limit budget on
// top of the per-IP one so a distributed botnet cannot brute-force or mail-bomb a
// single account from many IPs. The email is the natural identifier, but writing
// raw emails into rate_limit_buckets.bucket_key would persist PII (Ley 25.326) in
// a table that every worker can read. Hash it: SHA-256 of the normalized email,
// truncated to 160 bits of hex — enough to make collisions astronomically
// unlikely while keeping the key compact and free of cleartext PII.
// ---------------------------------------------------------------------------
export function emailRateLimitKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 40);
}

// ---------------------------------------------------------------------------
// callerIp — derive the trusted client IP from request headers.
//
// WHY NOT split(",")[0]:
//   The first segment of x-forwarded-for is CLIENT-CONTROLLED. An attacker
//   can send "X-Forwarded-For: 1.2.3.4, 5.6.7.8" and the first segment will
//   be "1.2.3.4" — a value the attacker chose, giving them a fresh rate-limit
//   bucket per request. This defeats every IP-keyed rate limit.
//
// SOURCES IN PRIORITY ORDER (Vercel / nginx / typical CDN), each labelled with
// how much is actually KNOWN about it rather than assumed:
//   1. x-real-ip  — overwritten by the edge. Preferred. MEASURED on Vercel, on
//      two /api/v1 routes, on one day (see below); NOT verified request-shape by
//      request-shape, nor on any other host. Behind no edge at all it is simply
//      believed — which is the whole of the local story below.
//   2. LAST segment of x-forwarded-for  — the edge appends the real observed
//      source IP as the rightmost hop. Prior hops may be spoofed; the last is
//      *assumed* edge-appended and trustworthy. THIS ONE IS UNVERIFIED — see
//      "SOURCE 2 IS NOT MEASURED" below before relying on it.
//   3. "unknown" — local dev / direct invocation with no proxy headers.
//
// ===========================================================================
// SOURCE 1 IS MEASURED, NOT ASSUMED — 2026-08-26, against dim-staging
// ===========================================================================
// Preferring x-real-ip is the load-bearing assumption under EVERY per-IP
// ceiling in this repo: `api_v1_*` (lib/infra/api-v1-limits.ts), `auth_login_ip`,
// the anonymous public-write budgets, `lib/infra/public-token-throttle.ts`. If a
// client could choose its own value, all of them would be decoration — one
// header per request buys one fresh bucket per request.
//
// Until 2026-08-26 this comment simply ASSERTED that ("set by the edge; never
// forwarded from the client"), and two other files in the repo had meanwhile
// built a mechanism on the OPPOSITE belief: `scripts/load-probe-api-v1.ts` and
// `playwright.staging.config.ts` both stamped a random RFC 5737 address into
// x-real-ip specifically so their runs would land in a fresh bucket. Two
// incompatible beliefs about the same header, neither of them tested.
//
// So it was tested, against https://dim-staging.vercel.app:
//
//   FIRST ATTEMPT, WHICH PROVED NOTHING. 75 requests to /api/v1/me with NO
//     Authorization header: 75×401, zero 429. That is not evidence about the
//     limiter — `createClientFromBearer` runs BEFORE it (app/api/v1/me/route.ts,
//     and the same order in every sibling), so a request with no token is
//     refused without a counter write. Reaching the limiter needs a WELL-FORMED
//     but invalid JWT; the tell is the body flipping from `auth_required` to
//     `auth_expired`.
//
//   POSITIVE CONTROL. 80 concurrent requests to /api/v1/me, well-formed invalid
//     bearer, a FIXED `x-real-ip: 203.0.113.7`  →  59×401 then 21×429. The
//     limiter bites at 60/min. The instrument works.
//
//   DISCRIMINATING TEST. 80 concurrent requests to /api/v1/me/pets, same
//     well-formed invalid bearer, `x-real-ip` ROTATED 203.0.113.1 … .80 — one
//     distinct address per request  →  60×401 then 20×429. The SAME ceiling as
//     the control, off by a single request, which is ordinary jitter when 80
//     requests race against a counter at 60 and not a difference in mechanism.
//     If the header were believed, 80 unique bucket keys would have produced
//     80×401 and no 429 at all — not a one-request wobble, a total absence.
//
//   WHY THE CEILING READS 60 AND NOT 600. The deployment under test was the
//     PRE-WU-EAS-2 build: `adb22ddd5`, which raises this family to 600/min, was
//     still unpushed on the day of the measurement, so staging was serving the
//     old 60/min ceilings. Anybody reproducing this against a staging that has
//     since taken that commit must fire more than 600, not more than 60, and
//     should confirm the control bites before trusting the rotated arm.
//
//   CONFOUND RULED OUT. The rotation really did vary: `xargs -I{}` was verified
//     to substitute inside the single-quoted `sh -c` string, so 80 genuinely
//     distinct headers went out.
//
// CONCLUSION, AND ITS EXACT SCOPE: a client-supplied x-real-ip did not reach
// this function on 2026-08-26, on dim-staging.vercel.app, on the two /api/v1
// routes fired. That is a Vercel-edge property, and it is the one every per-IP
// ceiling in this repo is deployed behind — so source 1 is safe to prefer THERE.
// It is not a property of the header, of HTTP, or of any other host: an origin
// with no rewriting proxy in front of it believes whatever arrives (that is why
// the local probe and the e2e uniqueIp() device still work, and why such an
// origin must never be exposed). Read "on every request" as "on every request
// through that edge", not as a universal law nobody measured.
//
// HOW TO RE-TEST IT, because this is a PLATFORM property and platforms change.
// The shape is the three steps above and the middle one is not optional — a run
// with no positive control cannot tell "the header was ignored" apart from "the
// limiter never ran". Fire N > ceiling concurrent requests at one /api/v1 route
// with a well-formed invalid bearer, once with a fixed x-real-ip (expect 429s
// after `ceiling` responses) and once with a rotated one (expect the SAME
// result). Two different results would mean the header is believed, and every
// per-IP ceiling in this repo would need re-keying that day — but NOT blindly
// onto source 2, for the reason immediately below.
//
// ===========================================================================
// SOURCE 2 IS NOT MEASURED. It is a platform assertion, of the genre that has
// now been wrong twice in this repo.
// ===========================================================================
// "The edge appends the real observed source IP as the rightmost x-forwarded-for
// hop" is exactly the shape of claim that the paragraph above had to retract:
// confident, plausible, borrowed from how proxies are generally described, and
// never fired at a live origin. It is not tested here and it has never been
// tested against Vercel. `__tests__/caller-ip.test.ts` pins the PARSING (last
// non-empty segment, never the first) — parsing is all it can pin; a unit test
// cannot tell you what a CDN writes.
//
// Nothing reaches source 2 on Vercel today, which is precisely why nobody has
// noticed: source 1 is always present there, so this branch is dead code in
// production and live only for local dev, direct invocation and hosts that set
// XFF but not x-real-ip.
//
// WHAT WOULD HAVE TO BE MEASURED before anyone re-keys onto it. The same
// three-step shape, with the roles swapped: on the target platform, with
// x-real-ip ABSENT from the resolver's priority (or an origin that does not set
// it), fire N > ceiling concurrent requests with a well-formed invalid bearer —
// once sending NO x-forwarded-for, once sending a client-chosen ROTATED XFF of
// several segments. If the rotated arm produces no 429 while the control does,
// the edge is APPENDING to the client's list and the last segment is whatever
// the client put last: source 2 would then be client-controlled and unusable as
// a rate-limit key. Only the opposite result — the same ceiling in both arms —
// licenses the sentence above. Until that run exists, treat source 2 as a
// best-effort fallback for non-hostile environments, never as a security
// boundary.
//
// A NOTE ON WHAT THE MEASUREMENT ALSO SETTLED, because it is cited elsewhere:
// the bearer SHAPE check precedes the limiter on every `/api/v1` route, so a
// caller with no token costs no counter write and never reaches GoTrue. Only a
// well-formed invalid token spends the bucket — and therefore only a
// well-formed invalid token can force the GoTrue round-trip the write family's
// docblock prices in.
//
// This function accepts a Headers / ReadonlyHeaders object (the value returned
// by next/headers `headers()`, already awaited) so it stays synchronous and
// pure — easy to unit-test without touching next/headers.
// ---------------------------------------------------------------------------

/** Minimal header-bag shape compatible with both Headers and ReadonlyHeaders. */
export interface HeaderGetter {
  get(name: string): string | null;
}

/**
 * Returns the trusted caller IP from the request headers.
 *
 * Priority:
 *   1. x-real-ip (measured not spoofable THROUGH VERCEL'S EDGE, 2026-08-26;
 *      believed as sent by an origin with no rewriting proxy — see above)
 *   2. last non-empty segment of x-forwarded-for (assumed edge-appended;
 *      UNVERIFIED — see "SOURCE 2 IS NOT MEASURED" above)
 *   3. "unknown"
 *
 * Sources 1 and 2 pass through `callerSubject` (below): an IPv6 caller comes
 * back as its /64 prefix, an IPv4-mapped one as its IPv4, anything unparseable
 * exactly as it arrived.
 */
export function callerIp(hdrs: HeaderGetter): string {
  // 1. x-real-ip — Vercel's trusted edge IP header. A client-supplied value
  //    does not survive the edge; measured 2026-08-26 against dim-staging with
  //    a positive control, and the method to re-run it is in the block above.
  //    Behind NO edge (a bare `next start`, a direct invocation) nothing
  //    overwrites it and this line will believe whatever arrives — which is why
  //    the local probe can still ask for a fresh bucket, and why an origin
  //    without a rewriting proxy in front of it must never be exposed.
  const realIp = hdrs.get("x-real-ip")?.trim();
  if (realIp) return callerSubject(realIp);

  // 2. Last segment of x-forwarded-for — on the assumption that the edge
  //    appends the observed source IP as the rightmost entry. UNMEASURED: see
  //    the block above for what would have to be fired to earn that sentence.
  //    Unreachable on Vercel (source 1 always answers there), so this is the
  //    non-Vercel / no-edge path. DO NOT take the first segment either way: it
  //    is set by the client and can be freely spoofed to bypass per-IP limits.
  const xff = hdrs.get("x-forwarded-for");
  if (xff) {
    const segments = xff.split(",");
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].trim();
      if (seg) return callerSubject(seg);
    }
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// callerSubject — WHO a per-IP bucket is about, which for IPv6 is not one
// address.
//
// THE HOLE. Every per-IP ceiling in this repo was keyed on the full address.
// For IPv4 that is roughly one subscriber (or one NAT full of them). For IPv6 it
// is not: the unit an ISP or a hosting provider hands out is a /64 at the least
// (RFC 6177; a home line or a VPS typically gets a /64 or a /56, a hosting
// account a /48), and every host picks its own interface identifier inside it —
// privacy extensions (RFC 8981) rotate it on their own. So one machine owns 2^64
// addresses, and a limiter keyed on the full address gave it 2^64 fresh
// buckets: every per-address ceiling was decoration for anyone on IPv6. The
// sharpest case was the anonymous-report surfaces (anonymous-report-limits.ts),
// where the per-address bucket is what keeps one sender from spending an
// animal's whole budget.
//
// THE FIX. An IPv6 caller is keyed on its /64 — the smallest block that is
// still one subscriber — written as the canonical prefix `a:b:c:d::/64`, after
// normalising the address so every spelling of the same /64 lands in one
// bucket (compressed `::`, leading zeros, upper case, a zone id, brackets). An
// IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, as a dual-stack socket reports an
// IPv4 peer) IS that IPv4 caller and is keyed as the dotted quad. IPv4 stays per
// address.
//
// WHY NOT /56 OR /48. A /48 is what a hosting account gets, and grouping on it
// would put unrelated subscribers of a consumer ISP in one bucket (they are
// handed /56s or /64s out of shared /48s). The /64 is the one grouping that
// never merges two subscribers; an attacker with a /48 still has 65 536 /64s,
// which is why the anonymous-report surfaces do not rely on this bucket alone.
//
// GARBAGE IN, TODAY'S BEHAVIOUR OUT. Anything that is not a well-formed IPv4 or
// IPv6 literal is returned exactly as it arrived (trimmed by the caller), so a
// header shape nobody anticipated degrades to the old per-string key rather
// than to a shared or empty one.
// ---------------------------------------------------------------------------

const IPV4_LITERAL = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The eight 16-bit groups of an IPv6 literal, or null when it is not one. */
function ipv6Groups(literal: string): number[] | null {
  let text = literal;
  // An embedded dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is the last
  // 32 bits spelled in decimal; turn it into two hex groups first.
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".", lastColon)) {
    const quad = text.slice(lastColon + 1);
    if (!IPV4_LITERAL.test(quad)) return null;
    const [a, b, c, d] = quad.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  // `::` stands for at least one zero group.
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * The rate-limit subject for one trusted address: IPv4 as-is, IPv6 as its /64,
 * IPv4-mapped IPv6 as the IPv4. Exported for its unit test; callers go through
 * `callerIp`.
 */
export function callerSubject(address: string): string {
  if (IPV4_LITERAL.test(address)) return address;

  // `[2001:db8::1]` (URL form) and `fe80::1%eth0` (zone id) name the same host.
  let literal = address;
  if (literal.startsWith("[") && literal.endsWith("]")) literal = literal.slice(1, -1);
  const zone = literal.indexOf("%");
  if (zone !== -1) literal = literal.slice(0, zone);
  if (!literal.includes(":")) return address;

  const groups = ipv6Groups(literal);
  if (!groups) return address;

  // ::ffff:0:0/96 — an IPv4 peer as a dual-stack socket reports it.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }

  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

export type RateLimitConfig = {
  maxPerMinute?: number;
  maxPerHour?: number;
  maxPerDay?: number;
};

export class RateLimitError extends Error {
  resetAt: Date;
  reason: string;
  constructor(resetAt: Date, reason: string) {
    super(`Rate limit exceeded: ${reason}`);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// rateLimitKeySegment — every piece of a bucket key has a fixed maximum size.
//
// THE HOLE (T2-S5, 2026-09-18). Bucket keys were `${endpoint}:${identifier}`
// verbatim, and both halves can carry attacker-chosen text: `callerSubject`
// returns an unparseable x-real-ip / x-forwarded-for segment exactly as it
// arrived (by design — see above), and several endpoints embed a public token
// taken from the URL (`dispute_tip:${publicToken}`). So one request could
// persist a header-sized primary key into rate_limit_buckets — thousands of
// bytes per row, one row per window per request, in the fastest-filling table
// in the schema — and echo it into the RateLimitError message and the logs.
//
// THE FIX. A segment that is already short and made only of the characters a
// real identifier uses (an IPv4, an IPv6 /64 prefix, a uuid, a public token, a
// hashed email, a constant endpoint name) is kept verbatim — so every existing
// key, and every test and cleanup that matches keys by prefix, is unchanged.
// Anything else (too long, or carrying any other character) is replaced by
// `#` + 160 bits of SHA-256 over its NFC-normalised, trimmed form. `#` is
// outside the verbatim alphabet, so a raw segment can never spell a hashed one
// and the two forms cannot collide; 160 bits is the same width
// `emailRateLimitKey` already relies on.
//
// Normalising before hashing matters: without it, the same text in composed
// and decomposed Unicode, or with a trailing space, would buy a fresh bucket.
// ---------------------------------------------------------------------------

/** Longest segment kept verbatim. A uuid is 36; an IPv6 /64 prefix at most 23. */
export const RATE_LIMIT_SEGMENT_MAX = 64;

const RATE_LIMIT_VERBATIM_SEGMENT = /^[A-Za-z0-9._:/@-]+$/;

/**
 * The bounded form of one bucket-key segment: verbatim when short and plain,
 * otherwise `#` + 40 hex chars of SHA-256. Exported for its unit test.
 */
export function rateLimitKeySegment(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length <= RATE_LIMIT_SEGMENT_MAX && RATE_LIMIT_VERBATIM_SEGMENT.test(normalized)) {
    return normalized;
  }
  return `#${createHash("sha256").update(normalized).digest("hex").slice(0, 40)}`;
}

export async function enforceRateLimit(
  rawEndpoint: string,
  rawIdentifier: string,
  config: RateLimitConfig,
): Promise<void> {
  const now = Date.now();
  // Bounded before any key is built — see rateLimitKeySegment.
  const endpoint = rateLimitKeySegment(rawEndpoint);
  const identifier = rateLimitKeySegment(rawIdentifier);

  if (config.maxPerMinute !== undefined) {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const key = `${endpoint}:${identifier}:minute:${windowStart}`;
    await consumeOrThrow(key, new Date(windowStart + 60_000), config.maxPerMinute);
  }

  if (config.maxPerHour !== undefined) {
    const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
    const key = `${endpoint}:${identifier}:hour:${windowStart}`;
    await consumeOrThrow(key, new Date(windowStart + 3_600_000), config.maxPerHour);
  }

  if (config.maxPerDay !== undefined) {
    const windowStart = Math.floor(now / 86_400_000) * 86_400_000;
    const key = `${endpoint}:${identifier}:day:${windowStart}`;
    await consumeOrThrow(key, new Date(windowStart + 86_400_000), config.maxPerDay);
  }
}

async function consumeOrThrow(bucketKey: string, expiresAt: Date, limit: number): Promise<void> {
  const rows = await db
    .insert(rateLimitBuckets)
    .values({ bucketKey, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: rateLimitBuckets.bucketKey,
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });

  // Guard: the returning() array should always have exactly one row after an
  // INSERT ... ON CONFLICT DO UPDATE. If the driver returns an empty array
  // (connection glitch, driver edge-case) we throw a clear error rather than
  // letting the undefined row cause a confusing TypeError downstream.
  const row = rows[0];
  if (!row) {
    throw new Error(`enforceRateLimit: UPSERT returned no rows for key "${bucketKey}"`);
  }

  if (row.count > limit) {
    throw new RateLimitError(expiresAt, `${bucketKey} (count=${row.count}, limit=${limit})`);
  }
}

/** Maximum expired rate-limit buckets deleted per cleanup call. */
export const RATE_LIMIT_CLEANUP_BATCH_SIZE = 500;

// Cleanup helper — deletes ONE bounded batch of expired buckets and returns the
// count. An unbounded DELETE on this table can hold locks past the cron's
// function budget when a backlog accumulates (review 23 fleet extension), so
// each call is capped at RATE_LIMIT_CLEANUP_BATCH_SIZE and the caller drains
// (see runDataLifecyclePurge). drizzle does not expose DELETE … LIMIT, so we use
// the same subquery-LIMIT pattern as lib/infra/data-lifecycle.ts.
export async function cleanupExpiredBuckets(): Promise<number> {
  const cutoff = new Date().toISOString();
  const result = (await db.execute(
    sql`
      DELETE FROM rate_limit_buckets
      WHERE bucket_key IN (
        SELECT bucket_key FROM rate_limit_buckets
        WHERE expires_at < ${cutoff}::timestamptz
        LIMIT ${RATE_LIMIT_CLEANUP_BATCH_SIZE}
      )
      RETURNING bucket_key
    `,
  )) as Array<{ bucket_key: string }>;
  return result.length;
}
