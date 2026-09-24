// The budget a signup spends, and the argument for the three numbers in it.
//
// Third sibling of `login-limits.ts` and `password-reset/limits.ts`, and the
// one those two could not be copied into. Both of them say so by name:
// `login-limits.ts` closes with a section titled "WHAT IS DELIBERATELY NOT IN
// THIS FILE" whose whole content is this bucket — "it has no per-account anchor
// to derive against, so it needs an argument of its own rather than this one
// copied, and signup is the more abuse-attractive of the two doors." This file
// is that argument.
//
// ===========================================================================
// WHY THE SIBLINGS' SHAPE DOES NOT TRANSFER
// ===========================================================================
// The per-IP ceilings a reader would reach for first — the ones with a written
// derivation, which are the ones this file was expected to copy — share one
// shape: N simultaneous legitimate callers at their own full PER-IDENTITY
// ceiling. `LOGIN_IP_LIMIT` is 12 × `LOGIN_EMAIL_LIMIT`; `PASSWORD_RESET_IP_LIMIT`
// is 12 × `PASSWORD_RESET_EMAIL_LIMIT`; the PER-USER-ANCHORED families in
// `lib/infra/api-v1-limits.ts` are 12 × their per-user pair. The shape works
// because the per-identity bucket is the one doing the security work — it
// "bounds a PERSON", it is immune to carrier NAT because "a gateway shares
// addresses, not mailboxes" — and the per-IP ceiling's only job is to sit far
// enough above it that the identity bucket is the binding constraint for any
// plausible crowd behind one address.
//
// "PER-USER-ANCHORED" IS DOING WORK IN THAT SENTENCE and an earlier draft left it
// out, writing "every family in `lib/infra/api-v1-limits.ts`" — which contradicts
// this file's own § below, thirty lines down, where `/api/v1/localities` is cited
// as a per-IP ceiling with no identity bucket at all. Two families there have no
// per-user pair to multiply (`API_V1_PUBLIC_REFERENCE_IP_LIMIT`,
// `API_V1_ACCOUNT_SECURITY_IP_LIMIT`), and the twelve-odd per-IP literals outside
// `/api/v1` and outside `auth_*` (see `api-v1-limits.ts`'s § on them) carry no
// written derivation at all. The qualifier is the one `API_V1_SIMULTANEOUS_CALLERS`
// already uses for itself — "every PER-USER-ANCHORED family in this file" — and
// this file should have borrowed it rather than widening it.
//
// SIGNUP HAS NO SUCH BUCKET, AND THE REASON IS STRUCTURAL RATHER THAN AN
// OVERSIGHT. On login and on password recovery the identity ALREADY EXISTS and
// is the thing under attack, so a counter keyed on it is exactly a counter on
// the attack. On signup the identity is the thing being CREATED, and the
// attacker's unit of work is precisely "one more identity". A per-email bucket
// here would read:
//
//   legitimate person   1   (you sign up once, ever)
//   scripted farm       1   (every account is a fresh address, by construction)
//
// A counter whose key the abusive caller changes on every request is not a
// limiter. `api-v1-limits.ts` already rejected exactly this instrument for
// exactly this reason, one endpoint over — its "A SECOND, NARROWER BUCKET:
// CONSIDERED, REJECTED" note on the localities typeahead, "because a typeahead
// varies the query on every keystroke BY DESIGN … write amplification with a
// rationale". A farm varies the email by design in the same way.
//
// So `auth_signup_ip` is NOT the cheap pre-auth check standing in front of a
// better bucket, which is what the derived per-IP ceilings above are. It is the
// only bucket there is — AND IT IS NOT THE ONLY ONE IN THAT POSITION, which the
// first draft of this sentence denied by writing "every other per-IP ceiling in
// this repo" and then contradicted in its own next clause.
// `/api/v1/localities` occupies exactly this position, and that file already drew
// the consequence: "per-IP is not the cheap pre-auth check in front of a better
// bucket — it is the only bucket there is. That makes carrier NAT bite harder,
// not softer." What is special about signup is not being alone here; it is WHY it
// is here — the identity does not exist yet, so the better bucket is not missing,
// it is unbuildable.
//
// AND THEREFORE: A RATE ALONE CANNOT SEPARATE THE TWO POPULATIONS. Twenty
// neighbours at a plaza table and a script on a rented host both produce "one
// account per request, as fast as the door allows". There is no requests-per-hour
// figure at which the citizen is admitted and the farm is refused, because at
// every rate they look identical. A single-window limiter is not choosing
// between them; it is only choosing how many of BOTH to allow. That finding is
// what makes this file's shape different from its siblings' rather than just its
// numbers.
//
// ===========================================================================
// THE SIGNAL THAT DOES SEPARATE THEM: BURST vs SUSTAINED
// ===========================================================================
// The two populations differ in a way one window cannot see and two windows can.
//
//   A REGISTRATION DRIVE IS A BURST THAT ENDS. Twenty neighbours sign up in one
//   afternoon in one plaza, and each of them signs up ONCE IN THEIR LIFE. The
//   event has a total, and the total is small.
//
//   A FARM IS A RATE THAT PERSISTS. It does not want twenty accounts; it wants
//   thousands, so it runs for hours or days. Its defining property is not how
//   fast it goes in any one minute — it will happily go slowly — but that it
//   does not stop.
//
// A limiter with a short window prices the burst and is blind to the duration. A
// limiter with a LONG window prices the duration. Using both, with the long one
// set deliberately BELOW the short one's sustained product, admits the burst and
// refuses the rate. That is the derivation this file did not have.
//
// WHAT MAKES THIS MORE THAN A RESHUFFLE: TODAY THERE IS NO LONG WINDOW AT ALL.
// `auth_signup_ip` ran 3/min + 15/hr and nothing else, so a patient farm at
// exactly 15/hr, all day, every day, from one address, tripped NOTHING — 360
// accounts a day, indefinitely, entirely within the rules. The bucket bounded a
// farm in a hurry and was silent about a farm with time, which is the only kind
// that matters when the goal is volume. The day ceiling below is the first thing
// this bucket has ever had that a patient farm can hit.
//
// ===========================================================================
// THE NUMBERS
// ===========================================================================
// ---------------------------------------------------------------------------
// THE ANCHOR: ONE ACCOUNT PER PERSON. Not an adoption guess.
// ---------------------------------------------------------------------------
// `api-v1-limits.ts` sizes its families against 10% app adoption and labels that
// figure "THE SOFT SPOT IN EVERYTHING BELOW", a guess about a product that had
// not launched. This file does not use it, for the reason `password-reset/
// limits.ts` gives for not using it either: an anchor this repo already owns does
// not move when adoption does.
//
// The anchor here is what the ACT is: A PERSON SIGNS UP ONCE. That is the same
// move password-reset makes for its per-minute window — "The per-minute anchor is
// 1 and not 5 because of what the ACT is: you ask once and then go read your
// mail" — and it is sturdier than either adoption or carrier topology, because it
// is not an estimate at all.
//
// One account per person means the per-IP ceiling is `people × attempts`, and the
// only question left is HOW MANY PEOPLE, at once, behind one gateway.
//
// ---------------------------------------------------------------------------
// HOW MANY PEOPLE: TWENTY, AND THE REPO ALREADY CHOSE THAT NUMBER
// ---------------------------------------------------------------------------
// Not the siblings' twelve. Twelve is "how many people behind one gateway do this
// in the same moment" for an act nobody organises — signing in, asking for a
// recovery mail. A signup drive is the opposite: it is an event whose ENTIRE
// PURPOSE is that many people do this at once, so a ceiling sized for an
// unorganised crowd is sized for the wrong event.
//
// The figure is twenty, and it is not invented here. `api-v1-limits.ts` raised
// `/api/v1/localities` to 600/min for "a municipality running a registration
// drive in a plaza, TWENTY PEOPLE registering a pet at once on the same cell",
// and `app/api/v1/pets/route.ts` raised `api_v1_pets_register_ip` for the same
// twenty in the same plaza. Same event, same cell, one door earlier.
//
// AND THAT IS THE CLIFF THIS FILE EXISTS FOR — a third one, sharper than the two
// already closed, and closed last because it is first. The typeahead was raised
// to survive the drive. The pet registration the typeahead feeds was raised to
// survive the drive. SIGNUP, which is upstream of both and is the door a citizen
// WITHOUT AN ACCOUNT has to come through before either of them exists, was left
// at fifteen an hour. Twenty neighbours behind one cell tower, five refused —
// and the two endpoints widened for their benefit sat downstream of a door they
// never reached. `api-v1-limits.ts` wrote the pattern down when it found the
// second instance ("The typeahead was made to survive that drive while the
// registration it feeds was left at a ceiling the drive exhausts inside an
// hour"); this is the third, and the first one where the refusal falls on a
// person who does not yet have an account to be refused as.
//
// ---------------------------------------------------------------------------
// PER MINUTE: 3/min → 60/min  =  20 people × 3 attempts
// ---------------------------------------------------------------------------
// THREE ATTEMPTS, and it is worth being exact about what an attempt IS, because
// this counter is cheaper to spend than it looks. The four validation gates in
// `signup.ts` (missing fields, short password, mismatch, TOS) all return BEFORE
// `enforceRateLimit`, so a mistyped confirmation costs nothing. Only a request
// that passed validation and is on its way to GoTrue spends the bucket. Three of
// those for one person is: the one that works, plus a request that left the phone
// and whose reply did not come back over a saturated cell (indistinguishable to
// the user from nothing happening, so they tap again), plus one more.
//
// `API_V1_PET_REGISTRATION_USER_LIMIT` prices retries the same way and says why
// — "10/min is headroom for RETRIES of a form that takes minutes to type (a limit
// that punishes the retry it just asked for would be self-defeating)". A signup
// form is longer than that one.
//
// 60/min IS THE WHOLE DRIVE COMPRESSED INTO A SINGLE MINUTE, which is not what a
// drive does: twenty people filling a form with a volunteer walking them through
// it spreads over ten minutes or more, so the realistic per-minute peak is a
// small fraction of this and 60 is the pathological case, not the modelled one.
// That is deliberate, and `api-v1-limits.ts` explains the discipline — the old
// authenticated-read ceiling was "refused at exactly 100% of the modelled peak —
// not over it, AT it, during ordinary use, with nobody doing anything wrong".
//
// IT LANDS ON `LOGIN_IP_LIMIT.maxPerMinute` AND IS NOT THAT CONSTANT. Login
// reaches 60 as 12 × 5; this reaches it as 20 × 3. Two derivations that meet at a
// number are still two derivations — the rule `api-v1-limits.ts` states for
// `API_V1_PET_RECORD_WRITE_IP_LIMIT` and `API_V1_INBOX_STATE_IP_LIMIT` ("Two
// families that meet at a number must not be merged on the strength of the
// coincidence").
//
// ---------------------------------------------------------------------------
// PER HOUR: 15/hr → 180/hr  =  three drives
// ---------------------------------------------------------------------------
// One drive is 60 requests. An hour is sized at three of them: a campaign with
// more than one table behind the same carrier gateway, or one table plus an
// ordinary afternoon's organic signup from everybody else on that cell.
//
// This is the number the board's complaint is about, and the arithmetic of the
// complaint is worth keeping: at 15/hr, twenty neighbours produced five refusals
// before retries were even counted. At 180 the same drive sits at a third of
// budget with its retries included.
//
// ---------------------------------------------------------------------------
// PER DAY: NEW — 360/day, and it is what BUYS the two raises above
// ---------------------------------------------------------------------------
// This window did not exist. It is the whole reason the change above is not
// simply "a signup limit was loosened", and it is derived differently from the
// other two on purpose: NOT from the drive, but from what this bucket ALREADY
// YIELDS.
//
//   The superseded ceiling was 15/hr with no daily bound.
//   15/hr × 24 h = 360 accounts per address per day, available today, to anyone
//   patient enough to take them at that rate.
//
// So 360/day is not a new allowance. It is the daily maximum this bucket has been
// handing out all along as an ACCIDENT of having only short windows, promoted to
// a stated ceiling. And that is the honest summary of this entire change:
//
//   THE SUSTAINED DAILY ABUSE YIELD PER ADDRESS IS UNCHANGED, TO THE ACCOUNT.
//   Averaged over any run of whole UTC days, a farm takes 360 a day — exactly
//   what 15/hr already handed it. What changes is WHEN inside the day it may be
//   spent, which is the axis on which the plaza and the farm actually differ.
//
// BOTH "SUSTAINED" AND "UTC" ARE LOAD-BEARING, and the first draft of this
// paragraph carried neither: it said "the daily abuse yield per address is
// unchanged, to the account", full stop. That is wrong at the boundary, and
// wrong in the direction that flatters the change. These windows are FIXED, not
// rolling — `enforceRateLimit` floors on 86,400,000 ms — so a farm can stand on
// midnight UTC and take a whole day's budget on each side of it:
//
//   180/hr × 2 h ending   00:00 UTC  = 360   (all of day D)
//   180/hr × 2 h starting 00:00 UTC  = 360   (all of day D+1)
//                                      720 accounts inside a ~4-hour span
//
// The superseded configuration could not do that. With 15/hr and no day bound,
// the worst case in ANY rolling 24 h was the 25 fixed hour-windows such a span
// can touch × 15 = 375, and in any rolling 4 h it was 5 × 15 = 75. So the
// rolling-24h peak nearly DOUBLES (375 → 720) and the rolling-4h peak rises
// about tenfold (75 → 720).
//
// THE AVERAGE IS WHAT DOES NOT MOVE; THE PEAK MOVES A LOT. The argument above
// survives that — a farm's product is volume over time, and over time it gets
// what it always got — but the summary only holds with the word "sustained" in
// it, and the concentration is priced as cost 4 below rather than left here as
// an aside. A farm running for a week still gets what it got before. A drive,
// which needed 60 of those 360 inside one afternoon and was allowed 15 per hour,
// now gets them.
//
// THE SHAPE, STATED AS THE RELATIONSHIP THE FENCE PINS: 360/day is 1/12th of what
// 180/hr would yield if sustained for 24 hours (4,320). The day ceiling is
// deliberately, massively sub-linear in the hourly one, and that gap IS the
// mechanism — it is what says "a burst is fine, a rate is not". A future edit that
// raises the hourly ceiling and scales the daily one with it would delete the
// mechanism while appearing to keep it, so the fence asserts the day against its
// OWN derivation (15 × 24) rather than against the hour.
//
// THE WINDOW IS UTC-ALIGNED — the same fact the straddle above is built on, and
// it is repeated here because it has a second consequence that is purely
// operational. The daily budget resets at 00:00 UTC, which is 21:00 in Argentina,
// not midnight: a gateway locked out "for the rest of the day" comes back in the
// evening, and whoever debugs a refusal at 20:00 local should know the reset is an
// hour away rather than four. Every window in this repo is fixed rather than
// rolling; a day one just makes it noticeable, in both of these ways.
// This is also not a new mechanism: `org_contact_ip` in
// `src/modules/organizations/application/submit-org-contact.ts` already pairs a
// per-minute window with a per-day one on an IP key.
//
// ===========================================================================
// WHAT IT GIVES UP, STATED AS A COST AND NOT AS A FOOTNOTE
// ===========================================================================
// SIX COSTS, NUMBERED IN THE ORDER THEY WERE FOUND AND NOT BY SEVERITY. Read 6
// first: it is the only one about citizens' PII rather than about capacity, and
// it was absent from the first draft of this file entirely.
//
//   1. A GATEWAY CAN NOW BE LOCKED OUT FOR THE REST OF THE DAY, not for the rest
//      of the hour. This is the genuinely new failure mode and it is the worst
//      thing in this file. If a farm parks on one carrier gateway and burns 360,
//      every legitimate citizen on that carrier is refused signup until the UTC
//      day rolls.
//
//      IT IS SMALLER THAN IT FIRST READS, and the comparison is with the real
//      alternative rather than with a clean slate: a farm running at the OLD
//      15/hr already exhausted that gateway's budget continuously, hour after
//      hour, leaving a legitimate arrival essentially nothing at any moment of
//      the day. Today's damage is a permanent trickle-lockout; the new damage is
//      a lockout with an earlier, larger window that a citizen arriving before
//      the farm actually gets through. What genuinely worsens is the TAIL — there
//      is no longer an hourly reset handing out a fresh sliver.
//
//      AND THE HONEST MITIGATION IS NOT A NUMBER. Nothing in this file can tell a
//      citizen behind a gateway apart from a farm behind the same gateway; that
//      needs a signal the request does not carry (see the rejected options
//      below). The number is chosen so the case does not arise — 360/day is six
//      full drives — and the residual is named here rather than discovered.
//
//   2. THE BURST IS REAL: 60 GoTrue account creations a minute from one address,
//      where it was 3. Each fires `handle_new_user` (db/triggers.sql) and writes a
//      profile row, so this is heavier per request than the `auth.getUser()`
//      round-trips `api-v1-limits.ts` prices for its own families at the same
//      ceiling. It is bounded by the day cap to roughly six minutes of that, and
//      then the address is done — which is a bound the old configuration did not
//      have at any timescale.
//
//   3. A BURST IS MORE VISIBLE THAN A TRICKLE, and that is on the credit side.
//      360 signups from one address inside ten minutes is a shape somebody can
//      notice; 15 an hour for a day is the shape that hides. No detector consumes
//      this today — there is no signup-anomaly alert — so it is potential rather
//      than realised, and it is not offered as a reason the change is safe.
//
//   4. THE PEAK CONCENTRATES AT THE UTC BOUNDARY, and the "unchanged yield"
//      summary above covers the average rather than this. Because every window
//      here is fixed rather than rolling, a farm straddling 00:00 UTC takes 720
//      accounts in roughly four hours — against a superseded worst case of 375
//      in any rolling 24 h and 75 in any rolling 4 h. Sustained yield does not
//      move; instantaneous concentration nearly doubles over a day and rises
//      about tenfold over four hours. This is the one measure on which the new
//      configuration is worse for the defender than the old one, and it is not
//      visible from any single window's number.
//
//      IT IS NOT FIXABLE WITH A NUMBER IN THIS FILE. Lowering the day ceiling
//      below 360 would make this a real tightening rather than the neutral
//      trade argued above, and a rolling window is a different limiter than the
//      one this repo has — `rate-limit.ts` keys every bucket on a floored
//      window start, for every window, on every endpoint. So the straddle is
//      accepted and named here rather than discovered later, and it is the
//      second shape a signup-anomaly detector should look for after the burst
//      in cost 3.
//
//   5. WHAT DOES NOT MOVE, checked rather than assumed: `api-v1-limits.ts` and
//      `app/api/v1/pets/route.ts` both rest their scripted-pet-farm argument on
//      THIS bucket being the tighter upstream one ("a farm makes an account per
//      pet"). It still is — but the margin did NOT widen on every window, and
//      saying it did would be choosing the flattering one.
//      `API_V1_PET_REGISTRATION_IP_LIMIT` is 120/min + 360/hr with NO daily
//      bound, i.e. 8,640 pets/day per address. Signup against it, before → after:
//
//        per minute    3 vs 120  = 40× tighter  →   60 vs 120  =  2× tighter
//        per hour     15 vs 360  = 24× tighter  →  180 vs 360  =  2× tighter
//        per day     360 vs 8640 = 24× tighter  →  360 vs 8640 = 24× tighter
//
//      So on both SHORT windows the margin collapses to 2×, and only on the day
//      does it hold at 24×. The conclusion survives anyway, and the reason is
//      the same one this whole file rests on: a farm's yield is bounded by the
//      day, not by its best minute. Signup still binds the farm at 360 pets a
//      day — the same 360 the old 15/hr yielded over 24 hours. But a reader who
//      needs the SHORT-window headroom (a burst of registrations, not a farm)
//      should know it is now 2× and not 24×, which is the honest reading and
//      not the one the first draft of those two files gave.
//
//   6. THE ENUMERATION ORACLE IS METERED BY THIS BUCKET AND NOTHING ELSE, and a
//      list of citizens' addresses can now be tested 240× faster. This is the one
//      cost here about PII rather than about capacity, and the first draft of this
//      file did not contain it at all — which is worse than an omission, because
//      the comment this change DELETED from `signup.ts` was the only place in the
//      repo the connection was written down. It read: a low ceiling "caps both
//      account-spam and the enumeration oracle (audit 28-#3) cost". Removing the
//      literal removed the sentence, and the sentence was half the justification.
//
//      THE ORACLE IS STILL OPEN — this bucket is not standing in front of a closed
//      hole. Audit 28-#3 (MED,
//      `dim-interno:docs/reviews/results/28-auth-recovery-session-hardening.md`) found signup
//      leaking account existence, and its second clause is the live one: with
//      `enable_confirmations=false`, "testing an email costs nothing". The MESSAGE
//      channel was closed — `signup.ts`'s masquerade returns the same success
//      shape for a duplicate, fenced by `__tests__/signup-enumeration.test.ts`.
//      Confirmations are still off (`supabase/config.toml:221`, PO decision
//      2026-07-10), so the SESSION-PRESENCE channel is not: a genuine signup
//      returns a credential and a duplicate returns `session: null`. `signup.ts`
//      states that residual on both transports and calls closing it PO-gated.
//
//      THE NUMBER, per trusted edge IP, before → after:
//
//        addresses testable per minute      3 →  60      20× more
//        addresses testable per hour       15 → 180      12× more
//        addresses testable per UTC day   360 → 360      unchanged
//        peak in any rolling 4 h           75 → 720     ~9.6× more
//        peak in any rolling 24 h         375 → 720     ~1.9× more
//
//      IT IS THE SAME COUNTER AS COST 4's, not a parallel one, which is why the
//      rows match: `auth_signup_ip` is spent once per request that reaches GoTrue,
//      and a probe and an account creation ARE the same request. There is no
//      second budget to raise and no way to spend one 360 twice — a day of probing
//      is a day not spent farming.
//
//      SO THE SUSTAINED EXPOSURE IS FLAT AND THE LATENCY COLLAPSES, and the second
//      half is the actual cost. Enumeration is a LIST attack: what it costs is how
//      long N addresses take, not how many fit in an abstract hour. From one
//      address, with the fixed windows this repo has:
//
//        first 180 addresses    12 h  →  3 min      (12 × 15  vs  3 × 60)
//        full  360 addresses    24 h  →  6 min      straddling a fixed hour
//                                                   boundary — 180 before it and
//                                                   180 after; ~1 h if not
//
//      240× either way. The daily total does not move and the attack goes from one
//      nobody runs to one that finishes over a coffee. That is a real worsening,
//      it is invisible from every single window's number, and no other paragraph
//      in this file covers it — "sustained yield unchanged" is exactly the summary
//      that hides it.
//
//      AND EVERY MISS SQUATS AN ADDRESS. The probe is not read-only. An address
//      with no account GETS one, because `signUp` succeeds — so an attacker
//      enumerating a list turns each NEGATIVE into a real GoTrue user bearing a
//      citizen's email, and that citizen is then refused at their own signup and
//      recovers only through support. Bounded by the same 360/day, and it is why
//      cost 2's "60 GoTrue account creations a minute" and this row are one fact
//      rather than two.
//
//      WHAT DOES NOT BOUND IT. GoTrue's own `sign_in_sign_ups = 30 per 5 min per
//      IP` (`supabase/config.toml:202`) would bind below 60/min if it were live —
//      audit 28-#6 is a HIGH finding saying precisely that this file is local CLI
//      config and nobody has confirmed the hosted project matches it, so it is not
//      counted on here. CAPTCHA (`[auth.captcha]`, commented out) is the other
//      backstop 28-#6 asks for and is not ours to enable either.
//
//      WHY IT IS DECLARED RATHER THAN PRICED OUT WITH A SMALLER NUMBER. The only
//      lever here that touches the latency is `maxPerMinute`, and it is the one
//      number the plaza needs — 60 IS the drive. Halving it buys the defender six
//      minutes against a list attack and costs half the neighbours their signup,
//      which is not a trade worth making. The oracle's real fix is confirmations
//      ON: it closes the residual channel outright AND gives the door its first
//      per-identity cost, which is why "WHAT IS NOT SOLVED HERE" below names it as
//      the one instrument that would. This number is on the record so whoever
//      weighs that PO decision has it in hand rather than having to re-derive it.
//
//      `__tests__/api-v1-auth-routes.test.ts` pins the 12× hourly figure against
//      `SIGNUP_SUPERSEDED_HOURLY_IP_CEILING`, so the multiplier cannot be
//      re-baselined by moving what it is measured from.
//
// ===========================================================================
// FOUR OTHER SHAPES, CONSIDERED AND REJECTED
// ===========================================================================
// Written down because the first of them is what a reader will reach for, and
// because the last two are the right long-term answers and are not ours to take.
//
//   A WIDER SINGLE WINDOW — raise 15/hr to 180/hr and stop. Rejected: it
//   multiplies the farm's daily yield by twelve (360 → 4,320) to solve a burst
//   problem, and it is the version of this change that genuinely is "a signup
//   limit was loosened". The day ceiling is what makes the same raise cost
//   nothing.
//
//   PROOF OF WORK — a client-side puzzle before signup is accepted. Rejected on
//   the asymmetry, which runs the wrong way HERE specifically: this door's
//   legitimate caller is a citizen in a plaza on the cheapest Android sold in
//   Argentina, and the abusive one is a rented server. A puzzle costly enough to
//   price a farm is seconds to minutes of a low-end phone's battery, so it taxes
//   exactly the population this change exists to admit. It also bounds nothing
//   absolutely — a farm simply pays — and needs new client code on three
//   surfaces (web form, native app, `/api/v1`) that the repo has none of.
//
//   A PER-DEVICE CEILING — anchor on a device identifier instead of an address.
//   Rejected as currently unbuildable: any identifier a client SENDS is one it
//   can rotate per request, which is the failure mode `callerIp()`'s docblock is
//   entirely about ("A client that could choose its own key would make this
//   decoration"), and the web has no device identity at all. Real device
//   attestation (Play Integrity, App Attest) is not that — it is the genuine
//   long-term answer to this bucket, and it is a Google dependency, a native
//   module, an EAS build and a PO decision, covering only one of the two doors.
//
//   A PER-JURISDICTION QUOTA — Rejected as not available at this point in the
//   flow rather than on its merits. Step 1 collects email, password and TOS and
//   nothing else; the locality and the DNI arrive at step 2
//   (`complete-identity.ts`), after the account exists and after this bucket has
//   already been spent. There is no geographic signal in the request this limiter
//   sees.
//
// ===========================================================================
// THREE SITES STILL QUOTING THE SUPERSEDED NUMBERS — REPORTED, NOT TOUCHED
// ===========================================================================
// Six files that stated `3/min · 15/hr` as CURRENT were corrected with this
// change (`signup.ts`, `app/api/v1/auth/signup/route.ts`, `login-limits.ts`,
// `api-v1-limits.ts`, `app/api/v1/pets/route.ts`,
// `docs/architecture/api-invariants.md`). Three more were NOT, and they are
// named here in full rather than left for the next reader to trip over — an
// earlier draft of this section listed only the first of them, which is the same
// half-told-inventory defect `api-v1-limits.ts` keeps recording about itself:
//
//   apps/mobile/src/auth/session-store.ts:337
//     "`auth_signup_ip`, 3/min · 15/hr … TIGHTER than login's" — now false in
//     both halves. The numbers moved, and the comparison no longer holds as
//     stated: against `LOGIN_IP_LIMIT` (60/min · 240/hr) this bucket is now EQUAL
//     on the minute (60 vs 60) and tighter only on the hour (180 vs 240) — plus a
//     day ceiling login has no equivalent of, which is the real answer and is not
//     what that sentence says.
//   apps/mobile/src/auth/CrearCuentaScreen.test.tsx:121
//     "The signup budget is 3/min per IP."
//   apps/mobile/src/auth/CrearCuentaScreen.test.tsx:221
//     "the budget is 3/min · 15/hr per IP".
//
// ALL THREE ARE PROSE. None is an assertion, none participates in a fence, and
// no test reads these numbers — they are comments explaining why the client does
// not keep a counter of its own, and that explanation stays true at any ceiling.
// So nothing is red because of them.
//
// THEY ARE LEFT ALONE ON TERRITORY GROUNDS, which is a weaker reason than
// correctness and is stated as such. `apps/mobile/` is another lane's package
// and had two writers live in it while this landed; a fourth file from this
// change in their tree is collision surface bought for a comment. The
// collaborating-writer contract's rule 10 says adjacent problems get reported
// rather than fixed, and this is the report. A lane already inside
// `apps/mobile/src/auth/` should fix all three in one pass.
//
// ===========================================================================
// WHAT IS NOT SOLVED HERE, AND IS NOT AGENT WORK
// ===========================================================================
// This change removes a wall a live tester and a plaza drive hit today. It does
// not give the bucket the per-identity anchor it structurally lacks, and no
// arrangement of windows can. The two instruments that WOULD are both decisions
// somebody else has to make and both are recorded elsewhere in the repo as
// pending:
//
//   EMAIL CONFIRMATION, currently OFF by PO decision (2026-07-10, recorded in
//   `signup.ts`). With confirmations ON, an account is not usable until somebody
//   reads a mail at the address, which prices a farm per mailbox rather than per
//   request — the first real per-identity cost this door has ever had. It is the
//   same instrument cost 6 needs, and that is not a coincidence: confirmations ON
//   closes the enumeration residual both transports carry AND makes a probe cost a
//   mailbox, so one PO decision retires the oracle and prices the farm at once. It
//   is blocked behind the Resend setup on the open-work board.
//
//   PHONE VERIFICATION — the stronger instrument and the more expensive one, in
//   money and in PII. Not proposed here.
//
// Both change what an account COSTS. Everything in this file only changes when it
// may be asked for.
//
// WHAT WOULD RE-DERIVE ALL THREE NUMBERS: a count. `login-limits.ts` closes on
// the same sentence and it applies harder here, because this file's twenty is
// borrowed from a plaza nobody has run yet. Signup volume per gateway is
// measurable from the first week of real installs, and the day ceiling is the
// number most likely to be wrong.

import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/**
 * How many people one municipal registration drive puts behind a single carrier
 * gateway at once.
 *
 * NOT THE SIBLINGS' TWELVE, and not a new guess either: it is the figure
 * `lib/infra/api-v1-limits.ts` sized `/api/v1/localities` against and
 * `app/api/v1/pets/route.ts` sized `api_v1_pets_register_ip` against — "twenty
 * people registering a pet at once on the same cell". Signup is the door both of
 * those sit downstream of, so it is the same twenty in the same plaza.
 */
export const SIGNUP_DRIVE_SIZE = 20;

/**
 * Requests one person spends to get one account — the retry allowance.
 *
 * The four validation gates in `signup.ts` return BEFORE the limiter, so a
 * mistyped password costs nothing and these three are requests that genuinely
 * reached GoTrue: the one that worked, plus a reply that never came back over a
 * saturated cell, plus one more. Same reasoning as
 * `API_V1_PET_REGISTRATION_USER_LIMIT`'s, on a longer form.
 */
export const SIGNUP_ATTEMPTS_PER_PERSON = 3;

/**
 * How many drives one gateway's hourly budget holds — several tables in a
 * campaign, or one table plus everyone else on that cell.
 */
export const SIGNUP_DRIVES_PER_HOUR = 3;

/**
 * The hourly ceiling this bucket carried until 2026-08-29, kept as a named
 * constant for ONE purpose: the daily ceiling is derived from it, and the claim
 * that this change costs nothing in daily abuse yield is only checkable if the
 * number it is measured against is in the file rather than in a sentence.
 *
 * It is history and it does not move. `__tests__/api-v1-auth-routes.test.ts`
 * asserts `SIGNUP_IP_LIMIT.maxPerDay` against `this × 24`.
 */
export const SIGNUP_SUPERSEDED_HOURLY_IP_CEILING = 15;

/** Hours in a day. Named only so the day ceiling's derivation reads as one. */
export const HOURS_PER_DAY = 24;

/**
 * Per caller IP — the ONLY bucket this act has, which is the whole reason this
 * file is not one of its siblings. There is no per-identity ceiling to anchor on:
 * signup CREATES the identity, so a per-email counter reads 1 for a citizen and 1
 * for a farm. Full argument in the header.
 *
 * Keyed on `callerIp(headers)` — the trusted edge value (`x-real-ip` / the LAST
 * `x-forwarded-for` hop), never the spoofable first segment.
 *
 *   maxPerMinute  60 = 20 people × 3 attempts   one whole drive, compressed
 *   maxPerHour   180 = 60 × 3 drives            a campaign, or a drive + organic
 *   maxPerDay    360 = 15/hr × 24 h             UNCHANGED daily yield, now stated
 *
 * THE DAY WINDOW IS THE POINT AND IT IS NEW. Without it this is a twelvefold
 * raise on a signup door; with it, the abuse available from one address per day
 * is exactly what the superseded configuration already handed out to anybody
 * patient enough to take it slowly, and the only thing that changed is that a
 * plaza no longer has to be patient.
 *
 * WRITTEN OUT RATHER THAN COMPUTED, for the reason `LOGIN_IP_LIMIT` gives:
 * deriving these in code would make the fence assert `a === a`, and would let
 * somebody move an anchor and take the ceiling along with it without meeting a
 * single argument. Literals plus relationship assertions make that edit fail.
 */
export const SIGNUP_IP_LIMIT: RateLimitConfig = {
  maxPerMinute: 60,
  maxPerHour: 180,
  maxPerDay: 360,
};
