// What a person may spend submitting adoption applications, derived once.
//
// THE BOARD ASKED FOR THIS BY NAME. `dim-interno:docs/agents/open-work.md`'s WU-U row reads
// "The application flow earns its own rate limit here", and the emphasis is on
// FLOW: until now neither door had one. The web action has spent no budget
// since the surface shipped, so the ceiling below is not a native-only control
// bolted onto a native-only endpoint — it lives in the USE-CASE, and the web
// form and the phone spend the same counter. A ceiling that belongs to the
// transport is a ceiling a caller escapes by using the other door.
//
// ===========================================================================
// WHAT THE ACT IS, WHICH IS WHY NO EXISTING FAMILY FITS
// ===========================================================================
// Every write already on `/api/v1` acts on the CALLER'S OWN records: their
// animal's identity, their inbox, their session list, their account. This one
// writes into somebody else's working queue. One submission
//
//   · appends an `adoption_application_submitted` row to the spine,
//   · opens a `case` (or joins an open one),
//   · fans out up to 25 notification rows to the shelter's admins and
//     coordinators — `findOrgMembersForNotify` caps at 25, and that cap IS the
//     write's real cost per request,
//   · and lands a free-text letter about a stranger in a review queue a human
//     has to read.
//
// The last clause is the one no cost model captures and it is what the ceiling
// is really for. The abuse here is not hammering: a duplicate application for
// the SAME pet is refused by `findExistingApplication`, so spamming one animal
// is already impossible. The abuse is BREADTH — one account applying to every
// listed animal in the country, which fills every shelter's queue at once and
// costs each of them the one resource this product cannot give them back, which
// is somebody's attention. A rate limit is the only instrument that touches it.
//
// ===========================================================================
// THE PER-USER ANCHOR: 5/min · 15/hr · 30/day
// ===========================================================================
// PER MINUTE — 5. What a person does here is fill a form: a housing type, a
// prior-pets answer, and a motivation the domain requires be at least thirty
// characters of hand-written Spanish. Nobody produces two of those in a minute.
// The five is not for the person, it is for the RETRIES — a submit on 4G that
// timed out, the tap that did not register, the second attempt after a
// `temporarily_unavailable`. Three would also cover that and five costs nothing:
// the binding window here is the day.
//
// PER HOUR — 15. Somebody browsing the catalogue in one evening and applying to
// the animals that resonate. Three or four is already a lot of letters; fifteen
// is generous for a person and short of a script by an order of magnitude.
//
// PER DAY — 30, AND THIS IS THE ONE THAT BINDS. A carpet-bomb is not bounded by
// its best minute — it is a slow loop, and the hourly window resets 24 times
// while it runs. Thirty applications in a day is not a person choosing a
// companion animal; it is somebody filling queues. The failure mode of being
// refused is a 429 with a `retry-after` on an act that is deliberate and not
// urgent — unlike a lost pet, nothing gets worse while you wait.
//
// TIGHTER THAN EVERY OTHER PER-USER WRITE ON THE SURFACE, on purpose. The
// current floor is `API_V1_MEDIA_UPLOAD_USER_LIMIT` (12/min · 48/hr · 120/day),
// whose docblock calls itself "the tightest per-user WRITE budget on this
// surface" and derives that from ≈15 MB of object-store traffic per photo. This
// one is tighter on all three windows, and the reason is not that it costs us
// more — it costs us less. It is that the resource being spent is not ours.
//
// ===========================================================================
// THE PER-IP CEILING: 60/min · 180/hr
// ===========================================================================
// Twelve simultaneous callers at their own full per-user rate, flat on both
// windows — `API_V1_SIMULTANEOUS_CALLERS`, the same twelve
// `API_V1_ACCOUNT_SECURITY_IP_LIMIT` and `API_V1_INBOX_STATE_IP_LIMIT` use, and
// FLAT for their reason rather than the write family's split one: the per-user
// pair (5/min, 15/hr) is already proportionate, so 12× on both windows preserves
// its shape instead of propagating a deliberate narrowing.
//
// The per-IP bucket's job on this surface is NOT to bound the act — the per-user
// one does that, and carrier NAT cannot dilute it because identities are not
// shared. It is to refuse an unauthenticated hammer before the GoTrue round-trip
// runs. Twelve people behind one carrier gateway submitting adoption
// applications inside the same minute is already a stretch; being refused at the
// thirteenth is a bound, not a shape.
//
// WHAT IT GIVES UP, stated as `lib/infra/api-v1-limits.ts` states it for every
// sibling: the IP bucket runs BEFORE the liveness guard, so 60/min is 60 GoTrue
// round-trips a minute a caller holding a well-formed but invalid token can
// force from one address. That is the lowest exposure of any bucket on the
// surface, which is where it belongs.
//
// ===========================================================================
// WHERE THE PER-IP HALF LIVES
// ===========================================================================
// NOT HERE. `API_V1_ADOPTION_APPLICATION_IP_LIMIT` is in
// `lib/infra/api-v1-limits.ts`, with every other per-IP bucket on the `/api/v1`
// surface, under its own family `adoption-application`. This file keeps the
// PER-USER anchor above, which is the half that actually bounds a person and the
// half both doors share.
//
// IT WAS BRIEFLY HERE AND THAT COST THIS WORK A REJECTION, so the reason it can
// never come back is written down rather than assumed. A route that owns its own
// ceiling literal resolves to the family `route-local`, and
// `__tests__/api-v1-rate-limit-families.test.ts` keeps that family EMPTY on
// purpose — it is what a bucket lands in when nobody derived it, and the fence
// exists so a `pre-cgnat`-shaped pile can never form again. Worse than the red
// itself: the CGNAT aggregate `API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE` is a
// `reduce` over `API_V1_IP_BUCKET_FAMILIES`, so three buckets missing from that
// map made the ceiling a single address may spend under-declare itself by
// 1.260/min while still reading like a computed figure.
//
// The 12× relationship between the two halves is asserted in
// `adoption-application-limits.test.ts` across the module boundary, so raising
// the per-USER ceiling still cannot carry a silent twelvefold raise on the
// per-IP one.

import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/**
 * ONE bucket for both transports, keyed on the applicant.
 *
 * Not `api_v1_…`, for the reason `SUBJECT_DATA_ERASURE_USER_BUCKET` and
 * `REVOKE_SESSIONS_USER_BUCKET` give: a name that says `api_v1` on a call from a
 * web form reads like a different budget, and the whole point is that it is not
 * one.
 */
export const ADOPTION_APPLICATION_USER_BUCKET = "adoption_application_user";

/**
 * The bucket that actually bounds a PERSON, spent inside
 * `submitAdoptionApplication` so the web form and the bearer door share it.
 *
 * Full derivation in the header. The DAY window is the binding one and the only
 * one that touches the abuse this exists for; the two shorter windows are there
 * so a runaway client cannot spend the day's budget in ninety seconds.
 */
export const ADOPTION_APPLICATION_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 5,
  maxPerHour: 15,
  maxPerDay: 30,
};

/**
 * The multiple the per-IP ceiling is derived from — the same twelve
 * `API_V1_SIMULTANEOUS_CALLERS` names, restated here rather than imported so
 * that this file's arithmetic is readable on its own even though the ceiling it
 * produces now lives in `lib/infra/api-v1-limits.ts`.
 *
 * `adoption-application-limits.test.ts` asserts the relationship rather than the
 * digits: a per-USER raise must not silently carry a twelvefold per-IP raise
 * with it, which is `login-limits.ts`'s own reason for keeping both as literals
 * and pinning the product.
 */
export const ADOPTION_APPLICATION_SIMULTANEOUS_CALLERS = 12;

/** The es-AR sentence both surfaces show when the budget is spent. */
export const ADOPTION_APPLICATION_RATE_LIMITED_COPY =
  "Enviaste varias postulaciones seguidas. Esperá un rato y volvé a intentar.";
