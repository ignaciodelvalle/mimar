// The two login budgets, and the argument for the numbers in them.
//
// Sibling of `password-reset/limits.ts`, same split and same reason: these used
// to be object literals inline at the `enforceRateLimit` call sites in
// `login.ts`, where a number can be changed without meeting the paragraph that
// chose it. Nothing else about the login path moves by extracting them — the
// order of the two spends, their keys and their refusal copy are unchanged and
// still pinned where they always were.
//
// ===========================================================================
// WHY THE PER-IP CEILING MOVED: 10/min → 60/min, 100/hr → 240/hr
// ===========================================================================
// The old pair was 10/min + 100/hr per IP against 5/min + 20/hr per email, and
// the per-minute halves of that are the problem:
//
//   TWO people at their own individual per-email ceiling exhaust the whole
//   gateway's per-IP budget.
//
// `lib/infra/api-v1-limits.ts` already met that exact shape, named it, and said
// what is wrong with it — for the authenticated-write family, in a paragraph
// that transfers here word for word:
//
//   "the bucket that refuses the third legitimate writer is the IP one, and the
//    IP one is the bucket with no reasoning behind its number for this case.
//    That is upside down. … the IP ceiling's job is to stay far enough above it
//    that the USER bucket is the binding constraint for any plausible number of
//    simultaneous legitimate [callers] behind one address."
//
// The per-EMAIL ceiling is where the thinking is: it is the bucket that bounds a
// PERSON, it is what stops a distributed brute force against one account, and it
// is deliberately unchanged below. The per-IP ceiling's only job is to sit far
// enough above it that a crowd behind one address is refused by the bucket that
// is about them, not by the bucket that is about their carrier.
//
// THE ANCHOR IS THE PER-EMAIL CEILING, NOT THE ADOPTION FIGURE
// ---------------------------------------------------------------------------
// `api-v1-limits.ts` sizes its families against a guess — 10% adoption, ~100
// app-holding clients behind one carrier gateway — and says so at the top,
// labelled as the soft spot in everything below it. This file does not use that
// figure, for the reason `password-reset/limits.ts` gives for not using it
// either: a derivation anchored on a ceiling this repo already committed to does
// not need to move when adoption does. That makes it the sturdier of the two
// shapes, and it is the one used here.
//
// TWELVE, AND WHY THE SAME TWELVE AS THE OTHER TWO
// ---------------------------------------------------------------------------
// `API_V1_ACCOUNT_SECURITY_IP_LIMIT` (`/me/revoke-sessions`) is 12× its per-user
// bucket on BOTH windows — 5/min + 20/hr becomes 60/min + 240/hr — and
// `PASSWORD_RESET_IP_LIMIT` is 12× its per-email anchor as well. Login is the
// same class of act as both: rare, deliberate, done from a phone, and with a
// failure mode measured in people who cannot get in rather than in latency.
//
// `LOGIN_EMAIL_LIMIT` happens to carry the identical 5/min + 20/hr as
// `REVOKE_SESSIONS_USER_BUCKET`, so the multiple lands on the identical pair of
// numbers. That is a coincidence of the anchors and not a shared constant, which
// is exactly why the fence below asserts the RELATIONSHIP and not the digits.
//
// WHY NOW, AND IT IS NOT THE TEST SUITE
// ---------------------------------------------------------------------------
// The trigger is that the app is live. Since 2026-08-27 the Android build is on
// Play internal testing and real testers are installing it
// (`docs/mobile/eas-build-profiles.md`). Every login before that arrived from a
// browser on a home connection, where an IP is roughly a household. A login from
// the app arrives from a phone on carrier NAT, where one egress address is
// shared by everyone on that carrier in that region — which is the whole reason
// `api-v1-limits.ts` exists, applied to the one endpoint that had not been
// re-derived because it is not an `api_v1_*` bucket and its own fence does not
// collect it.
//
// THE SUITE WAS SUSPECTED AND MEASURED INNOCENT, which is worth recording
// because the suspicion is the obvious reading of a change like this and it is
// wrong. `playwright.staging.config.ts` runs serially with `retries: 1` from one
// CI egress address and its specs sign in, so the nightly shares one hourly
// login budget; the concern was that it had been quietly eating it. It has not.
// The six most recent nightly runs before 2026-08-27 were searched for every
// signature a login refusal leaves — the es-AR throttle copy, the helper's own
// refusal message, and the `rate_limited` code — and all six returned zero of
// all three. The nightly has indeed been failing, every night, for weeks; it is
// failing on seed data and missing fixtures, not on this ceiling. So this is a
// production derivation that the suite happens to benefit from, and NOT a
// security control relaxed to make tests pass. If it had been the latter, the
// honest fix would have been in the suite.
//
// WHAT IT GIVES UP, stated as a cost and not as a footnote
// ---------------------------------------------------------------------------
//   1. CREDENTIAL SPRAYING GETS 2.4× THE BUDGET. Spraying — one attempt each
//      against many different accounts — is the attack the per-email bucket
//      cannot see, because no single email is tried twice. This bucket is the
//      only thing that bounds it, and from one address it goes from 100
//      candidate accounts an hour to 240. That is a real widening and it is the
//      price of the change. What makes it acceptable is that a sprayer's cost is
//      dominated by acquiring addresses rather than by the rate on any one of
//      them: an attacker who wants 2.4× today rents a second address, and no
//      ceiling in this file can charge them more than that. A ceiling that is
//      2.4× tighter than an attacker's cheapest workaround, while being the
//      binding constraint on a carrier full of legitimate people, is protecting
//      the wrong side of the trade.
//   2. BRUTE FORCE AGAINST ONE ACCOUNT IS UNCHANGED. `LOGIN_EMAIL_LIMIT` did not
//      move. The bucket that protects a PERSON is the same bucket at the same
//      numbers, and it is spent on failed attempts too.
//   3. IT IS ALSO 60 GoTrue ROUND-TRIPS A MINUTE. `login.ts` spends both budgets
//      BEFORE touching GoTrue — deliberately, because a limiter after the
//      credential check bounds nothing that matters — so the per-IP ceiling is
//      simultaneously the ceiling on how much provider work one address can
//      force. Six times more of it than before. This is the same cost
//      `api-v1-limits.ts` writes out for each of its own families, and it is
//      written out here for the same reason: it is the kind of sentence that
//      makes a number look safer than it is when it is left unsaid.
//
// WHAT IS DELIBERATELY NOT IN THIS FILE — AND WHERE IT WENT (2026-08-29)
// ---------------------------------------------------------------------------
// `auth_signup_ip` (3/min + 15/hr, spent in `signup.ts`) had the same shape and
// the same live-app exposure — fifteen new accounts an hour for an entire
// carrier gateway — and was NOT changed here. It has no per-account anchor to
// derive against, so it needed an argument of its own rather than this one
// copied, and signup is the more abuse-attractive of the two doors. It was named
// here so the gap read as a decision and not as an oversight.
//
// IT HAS THAT ARGUMENT NOW: `signup-limits.ts`, and the prediction above held —
// nothing in this file transferred. Having no per-identity anchor turned out not
// to be a missing number but a different SHAPE: a per-email counter on signup
// reads 1 for a citizen and 1 for a farm, because signup is what creates the
// identity, so no per-IP rate can separate the two populations at all. What
// separates them is duration, so that bucket is now a wide burst allowance under
// a DAY ceiling — the first one on any auth bucket keyed on an ADDRESS — set at
// exactly what the old 15/hr already yielded over 24 hours.
//
// "KEYED ON AN ADDRESS" IS THE SCOPE AND IT IS NARROWER THAN THE FIRST DRAFT'S.
// That sentence read "the one window this repo's auth limiters did not use",
// which is false: `REVOKE_SESSIONS_USER_LIMIT`
// (`src/modules/auth/application/revoke-sessions.ts`) is 5/min · 20/hr · 40/day
// and sits in this same module. It is keyed on a USER id, so it is not a
// precedent for what signup needed — a day ceiling anchored on a person is the
// ordinary case, and having no person to anchor on is signup's whole problem —
// but it IS a day window on an `auth_*` bucket, and the absolute walked past it.
// The checkable version of the claim: `rg maxPerDay src/modules/auth/` finds two
// definitions, `REVOKE_SESSIONS_USER_LIMIT`'s and `SIGNUP_IP_LIMIT`'s, and the
// rest of the hits are prose. Recount it rather than quoting this line.
//
// The sentence to carry away for THIS file: the twelve above is not a house
// constant, it is what "simultaneous legitimate callers" is worth when a
// per-identity anchor exists to multiply. Where none does, the multiple is not
// the thing to reach for.
//
// WHAT WOULD RE-DERIVE ANY OF IT: real telemetry. Both numbers below are
// reasoning about a product whose login volume nobody has measured. The first
// week of Play installs is the first chance to replace the reasoning with a
// count, and it should be taken.

import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/**
 * Per email address — the ANCHOR, and the bucket that bounds a PERSON.
 *
 * Unchanged by the re-derivation above: it is what stops a distributed
 * brute-force against one account, it is spent before GoTrue so failed attempts
 * count too, and everything the per-IP ceiling is sized against is this pair of
 * numbers.
 *
 * Keyed on `emailRateLimitKey(email)` so no cleartext address is persisted in
 * `rate_limit_buckets` (Ley 25.326).
 */
export const LOGIN_EMAIL_LIMIT: RateLimitConfig = {
  maxPerMinute: 5,
  maxPerHour: 20,
};

/**
 * How many simultaneous legitimate signers-in behind ONE address the per-IP
 * ceiling is sized for. Named rather than transcribed into two places, and the
 * same twelve `PASSWORD_RESET_SIMULTANEOUS_CALLERS` and
 * `API_V1_ACCOUNT_SECURITY_IP_LIMIT` are already sized by.
 *
 * `__tests__/api-v1-auth-routes.test.ts` asserts the RELATIONSHIP rather than
 * the four numbers, so that raising the per-email anchor without raising the
 * per-IP ceiling — which would put the IP bucket back in front of the email one
 * and invert the whole derivation — fails loudly instead of quietly narrowing
 * the door people get into the app through.
 */
export const LOGIN_SIMULTANEOUS_CALLERS = 12;

/**
 * Per caller IP. Twelve simultaneous legitimate signers-in at their own full
 * per-email ceiling, in both windows.
 *
 * Keyed on `callerIp(headers)` — the trusted edge value (`x-real-ip` / the LAST
 * `x-forwarded-for` hop), never the spoofable first segment. A client that could
 * choose its own key would make this decoration.
 *
 * NOTE FOR ANYONE READING THIS FROM THE E2E SIDE: against a Vercel origin the
 * edge overwrites a client-supplied `x-real-ip`, so a whole Playwright run
 * spends this budget from ONE address no matter what header it stamps. Measured
 * 2026-08-26; the method is above `callerIp()` in `lib/infra/rate-limit.ts` and
 * the consequences are in the header of `playwright.staging.config.ts`.
 *
 * WRITTEN OUT RATHER THAN COMPUTED FROM THE ANCHOR, on purpose. Deriving these
 * two in code would make the fence assert `a === a` and would let someone raise
 * `LOGIN_EMAIL_LIMIT` — a per-account brute-force ceiling — and silently take a
 * twelvefold raise on the per-IP one along with it, meeting no argument on the
 * way. Literals plus a relationship assertion make that edit fail; a formula
 * makes it invisible. Same reason `PASSWORD_RESET_IP_LIMIT` is written out.
 */
export const LOGIN_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 60,
  maxPerHour: 240,
};
