// Per-IP and per-user ceilings for the `/api/v1` client surface, derived ONCE.
//
// ===========================================================================
// WHY THIS FILE EXISTS AT ALL
// ===========================================================================
// Until now every `/api/v1` route declared its own `{ maxPerMinute, maxPerHour }`
// literal with its own paragraph justifying it, and eleven of those paragraphs
// said some version of "the same numbers as its siblings, and the same ON
// PURPOSE rather than by copy-paste". That is a good instinct written eleven
// times, and writing it eleven times is what made it wrong: `/me/pets` states
// plainly that its per-IP bucket is broken by carrier NAT and that "re-keying
// the surface buckets is tracked separately (B13) and must move `/me` and this
// endpoint together" — and the only way to honour "together" when the numbers
// live in eleven files is to remember eleven files.
//
// So the numbers move here and the routes name a FAMILY. A route still says
// which family it is in and why, next to its own limiter call, because that is
// the question a reader auditing one URL is asking. What it no longer does is
// re-derive the arithmetic, because the arithmetic is about Argentine carrier
// NAT and not about that route.
//
// This is the same relationship `app/api/v1/pets/[publicToken]/credential/
// limits.ts` and `lib/infra/public-token-throttle.ts` already have: one file
// carries the derivation, the other says which of it applies and moves on.
//
// ===========================================================================
// THE DERIVATION — CARRIER NAT, FOR AN AUTHENTICATED SURFACE
// ===========================================================================
// `credential/limits.ts` did this arithmetic for the ANONYMOUS credential
// surface and its planning figure is 1,000 subscribers per public IPv4 (port
// blocks of 64-128 out of 65,536, before oversubscription). That figure is
// right for that surface and WRONG for this one, and the difference is the
// whole reason this is a separate derivation rather than an import.
//
// On `/p/{token}` any of the thousand subscribers behind a gateway is a
// potential caller: the credential is what a stranger's camera opens, and a
// stranger needs no account. On `/api/v1/me/**` only ACCOUNT HOLDERS are, so
// the number that matters is not subscribers per address, it is
//
//     clients per address = subscribers per address × app adoption
//
// ADOPTION IS A PLANNING NUMBER AND IT IS THE SOFT SPOT IN EVERYTHING BELOW.
// This file uses 10% — 100 app-holding clients behind one carrier gateway — as
// the figure to size against. It is a guess about a product that has not
// launched, it is stated here instead of buried in the result, and it is the
// FIRST thing to re-derive when there is real telemetry: the load probe
// (`scripts/load-probe-api-v1.ts`) exists partly so that day produces a
// measurement rather than another guess. If adoption reaches 50%, every figure
// below is 5× too small and this paragraph is where that gets noticed.
//
// ---------------------------------------------------------------------------
// AUTHENTICATED READS, per IP: 60/min → 600/min, 600/hr → 6,000/hr
// ---------------------------------------------------------------------------
// LEGITIMATE LOAD, HOURLY. 100 app-holders behind one gateway, each opening the
// app ~6 times in a busy hour (cold launch, two foregrounds, a pull-to-refresh,
// a push they tapped) = 600 calls/hr on `/me` and another 600 on `/me/pets`,
// because a cold launch fans out to both. The OLD hourly ceiling was 600. That
// gateway was refused at exactly 100% of the modelled peak — not over it, AT
// it, during ordinary use, with nobody doing anything wrong. 6,000/hr puts the
// same hour at 10% of budget, which is the headroom `credential/limits.ts`
// settled on for the same reason.
//
// LEGITIMATE LOAD, PER MINUTE — the one that actually broke. A push broadcast
// is the burst case and it is a case this product will deliberately create: a
// jurisdiction announcing a vaccination campaign, or a lost-pet alert fanned
// out to a barrio. If half a gateway's app-holders open within the same sixty
// seconds, that is 50 cold launches = 50 calls on each read endpoint, against
// an OLD ceiling of 60 — 17% headroom before anything else those hundred people
// are doing, and every 429 lands on a client that cannot render its shell at all
// and will retry, which is how 50 becomes 60. 600/min gives ×12 on that peak.
//
// WHAT THE CEILING GIVES UP, stated rather than hidden. The per-IP bucket on
// these routes runs BEFORE the GoTrue round-trip — that is its job, and
// `/me/pets` says so. At 600/min one address can force 600 `auth.getUser()`
// round-trips a minute, ten times what it could before. Three things bound
// that, and none of them is the IP bucket:
//
//   1. A request with no parseable `Authorization` header never reaches the
//      limiter at all. `createClientFromBearer` is a regex over one header and
//      it runs first, deliberately, in every one of these handlers.
//   2. A caller with a VALID token is bounded per-account by the user bucket
//      below, which carrier NAT cannot dilute because a user id is not shared.
//   3. A caller with an invalid token can spend the IP budget on GoTrue
//      round-trips. 600/min is 10 req/s sustained from one address — a load one
//      IP can produce against any endpoint we have, and the layer that stops it
//      is the platform's DDoS layer, not a Postgres counter. That is the same
//      conclusion `credential/limits.ts` reached, and it is not stronger here
//      just because this endpoint costs more per request.
//
// (3) is a real cost and it is the reason this family does NOT simply take the
// credential surface's numbers on the grounds that they are the same shape.
// They land on the same numbers; they land there by different arithmetic.
//
// ---------------------------------------------------------------------------
// AUTHENTICATED READS, per user: 120/min + 1,200/hr — UNCHANGED, and promoted
// ---------------------------------------------------------------------------
// Four of this family's five routes already had exactly these numbers. What
// changes is that `/api/v1/me` — the one endpoint every native client calls
// first, on every cold launch — did NOT, and had no per-user bucket at all.
// After this file that gap is visible instead of implicit: a route in the
// authenticated-read family spends both budgets or it is not in the family.
//
// This is the bucket that actually bounds a PERSON. It is immune to the
// arithmetic above for a structural reason rather than a lucky one: carrier NAT
// shares addresses, not identities, so 120/min means 120/min no matter how many
// neighbours a caller has. A person cannot open a list screen 120 times in a
// minute; a script signed in as them can, and this is what stops it costing 120
// pooler round-trips a minute.
//
// ---------------------------------------------------------------------------
// AUTHENTICATED WRITES, per IP: 20/min → 120/min, 120/hr → 1,200/hr
// ---------------------------------------------------------------------------
// NOT the read family's 10×, and not scaled by the adoption figure either. This
// one is derived from a constant this repo already committed to, which makes it
// the sturdiest number in the file.
//
// The per-USER write ceiling is 10/min (below, unchanged). At an IP ceiling of
// 20/min, TWO people at their own individual ceiling exhaust the whole
// gateway's budget — which means the bucket that refuses the third legitimate
// writer is the IP one, and the IP one is the bucket with no reasoning behind
// its number for this case. That is upside down. The per-user ceiling is where
// the thinking is ("ten a minute is generous headroom for a person answering a
// backlog of proposals plus every retry a flaky connection produces"), so the
// IP ceiling's job is to stay far enough above it that the USER bucket is the
// binding constraint for any plausible number of simultaneous legitimate
// writers behind one address.
//
// 120/min is exactly 12 accounts at their full per-user rate. 1,200/hr is 30
// accounts at their full 40/hr. Twelve people behind one carrier gateway all
// answering transfer proposals inside the same minute is already an implausible
// hour; being refused at the thirteenth is a bound, not a shape.
//
// WHAT IT GIVES UP. The same thing the read family gives up, at a fifth of the
// magnitude: the IP bucket on both write routes runs BEFORE the liveness guard,
// so 120/min is 120 GoTrue round-trips a minute an unauthenticated caller with a
// well-formed but invalid token can force from one address.
//
// The tempting sentence here is "write budgets are only spent by authenticated
// callers, so this is cheaper than it looks". It is false — the ordering in
// `me/transfers/route.ts` and `me/caretaker-grants/route.ts` is IP bucket, then
// guard, then user bucket — and it is written out because it is the kind of
// false sentence that makes a number look safer than it is and never gets
// checked afterwards.
//
// ---------------------------------------------------------------------------
// ACCOUNT SECURITY, per IP: 30/min → 60/min, 120/hr → 240/hr
// ---------------------------------------------------------------------------
// `/me/revoke-sessions` gets its OWN family and a modest raise, against a
// written argument in that file that this endpoint should NOT be CGNAT-scaled:
// "it is a rare, deliberate act, and 30/min leaves room for a whole office to
// use it in the same minute."
//
// The premise is right and the model is wrong in a specific, familiar way. A
// WHOLE OFFICE is a shared corporate address; this endpoint's caller is a
// phone, and B13's entire finding was that a limiter sized against an office is
// sized against the wrong caller (that is what `atender_lookup`'s numbers did to
// the credential endpoint). And the scenario that matters is not the average
// day: it is a breach advisory — a jurisdiction, or this project, telling people
// to sign out everywhere at once. Behind one carrier gateway, an OLD ceiling of
// 120/hr refused the 121st person doing exactly what they were just told to do,
// on the one endpoint whose failure mode is "you cannot sign out of the phone
// you lost".
//
// So it moves, and it moves by the WRITE family's rule rather than the read
// family's: the per-user ceiling inside the use-case is 5/min + 20/hr
// (`REVOKE_SESSIONS_USER_BUCKET`), and 12× that is 60/min + 240/hr. Same
// multiple, same reason — the user bucket stays the binding constraint. It
// remains an order of magnitude below the read family because the act really is
// rare, which is the half of the original argument that survives.
//
// ---------------------------------------------------------------------------
// INBOX STATE, per IP: 240/min + 2,400/hr — A NEW FAMILY (WU-Q-1)
// ---------------------------------------------------------------------------
// `POST /me/notifications` marks rows read and archives them. It is a WRITE and
// it is deliberately NOT in the authenticated-write family, for the reason
// `/me/revoke-sessions` is not: that family's numbers are derived from a
// particular kind of act, and this is not that act.
//
// Read `me/transfers/route.ts`'s own note on what its ceiling is sized against:
// "offering an animal to somebody is not [something an owner does in bursts] …
// What this write PRODUCES is not a row — it is a change of who owns an animal
// in the national registry." Ten a minute is generous for THAT. It is absurd for
// an inbox: a person clearing a backlog of notifications taps as fast as they can
// read, and the eleventh tap in a minute would be refused on the one screen whose
// entire purpose is to be tapped through. The web has no limiter on these writes
// at all (they are server actions), so a ceiling that binds here makes the phone
// strictly worse than the browser at the thing both are for.
//
// WHAT THE WRITE ACTUALLY COSTS, which is the honest basis for a number: one
// indexed UPDATE on `notifications` scoped to `user_id`, touching `read_at` or
// `archived_at`. No transaction spanning four tables, no e-mail, no notification
// fan-out, no ownership change — see `@dim/contract/input`'s `notification.ts`
// for why a read receipt is neither a spine fact nor a cache. It is the cheapest
// authenticated write on this surface by an order of magnitude.
//
// PER USER: 20/min + 200/hr, and the shape of the command is half the derivation.
// `mark_read` takes a LIST (up to one page), so "clear everything I can see" is
// ONE call and not a hundred; what remains per-tap is `archive`, which is
// singular on purpose because it has no undo. Twenty a minute is faster than
// anybody archives deliberately, and 200/hr is a whole inbox emptied twice with
// room over.
//
// PER IP: 12× both windows — 240/min and 2,400/hr. The multiple is
// `/me/revoke-sessions`'s FLAT one rather than the write family's split one, and
// the reason is the same as there: the per-user pair (20/min, 200/hr) is already
// proportionate, so scaling both by the same factor preserves the shape.
// Twelve accounts behind one carrier gateway all clearing notifications inside
// the same minute is already a stretch; being refused at the thirteenth is a
// bound rather than a shape.
//
// WHAT IT GIVES UP, stated as its siblings state it: the IP bucket runs BEFORE
// the liveness guard, so 240/min is 240 GoTrue round-trips a minute an
// unauthenticated caller with a well-formed but invalid token can force from one
// address. That is twice the write family's exposure and a twentieth of the read
// family's, which is the right place for it — this endpoint is cheaper per
// request than either.
//
// ---------------------------------------------------------------------------
// PUBLIC REFERENCE, per IP: 60/min → 600/min, 600/hr → 6,000/hr
// ---------------------------------------------------------------------------
// `/api/v1/localities` is the only route here with NO identity to key on, so
// per-IP is not the cheap pre-auth check in front of a better bucket — it is
// the only bucket there is. That makes carrier NAT bite harder, not softer.
//
// The burst case is concrete and it is one the product wants: a municipality
// running a registration drive in a plaza, twenty people registering a pet at
// once on the same cell. A typeahead debounced at 250 ms produces ~1 req/s per
// person while they are actually typing a locality name, so twenty people
// typing an address at the same moment is ~20 req/s = well past an OLD ceiling
// of 60/min, and the route's own comment says what that costs: "a false throttle
// here costs a pet its credential".
//
// WHAT IT GIVES UP, checked rather than asserted. Two candidate costs:
//
//   SCRAPING — not a cost, and it never was. The route already states the
//   arithmetic: the catalogue is 4.141 rows of published INDEC reference data,
//   and 600/hr × 20 rows already handed it over in half an hour. 6,000/hr makes
//   an already-free thing free faster. The limiter never was an obtainability
//   control and this file must not start pretending it is one.
//
//   THE POOLER — the real one. This query is a sequential scan: the route's own
//   comment records that the `pg_trgm` GIN index from migration 0019 is on
//   `locality_name` while the predicate is a `LIKE` on `locality_slug`, so the
//   index does not apply. 600/min is 10 req/s of seq scans over ~4.141 rows,
//   which is a few hundred KB resident in shared buffers and low single-digit
//   milliseconds each — so concurrency stays near 1 and the pooler is not the
//   thing that breaks. That conclusion depends on the TABLE SIZE, which is the
//   one number here that will change: it is a national locality catalogue, and
//   if it ever grows by an order of magnitude the honest fix is the missing
//   index on `locality_slug`, not a smaller ceiling on the endpoint standing
//   between a citizen and a registration.
//
// A SECOND, NARROWER BUCKET: CONSIDERED, REJECTED. The credential endpoint pairs
// its surface bucket with a per-lookup one keyed `${token}:${ip}`. The analogue
// here would be `${query}:${ip}` — and it would never bind, because a typeahead
// varies the query on every keystroke BY DESIGN. A counter whose key the
// legitimate caller changes faster than the abusive one is not a limiter, it is
// write amplification with a rationale.
//
// ===========================================================================
// THE TEN UNDER `pets/**` THE FIRST PASS LEFT BEHIND — CLOSED 2026-08-27
// ===========================================================================
// WU-EAS-2's scope was `app/api/v1/me/**` and `app/api/v1/localities/**`, so ten
// sibling per-IP buckets under `app/api/v1/pets/**` stayed on their pre-B13
// numbers. This section used to be the paragraph that admitted it:
//
//   "a native client that cold-launches (600/min on `/me` and `/me/pets`) and
//    then taps a pet lands on 60/min at `/pets/{token}`, from the same phone,
//    behind the same gateway, one screen later. That is a REAL inconsistency and
//    this paragraph is not an apology for it."
//
// On 2026-08-27 the Android build reached Play internal testing and real testers
// began installing it on Argentine carrier networks — the same day and the same
// trigger that moved `login-limits.ts`. That turned a documented gap into a live
// one, because the burst the 600 was sized for does not stop at the home screen:
// a barrio-wide lost-pet alert puts fifty people behind one carrier gateway into
// the app at once, and what they do next is TAP THE PET. The 60 was there.
//
// So the ten move here. It is NOT one derivation, and making it one is the
// mistake this whole file exists to refuse.
//
// WHAT IS TRUE OF ALL TEN — read out of the handlers, not assumed
// ---------------------------------------------------------------------------
// FIRST, NONE OF THEM IS PUBLIC. That is worth stating because a public bucket's
// derivation is not this one — `credential/limits.ts` sizes against 1,000
// SUBSCRIBERS per address precisely because a stranger with a camera needs no
// account. Every one of the ten sits in a handler that calls
// `createClientFromBearer` and then `requireLiveUser`, and nine of the ten then
// call `resolvePetHolderAccess` (registration cannot: the pet does not exist
// yet). The anonymous credential surface is a DIFFERENT route with its own file
// and its own arithmetic, and it was raised in B13 — it never was one of the ten.
// So the population is this file's: app-holding clients behind a gateway.
//
// SECOND, THE ORDERING IS UNIFORM, and it is what each raise below costs. In all
// ten handlers the sequence is: header regexes (free) → the per-IP bucket → the
// GoTrue round-trip → the per-user bucket → the DB access guard. NO ROUTE READS
// THE DATABASE BEFORE AUTHENTICATING, so no raise here widens an unauthenticated
// read of anything. What every raise buys a caller holding a well-formed but
// invalid token is more `auth.getUser()` round-trips from one address — the same
// cost, in the same words, this file already accepts at 600 for the read family,
// bounded by the same three things and by the platform's DDoS layer. One of the
// ten claims a second job beyond that; it is named and re-checked below.
//
// ---------------------------------------------------------------------------
// THE FIVE READS: they were `/me/pets`'s numbers all along
// ---------------------------------------------------------------------------
// `api_v1_pet_detail_ip`, `api_v1_pet_libreta_ip`, `api_v1_pet_event_detail_ip`,
// `api_v1_shares_read_ip`, `api_v1_lost_read_ip` — all five ran 60/min + 600/hr
// per IP and 120/min + 1,200/hr per user, byte-identical to what `/me/pets` ran
// before WU-EAS-2 moved it, and their own docblocks SAID SO: "identical ON
// PURPOSE rather than by copy-paste: a client that opens a list and then taps
// into a pet calls both at the same moments, so one number bounds both and a
// client author has one budget to reason about."
//
// There is no second derivation to do. The five are the authenticated-read family
// and always were; what happened is that the family moved without them. They take
// `API_V1_AUTHENTICATED_READ_IP_LIMIT` and `API_V1_AUTHENTICATED_READ_USER_LIMIT`
// — and the per-user half is not a change of value at all. It is the same pair,
// stated once instead of five times, so the next time the family moves it cannot
// leave them behind again. That is the entire point of the file.
//
// ---------------------------------------------------------------------------
// THE FIVE WRITES: one RULE, three anchors, and therefore not one number
// ---------------------------------------------------------------------------
// The writes do not share a per-user ceiling, and a per-IP ceiling in this file is
// derived FROM the per-user one. Handing all five the authenticated-write family's
// 120/min because they are the same SHAPE is exactly what `credential/limits.ts`
// refuses to do with its own numbers ("they land on the same numbers; they land
// there by different arithmetic"), so it is not done here either.
//
// The rule is the one `login-limits.ts` names and `API_V1_ACCOUNT_SECURITY_IP_LIMIT`
// and `API_V1_INBOX_STATE_IP_LIMIT` already follow: TWELVE simultaneous legitimate
// callers at their own full per-user ceiling, on both windows. Every one of the
// five is upside down without it — the IP bucket, the one with no reasoning behind
// its number, is what refuses the second or third legitimate writer behind a
// gateway:
//
//   api_v1_amend_ip          20/min against 10/min per user — TWO people
//   api_v1_shares_write_ip   20/min against 15/min per user — ONE and a third
//   api_v1_lost_write_ip     20/min against 15/min per user — ONE and a third
//   api_v1_event_ip          30/min against 20/min per user — ONE and a half
//   api_v1_pets_register_ip  30/min against 10/min per user — THREE people
//
// AMEND JOINS THE AUTHENTICATED-WRITE FAMILY rather than getting a constant of its
// own. Its per-user ceiling is 10/min + 40/hr + 100/day, which is not merely close
// to `API_V1_AUTHENTICATED_WRITE_USER_LIMIT` — it is the same three numbers — and
// the act is the same class: a deliberate, consequential correction to the
// national registry's append-only spine, the way a transfer is a deliberate change
// of who owns an animal. Same anchor and same act is the same family. A separate
// constant carrying identical numbers would be the eleven-paragraphs problem from
// the top of this file, once more.
//
// SHARES AND LOST WRITES SHARE ONE — `API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT`, and
// they share it for the reason amend joins an existing family rather than for the
// reason they are both writes. Same per-user anchor (15/min + 60/hr + 200/day),
// and two docblocks describing the same act in nearly the same words: an owner
// "flipping disclosure toggles while they think about what they are comfortable
// publishing", in a waiting room or in the middle of a search. Both change what
// OTHER people may see of one animal — one mints a bearer credential over a
// medical record, the other broadcasts a search to every organization in a
// jurisdiction. Twelve such callers behind one gateway is 180/min + 720/hr.
//
// RECORDING AN ASIENTO GETS ITS OWN — `API_V1_PET_RECORD_WRITE_IP_LIMIT`, from an
// anchor of 20/min + 80/hr + 300/day, the widest per-user write budget on the
// surface. Its route already says why the anchor is wide, and the sentence is the
// whole derivation: "recording is the ORDINARY act on this surface and correcting
// is the exceptional one, and a vet day at a rescue is many animals from one
// egress in one afternoon." Twelve of those is 240/min + 960/hr — the same
// per-minute figure as `inbox-state`, and deliberately NOT that constant. An
// asiento is a row on the spine; a read receipt is not. Two families that happen
// to meet at a number must not be merged on the strength of the coincidence.
//
// REGISTRATION GETS ITS OWN — `API_V1_PET_REGISTRATION_IP_LIMIT`, from 10/min +
// 30/hr + 60/day: 120/min + 360/hr. This is the one whose old ceiling claimed a
// derivation it did not have. Its docblock read "Sized for CGNAT, not for a
// household. Mobile carriers put hundreds of subscribers behind one address" —
// above 30/min + 120/hr, which is FOUR accounts per gateway per hour at their own
// 30/hr. And the burst is not hypothetical: `/api/v1/localities` was raised to
// 600/min in this very file for "a municipality running a registration drive in a
// plaza, twenty people registering a pet at once on the same cell". The typeahead
// was made to survive that drive while the registration it feeds was left at a
// ceiling the drive exhausts inside an hour. That is a SECOND cliff, sharper than
// the one this section was written about, and the same change closes it.
//
// WHAT THE REGISTRATION RAISE GIVES UP, which is less than it looks and is the
// one place the uniform GoTrue answer above is not the whole answer. Alone among
// the ten, this bucket claims a second job: it is "here to bound a SCRIPTED farm
// running from one host, which the per-user budget below structurally cannot see
// (a farm makes an account per pet)". That is true, and the binding constraint on
// that farm is not this ceiling. A farm needs one ACCOUNT per pet, and accounts
// come from `auth_signup_ip`. The ceiling doing that work is upstream of this one
// and far tighter; this one was only ever the second-tightest link, and it still
// is.
//
// THE MULTIPLE THIS PARAGRAPH USED TO QUOTE IS GONE, and how it went is the
// useful part. It read "3/min + 15/hr, deliberately unchanged … fifteen accounts
// an hour from one host caps the farm at fifteen pets an hour … eight times
// tighter" — an HOURLY comparison, which was the only kind available while every
// auth bucket had only short windows. `signup-limits.ts` re-derived that bucket on
// 2026-08-29 and the comparison moved a window down, because a pet farm is not
// bounded by its best hour:
//
//   signup       60/min + 180/hr + 360/DAY   → 360 accounts/day per address
//   this bucket  120/min + 360/hr, no day    → 8,640 pets/day per address
//
// SAID COMPLETELY, BECAUSE ONE WINDOW FLATTERS AND TWO DO NOT. Signup against
// this bucket, before → after:
//
//   per minute    3 vs 120  = 40× tighter  →   60 vs 120  =  2× tighter
//   per hour     15 vs 360  = 24× tighter  →  180 vs 360  =  2× tighter
//   per day     360 vs 8640 = 24× tighter  →  360 vs 8640 = 24× tighter
//
// So the margin COLLAPSED to 2× on both short windows and held at 24× only on
// the day. Quoting "24× instead of 8×" and stopping — which an earlier draft of
// this paragraph did — picks the one window that improved. The conclusion still
// holds, on the ground this section always stood on: a farm needs an account per
// pet and is bounded by its daily yield, not by its best minute, and signup binds
// it at 360 pets a day — the SAME 360 the old 15/hr yielded across 24 hours. What
// a reader must not carry away is short-window headroom: there is now 2× of it.
//
// ---------------------------------------------------------------------------
// WHAT `route-local` MEANS NOW, AND WHY IT IS EMPTY
// ---------------------------------------------------------------------------
// The family the ten used to be in was called `pre-cgnat`: "knowingly left on the
// pre-B13 ceiling by WU-EAS-2's scope". Nothing is left on one, so that name now
// describes an empty set — a comment standing for a condition nothing satisfies,
// which is the exact defect `public-token-throttle.ts` records and this file keeps
// re-learning. It is renamed `route-local`, which names the MECHANISM instead of a
// moment: a bucket whose route hands the limiter its own literal rather than one
// of this file's constants. That is what
// `__tests__/api-v1-rate-limit-families.test.ts` infers from a call site, so it is
// what the family has to mean.
//
// It is EMPTY, and the fence asserts that it stays empty. A per-IP bucket that
// lands with its own literal fails there, and the fix is a family and a derivation
// in this file — not an entry in the map. The escape hatch is closed because these
// ten are what it cost: a route can be filed under "somebody decided" and still be
// a route nobody ever re-derived.
//
// The aggregate per-IP per-minute ceiling across the CGNAT-derived families is
// `API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE`, computed below — and since the ten
// landed it is the ceiling across the WHOLE `/api/v1` per-IP surface, because
// there is no longer a set of buckets sitting outside it. IT USED TO BE
// TRANSCRIBED HERE TOO ("and is 3,300/min") and that sentence went stale the
// first time a route landed: WU-Q-1 added two buckets and the figure moved,
// while the prose went on stating the old one in the very paragraph that exists
// to state it honestly — which is §1.1 of docs/architecture/api-invariants.md
// happening again, one line lower. So the number is named and not repeated. Read
// the constant.
//
// ---------------------------------------------------------------------------
// AND THE ROUTES THAT ARE IN NO FAMILY AT ALL, WHICH IS ALSO A DECISION
// ---------------------------------------------------------------------------
// `app/api/v1/auth/**` spends no `api_v1_*` bucket, so the map below names none
// of it and the fence collects none of it. That reads like a hole and is the
// opposite of one: those handlers are adapters over use-cases the WEB FORMS also
// call, and the ceilings they spend (`auth_login_ip`, `auth_login_email`,
// `auth_signup_ip`, `auth_password_reset_ip`, `auth_password_reset_email`) are
// named for the ACT rather than for the surface, precisely so that switching
// transport buys no fresh budget. A ceiling filed under a `/api/v1` family would
// be a ceiling only one of the two doors spends.
//
// A reader auditing one of those URLs should follow the use-case, not this file.
// The password-reset pair carries its own derivation next to the use-case
// (`src/modules/auth/application/password-reset/limits.ts`) and so does the login
// pair (`login-limits.ts`, re-derived 2026-08-27 when the Android app reached
// Play and logins started arriving from carrier NAT — its per-IP ceiling had the
// same upside-down shape the authenticated-write family above is corrected for,
// and it uses the same twelve). `auth_signup_ip` used to be the one still stated
// as a literal at its own `enforceRateLimit` call site; it got its own file on
// 2026-08-29 (`signup-limits.ts`), so every ceiling in the `auth_*` FAMILY now
// carries a derivation in a file beside its use-case.
//
// THAT SCOPE IS THE WHOLE CLAIM, and it is worth saying why it is written so
// narrowly. The first draft of this sentence read "and no per-IP ceiling in this
// repo is an inline literal any more" — false, and false three lines below the
// paragraph above about a sentence that went stale precisely by being absolute.
// The second draft then replaced it with a list of seven, which was the SAME
// defect wearing a number: a hand-made list reads as an inventory whether or not
// it is one, and that one was not. There are at least TWELVE per-IP ceilings
// outside `/api/v1` and outside `auth_*` still stated as literals at their call
// sites — `org_contact_ip`, `tag_activate_ip`, `case_detail_public`,
// `denuncia_seguimiento` and `welfare_anon` among them — plus half a dozen more
// whose key concatenates the address with a token or an org id, which rotate away
// with the address just the same.
//
// TWELVE IS A FLOOR MEASURED BY HAND ON 2026-08-29, NOT A COUNT THIS FILE OWNS.
// Nothing generates it: the classification is "read the second argument of every
// `enforceRateLimit` call and decide whether it is an address", and no fence does
// that. Recount it before quoting it —
//
//   rg -n --glob '!node_modules' --glob '!*.test.*' 'enforceRateLimit\(' -A3
//
// — and read the key. Two absolutes about this exact set have now gone stale in
// this exact paragraph, so the third statement is deliberately not one: the point
// that survives re-counting is that MANY public-route per-IP ceilings are still
// underived literals, not any particular number of them. None was re-derived on
// 2026-08-29 and none is this file's surface. The auth family is what got closed;
// the public-route ones are open.
//
// THAT ONE DOES NOT USE THE TWELVE, and it is the exception worth knowing about
// before reaching for this file's shape a fourth time. Every PER-USER-ANCHORED
// derivation here multiplies a per-IDENTITY ceiling — the qualifier
// `API_V1_SIMULTANEOUS_CALLERS` uses about itself, and a third absolute in this
// same file went stale on 2026-08-29 for dropping it, since
// `API_V1_PUBLIC_REFERENCE_IP_LIMIT` and `API_V1_ACCOUNT_SECURITY_IP_LIMIT` have
// no per-user pair to multiply either. Signup has none to multiply because it is
// what CREATES the identity, so a per-email counter there reads 1 for a citizen
// and 1 for a farm. It is anchored instead on a plaza registration drive — the
// same twenty people `API_V1_PUBLIC_REFERENCE_IP_LIMIT` and
// `API_V1_PET_REGISTRATION_IP_LIMIT` are already sized against — and bounded by a
// per-DAY window rather than by a multiple.
//
// THIS PARAGRAPH USED TO CARRY A CAVEAT and the caveat is now gone, which is the
// most useful thing about it. It said the `pre-cgnat` buckets sat outside the sum
// and added their own ceilings on top, deliberately not totalled "because these
// are exactly the routes nobody re-derived, so a figure standing for them would be
// an arithmetic claim about numbers this file does not own". They are this file's
// numbers now. The sum below covers every per-IP bucket the surface spends, and a
// reader no longer has to add an untotalled remainder to it in their head.

import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/**
 * Authenticated reads, per IP. Full derivation in the header — 100 app-holding
 * clients per carrier gateway, sized against a push-broadcast burst.
 *
 * `/api/v1/me`, `/me/pets`, `/me/transfers` (GET), `/me/caretaker-grants` (GET).
 */
export const API_V1_AUTHENTICATED_READ_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 600,
  maxPerHour: 6_000,
};

/**
 * Authenticated reads, per user — the bucket that bounds a PERSON, and the one
 * carrier NAT cannot dilute because identities are not shared.
 *
 * Unchanged from the four routes that already had it; `/api/v1/me` gains it.
 */
export const API_V1_AUTHENTICATED_READ_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 120,
  maxPerHour: 1_200,
};

/**
 * Authenticated writes, per IP. Derived from `…WRITE_USER_LIMIT` below rather
 * than from the adoption figure — see the header — so that the USER bucket stays
 * the binding constraint for any plausible number of simultaneous legitimate
 * writers behind one address.
 *
 * THE MULTIPLE IS NOT ONE NUMBER, and this docblock claimed it was until
 * 2026-08-26 ("12× the per-user ceiling", flat). Per minute that is right;
 * per hour it is not, and the header has always told the honest story while this
 * summary rounded it into a single factor:
 *
 *   per minute   120 = 12 × 10      twelve accounts at their full per-minute rate
 *   per hour   1,200 = 30 × 40      thirty accounts at their full hourly rate
 *
 * The two multiples differ because the per-user ceiling is not a flat rate
 * either: 10/min would be 600/hr if sustained, and the per-user hourly cap of
 * 40 is deliberately far below that. So the same IP ceiling admits twelve
 * simultaneous writers in a burst and thirty across an hour, which is the shape
 * intended — a gateway is bursty in the minute and broad in the hour.
 *
 * The CONSTANTS were never wrong; only this derivation was, and a wrong
 * derivation is worse than none, because it is the sentence somebody uses to
 * re-derive the number after changing the per-user one.
 * `__tests__/api-v1-rate-limit-families.test.ts` pins the per-minute half.
 *
 * `/me/transfers` (POST), `/me/caretaker-grants` (POST).
 */
export const API_V1_AUTHENTICATED_WRITE_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 120,
  maxPerHour: 1_200,
};

/**
 * Authenticated writes, per user — UNCHANGED, and the anchor the IP ceiling is
 * derived from. Both `/me` write routes already ran exactly these numbers with
 * their reasoning written out; it is repeated in neither place and lives in the
 * header.
 */
export const API_V1_AUTHENTICATED_WRITE_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 10,
  maxPerHour: 40,
  maxPerDay: 100,
};

/**
 * Account-security writes, per IP. `/me/revoke-sessions`, the `/me/privacy`
 * write and `/me/reactivate` (D4, whose per-user half is
 * `API_V1_ACCOUNT_SECURITY_USER_LIMIT` below). Derived for the first: 12× its
 * use-case's per-user ceiling (5/min + 20/hr) — 60 = 12 × 5 and 240 = 12 × 20,
 * flat on both windows — and an order of magnitude below the read family
 * because the act really is rare.
 *
 * IT IS FLAT HERE AND NOT IN THE WRITE FAMILY ABOVE, which is worth one line so
 * that "by the write family's rule" is not read as "the same multiple". That
 * family's per-user ceilings are 10/min and 40/hr, a pair chosen so the hourly
 * one is far below a sustained per-minute rate; multiplying both by 12 would
 * have carried that deliberate narrowing up into the IP ceiling, so the hourly
 * side went to 1,200 (= 30 × 40) instead. Here the per-user pair is already
 * proportionate, so 12× on both windows preserves it.
 *
 * The per-user half is NOT here — it lives inside `revokeAllSessions` so the web
 * button and this endpoint spend the same budget. A ceiling that belongs to the
 * transport is a ceiling a caller escapes by using the other door.
 */
export const API_V1_ACCOUNT_SECURITY_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 60,
  maxPerHour: 240,
};

/**
 * Account-security writes, per user — for the ONE member of the family whose
 * per-user half lives at the route: `POST /me/reactivate` (D4).
 *
 * THE SAME NUMBERS AS `REVOKE_SESSIONS_USER_LIMIT` (5/min · 20/hr · 40/day), so
 * the family has one per-user anchor and the IP ceiling above is 12× it on both
 * windows for every route in it. `revokeAllSessions` keeps its own copy inside
 * the use-case; this one is here because the reactivation use-case is the WEB's
 * (`selfReactivatePersonalAccountForUser`, reached from /cuenta), reused
 * unchanged, and it holds no limiter of its own.
 *
 * WHY THE ROUTE AND NOT THE USE-CASE, given that `revoke-sessions.ts` records
 * the lesson "a ceiling that belongs to the transport is a ceiling a caller
 * escapes by using the other door". That lesson is about a control whose abuse
 * is the act itself (a stolen token signing somebody out, repeatedly). A
 * reactivation is bounded by construction: the first success makes every later
 * call a no-op, so the only thing a flood of them can buy is counter writes —
 * which is what the per-IP half bounds before authentication. Moving a limiter
 * into the web's use-case would change the web's behaviour (and its fail
 * direction) in a change whose brief is to reuse it as-is.
 *
 * FAILS CLOSED at the route, unlike `revoke-sessions`: refusing a reactivation
 * for a few seconds costs the person nothing irreversible, while the endpoint is
 * the one door on this surface that deliberately runs for an account
 * `requireLiveUser` refuses.
 */
export const API_V1_ACCOUNT_SECURITY_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 5,
  maxPerHour: 20,
  maxPerDay: 40,
};

/**
 * Inbox-state writes, per IP. `POST /me/notifications` only: 12× its per-user
 * ceiling on both windows — 240 = 12 × 20 and 2,400 = 12 × 200 — and derived from
 * what the write COSTS (one indexed UPDATE on the caller's own rows) rather than
 * from what a transfer costs. Full argument in the header.
 */
export const API_V1_INBOX_STATE_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 240,
  maxPerHour: 2_400,
};

/**
 * Inbox-state writes, per user — the anchor the IP ceiling above is derived from,
 * and the bucket that actually bounds a PERSON.
 *
 * IT IS TWICE THE AUTHENTICATED-WRITE FAMILY'S PER-MINUTE CEILING AND FIVE TIMES
 * ITS HOURLY ONE, which is the point rather than an oversight: the act is
 * clearing an inbox, not handing over an animal. See the header, and see
 * `@dim/contract/input`'s `notification.ts` for why `mark_read` batches — that
 * batching is what makes 20/min the ceiling for a hundred-row screen instead of
 * the ceiling for five taps.
 *
 * NO DAILY FIGURE, unlike the write family's. That one exists as an abuse
 * backstop because each transfer initiation sends mail to an address it names;
 * nothing here leaves the caller's own rows, so a daily cap would bound only how
 * much of their own inbox somebody may read.
 */
export const API_V1_INBOX_STATE_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 20,
  maxPerHour: 200,
};

/**
 * Public reference reads, per IP. `/api/v1/localities` only, and the only route
 * in this file with no identity to fall back on — which is why it takes the
 * read family's ceiling rather than something tighter.
 */
export const API_V1_PUBLIC_REFERENCE_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 600,
  maxPerHour: 6_000,
};

/**
 * How many simultaneous legitimate callers behind ONE carrier gateway every
 * per-user-anchored family in this file is sized for.
 *
 * NAMED RATHER THAN TRANSCRIBED, the way `LOGIN_SIMULTANEOUS_CALLERS` is in
 * `src/modules/auth/application/login-limits.ts`. It is the same twelve, chosen
 * for the same reason in `API_V1_ACCOUNT_SECURITY_IP_LIMIT`,
 * `API_V1_INBOX_STATE_IP_LIMIT` and `PASSWORD_RESET_IP_LIMIT`: far enough above
 * the per-user ceiling that the USER bucket is the binding constraint for any
 * plausible crowd behind one address, and low enough that the IP bucket is still
 * a bound.
 *
 * THE CONSTANTS BELOW ARE STILL WRITTEN OUT AS LITERALS, and `login-limits.ts`
 * gives the reason not to compute them from their anchors: a formula would make
 * the fence assert `a === a`, and would let somebody raise a per-USER ceiling —
 * the bucket that bounds a person — and take a twelvefold raise on the per-IP one
 * along with it without meeting a single argument. Literals plus a relationship
 * assertion make that edit fail loudly.
 */
export const API_V1_SIMULTANEOUS_CALLERS = 12;

/**
 * Pet-disclosure writes, per IP. `POST /pets/{token}/shares` and
 * `POST /pets/{token}/lost` — 12× their shared per-user anchor on both windows.
 *
 * ONE CONSTANT FOR TWO ROUTES BECAUSE THEY SHARE AN ANCHOR, not because they are
 * both writes. Full argument in the header; the short version is that both writes
 * change what other people may see of one animal, and both routes describe the
 * same owner doing the same thing — flipping disclosure toggles mid-situation.
 */
export const API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 180,
  maxPerHour: 720,
};

/**
 * Pet-disclosure writes, per user — the anchor the ceiling above is derived from,
 * and the bucket that bounds a PERSON.
 *
 * Byte-identical in both routes before it moved here, and moved for the reason
 * everything else in this file moved: a ceiling that must stay in step with a
 * sibling cannot live as a literal beside one of the two siblings.
 */
export const API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 15,
  maxPerHour: 60,
  maxPerDay: 200,
};

/**
 * Spine-record writes, per IP. `POST /pets/{token}/events` only — 12× its
 * per-user anchor on both windows.
 *
 * NUMERICALLY THE SAME PER-MINUTE FIGURE AS `API_V1_INBOX_STATE_IP_LIMIT` and
 * deliberately not that constant. Recording an asiento appends to the append-only
 * spine; marking a notification read touches the caller's own row. Two families
 * that meet at a number are still two families.
 */
export const API_V1_PET_RECORD_WRITE_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 240,
  maxPerHour: 960,
};

/**
 * Spine-record writes, per user — the widest per-user write budget on this
 * surface, and the anchor the ceiling above is derived from.
 *
 * The width is deliberate and its route wrote the argument: recording is the
 * ORDINARY act here and correcting is the exceptional one, 80/hr is a shelter
 * worker doing rounds, and 300/day is the abuse backstop past which an account is
 * doing something no holder does — every asiento signed by it and auditable.
 */
export const API_V1_PET_RECORD_WRITE_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 20,
  maxPerHour: 80,
  maxPerDay: 300,
};

/**
 * Registration, per IP. `POST /api/v1/pets` only — 12× its per-user anchor on
 * both windows.
 *
 * THE PER-HOUR HALF IS THE ONE THAT MATTERED. At the old 120/hr this bucket
 * admitted four accounts per gateway per hour at their own 30/hr, on the endpoint
 * `/api/v1/localities` was raised to 600/min to protect — the typeahead survived
 * the plaza registration drive and the registration did not. Full argument in the
 * header, including why raising it does not widen the scripted-farm case the old
 * docblock claimed this bucket was for (`auth_signup_ip` is upstream and eight
 * times tighter).
 */
export const API_V1_PET_REGISTRATION_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 120,
  maxPerHour: 360,
};

/**
 * Registration, per user — the anchor the ceiling above is derived from.
 *
 * Unchanged from the route, where the argument for each of the three numbers
 * lives: 10/min is headroom for retries of a form that takes minutes to fill,
 * 30/hr is ten pets with three attempts each, 60/day is the abuse backstop. A
 * family registering three pets in an evening is not within an order of magnitude
 * of the tightest of them.
 */
export const API_V1_PET_REGISTRATION_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 10,
  maxPerHour: 30,
  maxPerDay: 60,
};

/**
 * Media uploads, per IP. `POST /pets/{token}/photo` only — 12× its per-user
 * anchor on both windows.
 *
 * ONE FAMILY FOR BOTH COMMANDS ON ONE ROUTE, and the route spends it TWICE per
 * photo (once minting the ticket, once confirming). That is the honest shape:
 * the two are one act, a client that gets a ticket and never confirms has still
 * spent the expensive half of the decision, and sizing the anchor for six
 * PHOTOS while the counter ticks per REQUEST would silently halve it. The
 * numbers below are per REQUEST and the derivation says so.
 */
export const API_V1_MEDIA_UPLOAD_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 144,
  maxPerHour: 576,
};

/**
 * Media uploads, per user — the anchor the ceiling above is derived from, and
 * the tightest per-user WRITE budget on this surface.
 *
 * IT IS TIGHTER THAN AN ASIENTO ON PURPOSE, and the reason is what the two
 * requests AUTHORISE rather than what they cost us. Minting a ticket is one
 * signature and one round trip — cheap. What it hands out is a capability to
 * write 5 MB into our object store, valid for two hours (a window Supabase
 * picks, not us — see `packages/contract/src/api/pet-photo.ts`), and the
 * confirm that follows fetches those 5 MB back, runs them through sharp, and
 * writes a normalised copy out again. So the unit being bounded is not "a row"
 * but "≈15 MB of object-store traffic and a CPU-bound re-encode", and the
 * ceiling that matters is the one on ISSUED CAPABILITIES, not on completed
 * photos.
 *
 * 12/min is six photos a minute at two requests each — a person retrying a
 * flaky upload on 4G several times over, which is the real case this has to
 * survive. 48/hr is 24 photos in an hour: more than a shelter worker
 * photographing a morning's intake, and far short of a script. 120/day is the
 * abuse backstop, past which an account is not photographing animals.
 *
 * A SHELTER WITH A REAL BULK NEED IS NOT THE CASE THIS BOUNDS. That is an org
 * on the web with a keyboard, and it does not come through this door.
 */
export const API_V1_MEDIA_UPLOAD_USER_LIMIT: RateLimitConfig = {
  maxPerMinute: 12,
  maxPerHour: 48,
  maxPerDay: 120,
};

/**
 * Adoption applications, per IP. `POST /api/v1/adoptions/{petToken}` only —
 * 12× its per-user anchor, flat on both windows.
 *
 * ITS OWN FAMILY, AND THE FIRST ONE ON THIS SURFACE WHOSE ACT WRITES INTO
 * SOMEBODY ELSE'S QUEUE. Every other write here touches the caller's own
 * records: their animal's identity, their inbox, their session list, their
 * account. One submission appends to the spine, opens or joins a case, fans out
 * up to 25 notification rows to a shelter's staff, and lands a hand-written
 * letter about a stranger in a review queue a person has to read. The abuse it
 * is sized against is not hammering — a duplicate application for the same
 * animal is refused outright — it is BREADTH: one account applying to every
 * listed animal in the country, which spends the one resource this product
 * cannot give a shelter back.
 *
 * THE PER-USER HALF IS NOT HERE, deliberately, and this is the shape
 * `API_V1_ACCOUNT_SECURITY_IP_LIMIT` already uses: it lives beside its use-case
 * in `src/modules/adoption/application/adoption-application-limits.ts`
 * (`ADOPTION_APPLICATION_USER_LIMIT`, 5/min · 15/hr · 30/day) so the web form and
 * the bearer door spend ONE counter. The whole three-window derivation, and why
 * the DAY window is the binding one, is written out there and is not repeated
 * here.
 *
 * FLAT 12× ON BOTH WINDOWS, like `API_V1_ACCOUNT_SECURITY_IP_LIMIT` and
 * `API_V1_INBOX_STATE_IP_LIMIT` and unlike the generic write family: the
 * per-user pair (5/min, 15/hr) is already proportionate, so multiplying both by
 * `API_V1_SIMULTANEOUS_CALLERS` preserves its shape instead of propagating a
 * deliberate narrowing upward.
 *
 * WHAT IT GIVES UP, stated as every sibling states it: the IP bucket runs BEFORE
 * the liveness guard, so 60/min is 60 GoTrue round-trips a minute that a caller
 * holding a well-formed but invalid token can force from one address. That is
 * the lowest exposure of any bucket on this surface, which is where it belongs.
 */
export const API_V1_ADOPTION_APPLICATION_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 60,
  maxPerHour: 180,
};

/**
 * Which family each per-IP bucket on `/api/v1` belongs to.
 *
 * THIS IS THE FENCE, and it is the reason the prose list in the header is safe
 * to write. `__tests__/api-v1-rate-limit-families.test.ts` reads every
 * `app/api/v1/**\/route.ts`, collects the `api_v1_*` bucket literals that are
 * keyed on the caller IP, and asserts the two sets are equal in BOTH
 * directions: a new route cannot land without declaring a family, and a bucket
 * that disappears cannot linger here pretending the surface still has it.
 *
 * `route-local` is the sentinel and it is EMPTY. It means "this bucket's route
 * hands the limiter its own literal instead of one of this file's constants",
 * which is what the fence infers from a call site — so a bucket that lands with
 * its own number falls into it and fails, and the fix is a family and a derivation
 * here. It used to be `pre-cgnat` ("knowingly left on the pre-B13 ceiling") and
 * held ten buckets; those landed on 2026-08-27, and a family named for a moment
 * nothing satisfies any more is a comment describing an empty set.
 */
export type ApiV1IpFamily =
  | "authenticated-read"
  | "authenticated-write"
  | "account-security"
  | "inbox-state"
  | "public-reference"
  | "pet-disclosure-write"
  | "pet-record-write"
  | "pet-registration"
  | "media-upload"
  | "adoption-application"
  | "route-local";

/**
 * Every family there is, as a runtime list.
 *
 * IT EXISTS SO A FENCE CAN BE EXHAUSTIVE. `__tests__/api-v1-rate-limit-families
 * .test.ts` partitions the families into "read handlers only" and "write handlers
 * only"; a family missing from BOTH of its lists is silently exempt from the
 * check that catches a write route wearing a read ceiling — which is the exact
 * defect that test was extended to catch in the first place, reintroduced one
 * level up by omission. Deriving the list from the bucket map would not do: a
 * family whose only route was deleted would vanish from it and take its own
 * assertion with it.
 *
 * The `satisfies` below is what keeps it complete: adding a member to
 * `ApiV1IpFamily` without adding it here is a type error in this file.
 */
export const API_V1_IP_FAMILIES = [
  "authenticated-read",
  "authenticated-write",
  "account-security",
  "inbox-state",
  "public-reference",
  "pet-disclosure-write",
  "pet-record-write",
  "pet-registration",
  "media-upload",
  "adoption-application",
  "route-local",
] as const satisfies readonly ApiV1IpFamily[];

type _EveryFamilyIsListed = ApiV1IpFamily extends (typeof API_V1_IP_FAMILIES)[number]
  ? true
  : [
      "missing from API_V1_IP_FAMILIES",
      Exclude<ApiV1IpFamily, (typeof API_V1_IP_FAMILIES)[number]>,
    ];
const _everyFamilyIsListed: _EveryFamilyIsListed = true;
void _everyFamilyIsListed;

export const API_V1_IP_BUCKET_FAMILIES: Readonly<Record<string, ApiV1IpFamily>> = {
  // Re-derived by WU-EAS-2.
  api_v1_me: "authenticated-read",
  api_v1_me_pets_ip: "authenticated-read",
  api_v1_me_transfers_read_ip: "authenticated-read",
  api_v1_me_caretaker_grants_read_ip: "authenticated-read",
  api_v1_me_transfers_write_ip: "authenticated-write",
  api_v1_me_caretaker_grants_write_ip: "authenticated-write",
  api_v1_me_revoke_sessions_ip: "account-security",
  // Added by D4 with `POST /me/reactivate`: undoing your own deactivation from
  // the app. The family's shape exactly — rare, deliberate, on your own
  // account, and its failure mode is "you cannot get back into your account".
  // Its per-user half is spent at the route (API_V1_ACCOUNT_SECURITY_USER_LIMIT).
  api_v1_me_reactivate_ip: "account-security",

  // Added by T4-M5 with the foster surface in the native app. Both buckets join
  // the general authenticated families: reading the foster state is an ordinary
  // authenticated read, and offering or ending a foster stay moves custody, which
  // is exactly what the authenticated-write ceiling is sized against.
  api_v1_me_foster_read_ip: "authenticated-read",
  api_v1_me_foster_write_ip: "authenticated-write",
  api_v1_localities: "public-reference",

  // Added by WU-Q-1 with the native inbox. The READ joins the existing family;
  // the WRITE gets its own, because the authenticated-write ceiling is sized
  // against handing over an animal and this is marking a notification read.
  api_v1_me_notifications_read_ip: "authenticated-read",
  api_v1_me_notifications_write_ip: "inbox-state",

  // Added by M11 with the owner's casos in the native app. Both are ordinary
  // authenticated reads — the list the web's bandeja shows and one case detail —
  // so both join the read family; there is no write on this surface.
  api_v1_me_cases_read_ip: "authenticated-read",
  api_v1_me_case_detail_ip: "authenticated-read",

  // Push target registration, landed with the native push channel. It BORROWS
  // `authenticated-write` rather than getting a family of its own, and that is
  // a deliberate choice in the conservative direction: the family's ceiling was
  // derived from what it costs to hand over an animal, which is far more than
  // one upsert on the caller's own row. A family of its own would be two more
  // numbers to keep in agreement with nothing forcing them to, for an act whose
  // real rate is a handful a day — sign-in, a token rotation, a sign-out.
  //
  // It did NOT take `inbox-state` alongside the notification write above, even
  // though both are small writes a phone makes on its own. That family's
  // ceiling is sized for somebody scrolling an inbox marking rows read, which
  // is a burst; this is not.
  api_v1_me_push_targets_ip: "authenticated-write",

  // The ten under `pets/**`, landed 2026-08-27. They carried `pre-cgnat` until
  // then; the header derives each one. The five reads were the authenticated-read
  // family's own numbers all along and only ever needed to be told the family
  // moved. The five writes did NOT share an anchor, so they did not all land on
  // one ceiling: amend's per-user anchor IS the authenticated-write family's, the
  // two disclosure writes share one of their own, and the asiento and the
  // registration each keep theirs.
  api_v1_pet_detail_ip: "authenticated-read",
  api_v1_pet_libreta_ip: "authenticated-read",
  api_v1_pet_event_detail_ip: "authenticated-read",
  api_v1_shares_read_ip: "authenticated-read",
  api_v1_lost_read_ip: "authenticated-read",
  // Landed with the native lost-pet poster (M13). A read of the same animal the
  // lost cockpit just loaded, tapped from that screen — so the same family.
  api_v1_pet_poster_ip: "authenticated-read",
  // Landed with the app's map (M17): address search and pin reverse-geocoding.
  // A POST (an address must not ride in a URL), so a write family by this
  // file's direction rule — the one the welfare door's `resolve_location`, the
  // same act, already spends. What reaches Nominatim is bounded again by the
  // shared per-IP `geocode_public` bucket, which is the tighter of the two.
  api_v1_geocoding_ip: "authenticated-write",
  api_v1_amend_ip: "authenticated-write",
  api_v1_shares_write_ip: "pet-disclosure-write",
  api_v1_lost_write_ip: "pet-disclosure-write",
  api_v1_event_ip: "pet-record-write",
  api_v1_pets_register_ip: "pet-registration",

  // Landed with the pet-photo door. ONE bucket for a route the client hits
  // twice per photo (ticket, then confirm) — see API_V1_MEDIA_UPLOAD_USER_LIMIT
  // for why the anchor is sized per REQUEST rather than per photo.
  api_v1_pet_photo_ip: "media-upload",

  // Landed with the editar door (`pets/{token}/profile`). The read joins the
  // family every other pet-scoped read is in, for its reason: a client that
  // opens a pet and taps "Editar datos" calls both inside a second.
  //
  // THE WRITE IS THE GENERIC AUTHENTICATED-WRITE FAMILY AND NOT
  // `pet-disclosure-write`, which is the neighbouring choice and the wrong one.
  // That family exists for writes that change WHAT OTHER PEOPLE MAY SEE of an
  // animal — the lost-mode fan-out, a share link — and neither command here
  // does: an identity correction publishes nothing new (the name was already on
  // the public credential), and the emergency-contact override is read by
  // nobody but the owner. What bounds this act is the ordinary "one person
  // editing their own records" anchor.
  api_v1_profile_read_ip: "authenticated-read",
  api_v1_profile_write_ip: "authenticated-write",

  // Landed with the native privacidad door (WU-R, `me/privacy`) — the Ley 25.326
  // rights, and the only pair here whose two halves sit in families two orders
  // of magnitude apart. That is deliberate rather than an oversight:
  //
  // THE READ (the art. 14 export) joins `authenticated-read` because the per-IP
  // bucket answers a different question from "how expensive is this call". It
  // exists so an UNAUTHENTICATED hammer is refused before the guard runs, and it
  // must not refuse the 51st neighbour behind a carrier gateway — the exact error
  // B13 found in the credential endpoint. What actually bounds an export is the
  // per-USER bucket inside the use-case (3/min · 10/hr · 20/day, the tightest on
  // this project), which is where a ceiling sized against exfiltration belongs
  // and where the WEB button spends the same budget.
  //
  // THE WRITE (the art. 16 supresión) joins `account-security`, the family of
  // exactly one route until now, and it is the same act in every respect that
  // family was derived for: rare, deliberate, irreversible, done on your own
  // account, and — like `revoke-sessions` — bounded by construction, since a
  // successful call destroys the credential the next one would need. Putting it
  // in `authenticated-write` would size a supresión against "one person editing
  // their own records".
  api_v1_me_privacy_read_ip: "authenticated-read",
  api_v1_me_privacy_write_ip: "account-security",

  // Landed with the native "editar mis datos" door (WU-R, `me/profile`). Both
  // halves take the GENERIC families, and the write's choice is the one worth a
  // line: it is NOT `account-security`, even though its sibling one block up is
  // and both live under `/me`.
  //
  // The family that route is in exists for acts whose failure mode is "you
  // cannot sign out of the phone you lost" or "you cannot exercise a legal
  // right" — rare, deliberate, irreversible. Correcting your own phone number is
  // none of those: it is somebody in a form, possibly saving twice because the
  // first tap did not register, and the anchor for that is the ordinary
  // authenticated-write budget the pet's own editar door already runs on.
  api_v1_me_profile_read_ip: "authenticated-read",
  api_v1_me_profile_write_ip: "authenticated-write",

  // Landed with the native identity door (`POST /me/identity`, PO 2026-09-05) —
  // signup step 2, moved off the browser handoff that pilot testers were reading
  // as "confirm your email".
  //
  // `authenticated-write` AND NOT `account-security`, which is the tempting
  // neighbour twice over: it is a `/me` write, and it is a once-per-lifetime act
  // on the caller's own account, which is two thirds of that family's shape. It
  // is not the third: that family's derivation is that the act's failure mode is
  // "you cannot sign out of the phone you lost" or "you cannot exercise a legal
  // right", and its ceiling (60/min) is sized for something nobody does twice.
  // What this actually is, at the moment somebody is doing it, is one person in a
  // two-field form who may well tap "Guardar" again because the first tap did not
  // look like it registered — the `me/profile` anchor exactly, and the same
  // family it takes.
  //
  // The per-USER bucket is the one that matters here and it is the ordinary
  // authenticated-write anchor rather than something tighter: the act is
  // idempotent (a name is a value, not an append), so a retry storm from one
  // account costs one UPDATE per request and buys the caller nothing.
  api_v1_me_identity_ip: "authenticated-write",

  // Landed with the native turnos door (WU-S, `me/appointments`). Both halves
  // take the GENERIC families, and BOTH choices are the neighbouring one being
  // rejected rather than a default being taken.
  //
  // THE READ is `authenticated-read` for the reason every pet-scoped read is:
  // a client that opens "Mis turnos" is cold-launching or coming off a push,
  // and it calls `/me`, `/me/pets` and this within the same second. One budget
  // bounds the fan-out or none of them does.
  //
  // THE WRITE (the owner cancelling their own turno) is
  // `authenticated-write` and NOT `inbox-state`, which is the tempting
  // neighbour because both are `/me` writes that a person taps. The inbox
  // family was derived from what its write COSTS — "one indexed UPDATE on
  // `notifications` scoped to `user_id`" — and a cancellation is not that: it
  // is a conditional UPDATE on `appointments`, a decrement of the slot's
  // `bookings_count`, and a notification to the provider, which is a
  // transaction across three tables that hands a place back to somebody else.
  // Sizing it against clearing an inbox would put the ceiling of the cheapest
  // authenticated write on this surface over one of the more expensive ones.
  //
  // IT IS ALSO NOT `account-security`, the other `/me` neighbour, even though a
  // cancellation shares that family's "rare, deliberate, irreversible" shape.
  // That family's derivation is not the shape — it is that the act's failure
  // mode is "you cannot sign out of the phone you lost" or "you cannot exercise
  // a legal right", and being refused a cancellation for sixty seconds is
  // neither. What this is, exactly, is one person in a form acting on their own
  // record, which is the authenticated-write anchor and nothing else.
  api_v1_me_appointments_read_ip: "authenticated-read",
  api_v1_me_appointments_write_ip: "authenticated-write",

  // Landed with the native reclamar door (WU-V, `me/pet-claims`), and added HERE
  // by the integrator rather than by the lane that shipped the route: this file
  // was a second lane's territory in the same window, so the route arrived with
  // its bucket spent and undeclared. That is the turnos rejection's exact shape,
  // and it is why it is written down: a bucket the routes spend and the map does
  // not name is not merely an untested line, it silently subtracts itself from
  // `API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE` below — 120/min, in this case.
  //
  // ONE bucket for a POST route with TWO commands (`lookup`, `claim_free`), not
  // two. They share the per-USER budget inside the use-cases (`claim_lookup`,
  // 30/min + 200/hr) precisely so that alternating between them buys a prober
  // nothing; splitting the per-IP counter would hand back at the gateway exactly
  // what the shared user budget refuses. The route has no per-user bucket of its
  // own on purpose — the use-cases already hold one, and it is the budget the
  // WEB's own wizard spends.
  api_v1_me_pet_claims_ip: "authenticated-write",

  // Landed with the native adopción doors (WU-U): the catalogue and the ficha
  // (`adoptions`, `adoptions/{petToken}`) share ONE read bucket, "mis
  // postulaciones" (`me/adoption-applications`) has its own, and the apply is
  // the only bucket on this surface that is neither a read nor an ordinary
  // authenticated write.
  //
  // ONE BUCKET FOR TWO READ ROUTES, which no other pair here does. It is
  // deliberate and it is the catalogue's own shape: opening the ficha of an
  // animal is what a person does FROM the catalogue, dozens of times in one
  // browsing session, and the two calls are one act of reading. Splitting them
  // would give a browser two budgets for one behaviour and tell a reader that
  // the list and the detail are bounded independently, which they are not.
  //
  // THE APPLY IS `adoption-application`, its own family, and the derivation is
  // in `API_V1_ADOPTION_APPLICATION_IP_LIMIT` above. The short version of why no
  // existing family fits: every other write on this surface acts on the caller's
  // OWN records, and this one lands a letter in a shelter's review queue.
  //
  // THESE THREE WERE THE FIRST LANE'S BLOCKER, and the shape of the miss is
  // worth one line because it is the shape this file keeps being bitten by. The
  // routes shipped spending three `api_v1_*` buckets that were never added here,
  // so `__tests__/api-v1-rate-limit-families.test.ts` was 2-red AND the CGNAT
  // aggregate — a `reduce` over this map — under-declared itself by 1.260/min
  // while reading like a computed figure.
  api_v1_adoptions_read_ip: "authenticated-read",
  api_v1_me_adoption_applications_ip: "authenticated-read",
  api_v1_adoption_apply_ip: "adoption-application",

  // Landed with the native denuncia door (WU-T, `POST /api/v1/welfare-reports`),
  // and unlike the two blocks above it is added by the LANE that shipped the
  // route rather than by an integrator afterwards — that lane owns this file in
  // its window, so the pattern the two comments above record ("the route arrived
  // with its bucket spent and undeclared") had no reason to repeat.
  //
  // `authenticated-write` AND NOT A DENUNCIA-SPECIFIC DERIVATION. What this
  // family sizes is CGNAT exposure, and behind a carrier gateway a denuncia is
  // one person filling in a long form — the same act `me/profile` and
  // `pets/{token}/profile` are anchored on. It is NOT `pet-record-write`, whose
  // anchor is a vet day at a rescue with many animals from one egress, and it is
  // NOT `inbox-state`, whose anchor is one indexed UPDATE on the caller's own
  // row: this write inserts a report, opens a case, links it and signals an
  // authority.
  //
  // ONE bucket for a POST route with TWO commands (`resolve_location`, `file`),
  // for the reason `me/pet-claims` above gives. The two are not independent
  // acts — you resolve an address IN ORDER to file — so two counters would let
  // alternating between them buy back at the gateway what neither ceiling meant
  // to give. The per-USER budget is not here at all: it is `welfare_auth`,
  // 10/hr, the same bucket the browser's own action spends, and it lives beside
  // the act in `app/api/v1/welfare-reports/commands.ts`.
  api_v1_welfare_reports_ip: "authenticated-write",

  // Landed with the native BUSCAR half of turnos (WU-S): `/api/v1/appointments`
  // and `/api/v1/appointments/{offeringToken}` share ONE read bucket, which is
  // the second pair on this surface to do so and it is the adoption catalogue's
  // argument verbatim — opening one offering's slot grid is what a person does
  // FROM the results, several times in one sitting, and the two calls are one act
  // of looking for a turno. Two budgets would say the list and the grid are
  // bounded independently, and they are not.
  //
  // `authenticated-read` AND NOT `public-reference`, which is the tempting
  // neighbour: what this reads IS a public catalogue of approved offerings, and
  // `/api/v1/localities` reads a public catalogue too. The difference is the one
  // that family's derivation turns on — `localities` has NO IDENTITY TO KEY ON,
  // so its per-IP bucket is the only bucket there is and carrier NAT bites
  // undiluted. This route requires a session and spends a per-USER bucket
  // underneath, which is what actually bounds a person; the per-IP half is the
  // cheap pre-auth check in front of it, and that is the read family's shape.
  //
  // THE WRITE IS NOT HERE, and its absence is the decision worth reading. `book`
  // lands on `POST /api/v1/me/appointments` beside `cancel` and spends
  // `api_v1_me_appointments_write_ip`, because the two are one anchor: each is a
  // transaction across three tables that moves a place between people. The
  // block above derives that ceiling against exactly that act — "hands a place
  // back to somebody else" — and booking is the same sentence in the other
  // direction. A `booking` family carrying identical numbers would be the
  // eleven-paragraphs problem from the top of this file, once more.
  api_v1_appointment_search_ip: "authenticated-read",

  // Landed with the native MUDANZA door (WU-P, `pets/{token}/move`), added by
  // the LANE that shipped the route rather than handed to an integrator — this
  // file is this lane's territory in its window, so the pattern the two
  // `me/pet-claims` and adopción comments record ("the route arrived with its
  // bucket spent and undeclared") had no reason to repeat.
  //
  // `authenticated-write`, AND IT IS TWO NEIGHBOURS BEING REJECTED. It is NOT
  // `pet-record-write`, which is the tempting one because what a move appends IS
  // a row on the append-only spine: that family's anchor is spelled out above as
  // "a vet day at a rescue is many animals from one egress in one afternoon",
  // and this act is a person who moved house. Sizing a mudanza against a rounds
  // day would hand the widest write budget on the surface to the rarest write on
  // it. And it is NOT `pet-disclosure-write`, whose two members both change WHAT
  // OTHER PEOPLE MAY SEE of an animal — a move publishes nothing new, since the
  // locality was already on the public credential.
  //
  // What it IS, exactly, is one person in a form correcting their own record,
  // which is the anchor `pets/{token}/profile` and `me/profile` already run on —
  // and the web reaches the mudanza form FROM the editar screen, so the two are
  // one act in the reader's hands as well as in this derivation.
  //
  // ONE bucket for a POST-only route: there is no GET here (see the route's own
  // header — the form's two reads are `/pets/{token}` and `/localities`, both of
  // which already have their own), so there is no read bucket to declare.
  api_v1_move_write_ip: "authenticated-write",

  // Landed with the native DEVOLUCIÓN door (WU-P, `pets/{token}/return`), added
  // by the lane that shipped the route for the reason the mudanza block above
  // gives.
  //
  // THE READ joins `authenticated-read` on the argument every pet-scoped read on
  // this surface makes: a client that opens a pet and taps "Devolución" calls
  // `/pets/{token}` and this inside one second, so one budget bounds the
  // sequence or none of them does.
  //
  // THE WRITE IS `authenticated-write` AND THE FAMILY WAS DERIVED AGAINST THIS
  // EXACT ACT. Its own paragraph above quotes `me/transfers`: "offering an animal
  // to somebody is not [something an owner does in bursts] … What this write
  // PRODUCES is not a row — it is a change of who owns an animal in the national
  // registry." `accept_return` ends the actor's custody row, appends
  // `custody_transferred`, moves `pets.status` and closes two cases; it is the
  // same sentence in the other direction, so this is a family being JOINED
  // rather than a shape being matched. The per-user anchor's own justification —
  // "ten a minute is generous headroom for a person answering a backlog of
  // proposals plus every retry a flaky connection produces" — describes this
  // door literally.
  //
  // IT IS NOT `pet-disclosure-write`: a return publishes nothing new about the
  // animal. It is not `inbox-state` either, whose anchor is one indexed UPDATE
  // on the caller's own rows, and this is a transaction across four tables that
  // moves custody between two parties.
  api_v1_return_read_ip: "authenticated-read",
  api_v1_return_write_ip: "authenticated-write",

  // Landed with the vaccine-reminder door (`pets/{token}/reminders`), closing
  // the two `write:*` entries `check-owner-surface-parity.ts` carried for
  // `createVaccineReminderAction` / `deleteVaccineReminderAction`. No read
  // bucket: the list already exists on `GET /pets/{token}` (`pet-move.ts`'s
  // own argument for why IT has no GET). `authenticated-write` and not
  // `pet-disclosure-write`: scheduling or cancelling a personal reminder
  // publishes nothing new to anybody else, and it is not `pet-record-write`
  // either — a reminder is not a row on the append-only spine. What this is,
  // exactly, is one person in a form acting on their own record — the
  // authenticated-write anchor.
  api_v1_reminders_write_ip: "authenticated-write",

  // Landed with the acompañamiento de adopción door (`pets/{token}/rehome`),
  // closing the three `write:*` rehome entries `check-owner-surface-parity.ts`
  // carried. THE READ joins `authenticated-read` on the argument every
  // pet-scoped read makes: a client that opens a pet and taps "Acompañamiento
  // de adopción" calls `/pets/{token}` and this inside one second. THE WRITE
  // is `authenticated-write`, and the family's own anchor describes this act
  // literally — `me/transfers`: "What this write PRODUCES is not a row — it is
  // a change of who owns an animal in the national registry." A sponsorship
  // withdrawal ENDS an org's custody row; a request puts a consent case in a
  // shelter's inbox. Not `pet-disclosure-write` (nothing new is published
  // about the animal by the titular's own act) and not `inbox-state`.
  api_v1_rehome_read_ip: "authenticated-read",
  api_v1_rehome_write_ip: "authenticated-write",
};

/**
 * The per-minute ceiling a single IP may spend across the CGNAT-derived
 * families, added up.
 *
 * Every bucket is separate on purpose — one surface must not be able to spend
 * another's counter — so a per-IP ceiling is ADDITIVE across them, and the
 * honest figure is the sum rather than the largest term. Computed here rather
 * than written down, because §1.1 of docs/architecture/api-invariants.md
 * records what happened the last time this number lived only in prose: an
 * hourly figure was transplanted into the per-minute slot and overstated the
 * ceiling by 2.2× in the very paragraph that existed to state it honestly.
 *
 * SINCE 2026-08-27 IT IS THE WHOLE PER-IP SURFACE. The ten `pets/**` buckets used
 * to sit outside it on route-local numbers, and this docblock used to say how much
 * they contribute ("420/min more") — a second copy of a set, in prose, next to a
 * comment explaining why that is dangerous. It then said that too, and dropped the
 * figure. Now there is nothing outside the sum to state or to drop: `route-local`
 * is empty and the fence keeps it empty. The list that cannot lie is still
 * `API_V1_IP_BUCKET_FAMILIES`; read that, not a number in a sentence.
 */
export const API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE: number = Object.values(
  API_V1_IP_BUCKET_FAMILIES,
).reduce((total, family) => {
  switch (family) {
    case "authenticated-read":
      return total + (API_V1_AUTHENTICATED_READ_IP_LIMIT.maxPerMinute ?? 0);
    case "authenticated-write":
      return total + (API_V1_AUTHENTICATED_WRITE_IP_LIMIT.maxPerMinute ?? 0);
    case "account-security":
      return total + (API_V1_ACCOUNT_SECURITY_IP_LIMIT.maxPerMinute ?? 0);
    case "inbox-state":
      return total + (API_V1_INBOX_STATE_IP_LIMIT.maxPerMinute ?? 0);
    case "public-reference":
      return total + (API_V1_PUBLIC_REFERENCE_IP_LIMIT.maxPerMinute ?? 0);
    case "pet-disclosure-write":
      return total + (API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT.maxPerMinute ?? 0);
    case "pet-record-write":
      return total + (API_V1_PET_RECORD_WRITE_IP_LIMIT.maxPerMinute ?? 0);
    case "pet-registration":
      return total + (API_V1_PET_REGISTRATION_IP_LIMIT.maxPerMinute ?? 0);
    case "media-upload":
      return total + (API_V1_MEDIA_UPLOAD_IP_LIMIT.maxPerMinute ?? 0);
    case "adoption-application":
      return total + (API_V1_ADOPTION_APPLICATION_IP_LIMIT.maxPerMinute ?? 0);
    case "route-local":
      // Unreachable while the map has no `route-local` entry, and the fence
      // asserts it has none. Kept as a case rather than folded into the default
      // so that a bucket landing here contributes ZERO to a ceiling this file
      // does not own, instead of throwing on a sum nobody asked for.
      return total;
    default: {
      const unhandled: never = family;
      throw new Error(`Unhandled /api/v1 rate-limit family: ${JSON.stringify(unhandled)}`);
    }
  }
}, 0);
