# `/api/v1` invariants

> Snapshot: `c10f4ff03` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-02
> Verified against code on 2026-09-02 by writer D (sonnet subagent) · Status: reviewed
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

**Status:** active · written 2026-08-21 · gates Track 2 (B8) · **all four open decisions closed 2026-08-21** · **first endpoint landed 2026-08-21 (§10)**

> **Path rectification (2026-08-21).** Earlier drafts of this file wrote the
> first endpoint as `/api/v1/p/{token}`, copying the web page's short URL. The
> path that shipped is **`/api/v1/pets/{publicToken}/credential`** — the shape
> `dim-interno:docs/reviews/native-readiness/TRACKS.md` (Track 2, RN-5) specified, and the
> one that leaves room for sibling reads on the same resource. `/p/` is a
> deliberately terse *human* URL printed on a chapa; an API path has no such
> constraint and should name the resource. Every `/api/v1/p/{token}` below is
> the old spelling of this one endpoint.

Every claim in the "Verified today" column was read out of the code on
`integration/all-20260703 @ 9abbfb5f`, not copied from a review document. Where
this file disagrees with `dim-interno:docs/reviews/native-readiness/RN-1-api-boundary.md`,
this file is newer and says so explicitly — the review is a historical record of
what was true on 2026-08-19 and is not edited.

This is a **checklist that gates a merge**, not background reading. A `/api/v1`
route handler that cannot point at each line below is not ready.

---

## 0. Why this document exists before the first endpoint

The web app enforces these properties **per call site**, in page bodies. Nothing
in `middleware.ts` rate-limits, and nothing about being a route handler makes
any of them apply. A native client is a second consumer of the same data through
a surface that inherits almost none of the web's accidental protections.

Two of the three fences that would catch a mistake here **do not look at route
handlers at all** (§7). That, more than any individual limit, is the reason a
checklist has to exist before the first merge rather than after the first bug.

---

## 1. The oracles

> This heading read **"The five oracles"** until 2026-08-26, when §1.6 made six.
> The number is removed rather than incremented, and the reason is written in
> this document twice already (§1.1b, §1.6b): a count in prose is a claim about
> a SET that nothing checks, and the last one turned a missing limiter into
> something that read like a deliberate exception for months. A heading does not
> need to know how many children it has.

### 1.1 Public token read throttle

| | |
|---|---|
| **Enforced at** | `lib/infra/public-token-throttle.ts` — `isPublicTokenReadThrottled(bucket, limit?)`, memoised per request with `React.cache` since 2026-09-23 (one charge per bucket per server render, however many callers ask) |
| **Real limits** | `PUBLIC_TOKEN_READ_LIMIT = { maxPerMinute: 600, maxPerHour: 6_000 }`, per IP — the DEFAULT, used by the five HTML surfaces (raised from 60/400 on 2026-08-25, B13 part 2; the fifth, `/adoptar/{petToken}`, joined later the same day — see §1.1b) |
| **Direction** | **Fail-open.** A `RateLimitError` throttles; any other error returns `false`. The limiter is itself a DB write, budgeted at `RATE_LIMIT_BUDGET_MS = 1500` |
| **Inherited?** | **No.** First statement of each surface, by hand |
| **Pinned by** | `__tests__/public-token-throttle-coverage.test.ts` — derives from `publicPetByToken(` call sites across `app/` (widened 2026-08-21; it used to walk `page.tsx` under one directory and could not see `opengraph-image.tsx`) |

**One charge per visit, with three callers (2026-09-23).** The `/p/{token}`
family now consults the limiter from three places in one request: the landing
`layout.tsx` (the only code outside `loading.tsx`'s Suspense boundary, so the
only place a `notFound()` still sets a real HTTP 404), the page's door, and
`generateMetadata`. All three read through
`app/(public)/p/[publicToken]/credential-probe.ts` — throttle first, then the
pet row, memoised per request — so the limiter is charged ONCE and the row read
ONCE. `/encontre` and `/sighting` are charged on their own bucket (the layout
picks it from middleware's `x-pathname`), which their pages' own guard then
reads back from the memo: no new charge on `public_token_page`. The old
residual — `generateMetadata` resolving the token outside the guard — is
closed. Case variants (`/p/dim-…`) never reach any of it: `middleware.ts`
308-redirects them to the issued spelling, so every limiter key and the scan
log only ever see one name per credential.

**The bucket is per-surface, and that is deliberate.** Call sites pass distinct
names — `public_token_page`, `public_token_encontre`, `public_token_sighting`,
`public_token_og_image` — and the fence *requires* they differ. The stated
reason: a scraper hammering one surface must not spend the budget of the person
who just found a dog in the street and is loading its credential.

**The cost of that choice, stated plainly:** every new bucket raises the
aggregate ceiling for a single IP. Since 2026-08-25 all six token-resolving
buckets carry the CGNAT ceiling, so the aggregate is **6 × 600 = 3.600/min and
36.000/hr per IP** against the token space (it was 240/min before B13, 840/min
between B13's two halves when only the API bucket had been raised, and 3.000/min
for the few hours between B13 part 2 and the adoption ficha joining).

#### 1.1b The fifth HTML surface, and why the count in the prose was the bug

`app/(public)/adoptar/[petToken]/page.tsx` — the public adoption ficha — carried
**no limiter at all** until 2026-08-25. It was exempt in
`__tests__/public-token-throttle-coverage.test.ts` with a written reason: it
resolves only pets that are adoption-LISTED, and listed pets are already
enumerable from the public `/adoptar` catalog, so it discloses nothing the
catalog does not.

Every word of that is true, and all of it is about DISCLOSURE. Two other things a
limiter is for on this surface went unmentioned: it is still a per-token
existence-and-listed ORACLE over a 31^8 space (the catalog answers "which pets
are listed", never "is `DIM-XXXX-XXXX` one of them"), and it is still unbounded
WORK on a `force-dynamic` route — two joined queries, an ownership lookup and a
sponsorship read, at any rate anyone cares to ask.

**The framing is what let it stand.** Calling the throttled set "the four HTML
surfaces" — here, in `lib/infra/public-token-throttle.ts`, and in the `/api/v1`
limit files — turned "the surfaces that carry the limiter" into "the surfaces
that are supposed to", so a fifth of the same shape read as an exception rather
than as a gap. It now carries `public_token_adoptar` at the same default
ceiling. `postular/page.tsx` stays exempt on its own terms: it is the apply step
reached FROM the ficha, so its caller has already spent a request against that
bucket, and it renders no pet identity the card did not already show.

> **DECIDED (§8, D1) · LANDED.** The API gets its OWN bucket,
> `public_token_api_credential`. The isolation is the point; the additive
> ceiling is the accepted price. Applied at
> `app/api/v1/pets/[publicToken]/credential/route.ts` through the throttle port,
> which means the door enforces it before the pet row is read.

> **RE-DERIVED 2026-08-25 (B13) · LANDED.** The bucket now carries its own
> CEILING as well as its own counter: `PUBLIC_TOKEN_API_SURFACE_LIMIT =
> { maxPerMinute: 600, maxPerHour: 6_000 }` and
> `PUBLIC_TOKEN_API_LOOKUP_LIMIT = { maxPerMinute: 120, maxPerHour: 1_200 }`,
> both in `app/api/v1/pets/[publicToken]/credential/limits.ts` with the full
> arithmetic. **Why:** this endpoint's caller is a phone, and Argentine mobile
> carriers put 500–1,000 subscribers behind one public IPv4 (port-block
> allocation, 65,536 ports in blocks of 64–128). At 400/hr that is 0.4
> credential reads per subscriber per hour before the whole gateway is refused,
> and the per-lookup key `${token}:${ip}` is even worse — 100/hr refused the
> 51st neighbour behind one gateway to scan the same lost-pet poster, which is
> the success case, not the abuse case. **What is given up:** essentially
> nothing (figures corrected below). The per-IP ceiling was never an enumeration
> control, it is a cost backstop. A DISTRIBUTED walk is untouched by either
> number, exactly as D1 says. **The real cost:** `rate_limit_buckets` write
> amplification, bounded by the surface per-minute ceiling, so 120 → 1,200
> rows/min per IP in the worst case — an enumerator-only cost, drained by
> `lib/infra/data-lifecycle.ts`. **A per-token-only cap was reconsidered and
> rejected again:** it cannot distinguish a scrape from a viral lost-pet poster
> (same signature), and it hands anyone a way to burn a victim credential's
> global budget. Scrape detection belongs in observability — alert on a token's
> distinct-IP count — not in a limiter that can refuse a finder.

> **KEYSPACE FIGURE CORRECTED 2026-08-25.** B13's original note said "walking
> 36^8 ≈ 2.82 × 10^12 tokens takes ~805.000 years at 400/hr and ~54.000 years at
> 6.000/hr". The keyspace was wrong, in the direction that flatters the
> decision. `lib/infra/publicToken.ts` draws from a **31-character** alphabet
> (`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — 0/O and 1/I/l removed so a human can read
> a token off a physical tag), so the space is **31^8 = 852.891.037.441 ≈ 8,53 ×
> 10^11**, 3,3× smaller than claimed. Corrected figures for a single IP:
>
> | rate | time to walk 31^8 |
> |---|---|
> | 400/hr (old per-surface ceiling) | ≈ 243.000 años |
> | 6.000/hr (new per-surface ceiling) | ≈ 16.200 años |
> | 36.000/hr (all six buckets, aggregate) | ≈ 2.700 años |
>
> The conclusion survives the correction with room to spare, which is why the
> decision stands and only the numbers moved. Stated rather than edited away
> because a mistake that makes a decision look safer is the kind worth leaving a
> record of.

> **THE FOUR HTML SURFACES · LANDED 2026-08-25.** This block used to say they
> still ran the 60/min + 400/hr default, that the same arithmetic applied to
> `/p/{token}` word for word, and that the decision was open because moving them
> moves four public surfaces and the aggregate ceiling at once. It was taken:
> `PUBLIC_TOKEN_READ_LIMIT` (`lib/infra/public-token-throttle.ts`) is now
> **600/min + 6.000/hr**, the same numbers for the same reasons. `/p/{token}` is
> what a stranger's camera opens, which made it the surface where the old
> ceiling cost the most. **No per-lookup bucket was added to them:** that would
> double `rate_limit_buckets` writes on the highest-traffic anonymous surface in
> the product to bound a case the surface bucket already bounds — the mechanism
> **AND THERE WERE FIVE, NOT FOUR** — the adoption ficha joined them later the
> same day; see §1.1b, and note that this very block's heading is part of what
> made a fifth surface read as an exception.
> (`publicTokenThrottle`'s `perLookup`) is there if a measurement ever justifies
> it.

**The REST mistake:** omit the call. Nothing fails; the route ships green.

---

### 1.2 Atender lookup throttle

| | |
|---|---|
| **Enforced at** | `app/org/[orgToken]/atender/atender-access.ts:43,237` |
| **Real limits** | `{ maxPerMinute: 20, maxPerHour: 100 }`, keyed `${organizationId}:${ip}` |
| **Direction** | Fail-open |
| **Inherited?** | **Yes, if you go through the front door.** It lives *inside* `resolveAtenderPet`, so a handler calling that function gets it |
| **Pinned by** | **Nothing.** No test references `atender_lookup` or `ATENDER_LOOKUP_LIMIT` |

An authenticated DIM lookup is a national existence oracle. The 20/min is the
only thing bounding it.

**The REST mistake:** reach past `resolveAtenderPet` to the underlying query
"because the handler doesn't need the page's return shape".

**Adjacent, and worth a deliberate answer:** `app/api/gob/mascotas/[token]/route.ts`
is an existing handler that resolves a pet token bounded only by its guard's
aggregate `120/min` per profile, with no per-lookup limit. It is
jurisdiction-scoped and 404s uniformly, so it is a weaker oracle — but it is the
closest existing analogue to what Track 2 builds. **DECIDED (§8, D3): `/api/v1`
matches ATENDER, not this.** Which makes this route the odd one out; bringing it
in line is a follow-up, and it must not be cited as precedent for new routes.

**LANDED.** `public_token_api_credential_lookup`, keyed `${publicToken}:${ip}`,
fail-open, applied through the throttle port so the door enforces it before the
pet row is read. It landed at atender's `{20/min, 100/hr}` and was re-derived to
`{120/min, 1_200/hr}` on 2026-08-25 (B13, §1.1): atender's numbers bound an
organization's staff on office IPs, and this endpoint's caller is a phone behind
carrier NAT. What each of the two limiters bounds — and what neither bounds — is
written out in `limits.ts` and the route header rather than left for a reader to
infer from two `enforceRateLimit` calls.

---

### 1.3 Denuncia MAC anti-oracle

The best-defended property in this list. Two halves.

**Request-access** (`app/(public)/denuncias/codigo/[code]/actions.ts`): one
`NEUTRAL_MESSAGE` constant returned from a single place on every branch. Rate
limit `5/min + 20/hr` per IP, **fail-closed**. The timing channel is closed by
scheduling the mail through `after()` instead of awaiting it (`:124-130`), with
the reasoning written out at `:18-35`.

**Redemption** (`app/(public)/denuncias/seguimiento/entrar/route.ts:39-42`):
`10/min + 60/hr`. Success and failure are the *same 303 to the same URL*; the
only difference is whether a cookie is set. `validateReporterToken`
(`lib/infra/denuncia-reporter-token.ts:108-136`) uses `timingSafeEqual` behind a
length guard.

**Pinned by** `__tests__/denuncia-access-timing-oracle.test.ts` — 4 tests,
mocked, no DB. It asserts the *property* (the response resolves while the send
hangs; all four branches return an identical message), not a restated constant.

> **This is the model.** "A response-equality test per oracle" means a test
> shaped like this one, not a test that re-states a limit.

**The REST mistakes:** `404` for unknown vs `200` for found. A per-branch error
code. Any `await` of a send. A distinct `429` body — harmless today because
`THROTTLED_MESSAGE` is code-independent, and it must stay that way.

---

### 1.4 Chip and DNI

**DNI: still unthrottled.** `verify-dni.ts:126` says so in its own comment, and
the only caller adds nothing but `requireUserOrRedirect`. The mitigation is
message-collapse only — the unique-violation branch and the generic branch
return the *same* string (`:135-143`).

> **The one-line REST mistake:** return a distinct `dni_taken` code. That is the
> obvious REST instinct and it reopens the oracle immediately.

**Chip: two things, not one.** `lib/infra/chip-lookup.ts:27-30` —
`lookupByChip` is a pure DB lookup with **no auth and no limiter, by design**;
callers gate it. Exactly one caller does: `lookup-pet-for-denuncia.ts:46` at
`60/min + 200/hr` per IP, and when throttled it returns `{found:false}` — so
throttled is indistinguishable from not-found.

**The REST mistake:** call `lookupByChip` from a handler because it is the clean
framework-free function. That is an unthrottled national chip oracle in one
import.

---

### 1.5 Upload validation

`lib/infra/uploads.ts`. **Two of the three properties are universal; one is
not** — RN-1 lists all three as flat facts.

- **Magic bytes: universal.** `detectRasterMime` (`:27`) sniffs JPEG/PNG/WEBP
  signatures; `file.type` is explicitly never trusted (`:127-131`). `MAX_BYTES = 5MB`.
- **No SVG: universal**, by whitelist construction (`:9-13`).
- **sharp re-encode: BUCKET-CONDITIONAL.** `PUBLIC_REENCODE_BUCKETS = new Set(["pet-photos"])`
  (`:19`). Only that bucket always re-encodes, and it fails **closed** on a sharp
  error. Every other bucket re-encodes only if the caller passes
  `stripMetadata: true`, and on a sharp error falls back to **the original
  attacker-supplied bytes** (`:172-174`).

The storage key is derived from the validated MIME plus `randomUUID()`, never
the client filename (`:143-147`).

**The REST mistake, and RN-1 is right about it:** native uploading
direct-to-storage with a signed URL loses all three at once. No
`createSignedUploadUrl` exists anywhere today — every signed URL in the repo is
a *download*. Keep it that way, or replicate all three server-side first.

> **Updated 2026-08-28 — the second branch is now taken, for one destination.**
> `POST /api/v1/pets/{token}/photo` is the first `createSignedUploadUrl` in the
> repo, and it does NOT point at `pet-photos`. It points at `uploads-staging`
> (migration 0206): private, deny-all to caller roles, `file_size_limit` and
> `allowed_mime_types` set on the bucket so the two limits a bearer capability
> could otherwise ignore are enforced by the object store rather than by us. A
> second, re-authorized `confirm` command fetches the staged bytes and runs all
> three properties over them — `lib/media/validate.ts`, which is where
> `detectRasterMime` and the sharp re-encode moved so ONE copy serves both the
> `File`-shaped Server Action path and the `Buffer`-shaped route path — before
> writing a normalised copy into `pet-photos`.
>
> So the sentence above still holds as written: a signed URL pointed at a public
> bucket is still the mistake, and this is the "replicate all three server-side
> first" branch rather than an exception to it.
>
> **What did NOT change**: the two frozen `bucket_id`-only INSERT grants on
> `pet-photos` and `event-attachments` (§ `check-storage-write-policies.ts`).
> Closing them needs the ~30 Server-Action upload sites to move onto this
> primitive, which is a separate change and a much larger one. The primitive now
> exists; the migration of the callers has not started.

---

### 1.6 The `/api/v1` client-surface families — carrier NAT, part 3

`lib/infra/api-v1-limits.ts`. Landed **2026-08-26 (WU-EAS-2)** over
`app/api/v1/me/**` and `app/api/v1/localities/**`.

| | |
|---|---|
| **Enforced at** | each route, by hand, as its own bucket literal — the ceilings come from the shared module, the bucket names do not |
| **Direction** | **Fail-open**, every one of them, unchanged |
| **Pinned by** | `__tests__/api-v1-rate-limit-families.test.ts` (family map ⇄ source, both directions, with a non-vacuity floor of 18 buckets) plus each route's own limiter cases |

**The finding.** §1.1 re-derived the ANONYMOUS credential surface against
Argentine carrier NAT and left the authenticated one alone. `app/api/v1/me/pets`
had said so in writing since it landed — "mobile carriers put hundreds of
subscribers behind one CGNAT address … re-keying the surface buckets is tracked
separately (B13) and **must move `/me` and this endpoint together**". This is
the together half, and the ceilings left the route files precisely because a
number that must move with a sibling cannot live in a literal next to one of the
two siblings.

**The derivation is NOT §1.1's.** That one plans for 1.000 subscribers per public
IPv4, because anyone with a camera can open `/p/{token}`. On an authenticated
surface only account holders are callers, so the figure is *subscribers per
address × app adoption* — and the adoption number (10%, i.e. 100 clients per
gateway) is a guess about an unlaunched product, stated in the module instead of
buried in its result. It is the first thing to re-derive when there is telemetry.

| family | routes | per-IP, before → after | per-user |
|---|---|---|---|
| `authenticated-read` | `/me`, `/me/pets`, `/me/transfers` GET, `/me/caretaker-grants` GET | 60/min · 600/hr → **600/min · 6.000/hr** | 120/min · 1.200/hr — **`/me` had none at all** |
| `authenticated-write` | `/me/transfers` POST, `/me/caretaker-grants` POST | 20/min · 120/hr → **120/min · 1.200/hr** | 10/min · 40/hr · 100/day (unchanged) |
| `account-security` | `/me/revoke-sessions` POST | 30/min · 120/hr → **60/min · 240/hr** | 5/min · 20/hr · 40/day, inside the use-case (unchanged) |
| `public-reference` | `/localities` | 60/min · 600/hr → **600/min · 6.000/hr** | none available — no identity to key on |
| `pet-disclosure-write` | `/pets/{token}/shares` POST, `/pets/{token}/lost` POST | 20/min · 120/hr → **180/min · 720/hr** | 15/min · 60/hr · 200/day (unchanged) |
| `pet-record-write` | `/pets/{token}/events` POST | 30/min · 200/hr → **240/min · 960/hr** | 20/min · 80/hr · 300/day (unchanged) |
| `pet-registration` | `/pets` POST | 30/min · 120/hr → **120/min · 360/hr** | 10/min · 30/hr · 60/day (unchanged) |

The first five rows landed with WU-EAS-2 on 2026-08-26; the last three, plus the
ten `pets/**` buckets folded into the first two rows, landed on 2026-08-27 — see
§1.6b. `inbox-state` (`/me/notifications` POST, 240/min · 2.400/hr against a
per-user 20/min · 200/hr) arrived with WU-Q-1 between the two and was missing
from this table until the second pass; the fence has always had it.

**The table is that migration's snapshot, not the inventory.** Doors that landed
afterwards join a family without earning a row here — `API_V1_IP_BUCKET_FAMILIES`
in `lib/infra/api-v1-limits.ts` is the list that cannot lie, and
`__tests__/api-v1-rate-limit-families.test.ts` pins it against the routes in both
directions. The newest one is named in prose because its family choice is the
neighbouring one being rejected rather than a default being taken:

- **`POST /api/v1/me/identity`** — signup step 2, in the app (PO 2026-09-05).
  Buckets `api_v1_me_identity_ip` (`authenticated-write`) and
  `api_v1_me_identity_user` (that family's per-user ceiling). NOT
  `account-security`, which is the tempting neighbour — a `/me` write, once per
  lifetime, on your own account. That family's derivation is the FAILURE MODE
  ("you cannot sign out of the phone you lost", "you cannot exercise a legal
  right"), not the shape; at the moment somebody does this it is one person in a
  two-field form who may well tap Guardar again, which is the `me/profile` anchor
  exactly.
- It is also **the one authenticated door a `profilePending` caller may use.**
  `/api/v1/pets` answers `identity_pending` for that state and
  `/api/v1/me/profile` answers `not_found` on both halves; both are right, and
  copying either into this route would refuse the only callers it exists for. The
  rules those gates protect are run by the writer instead
  (`completeIdentityForUser`), against the value being stored — including the
  refusal, `identity_name_provisional` (422), for a name that would leave the
  caller pending anyway.

**Two different rules produced those numbers, and mixing them up is the mistake
to avoid.** The read families are sized against a *push-broadcast burst* (half a
gateway's app-holders opening within the same minute). Every write family is
sized as **`API_V1_SIMULTANEOUS_CALLERS` × its own per-user ceiling** — twelve
callers, the same twelve `LOGIN_SIMULTANEOUS_CALLERS` and
`PASSWORD_RESET_SIMULTANEOUS_CALLERS` use — so the USER bucket stays the binding
constraint: at the old 20/min, two people at their individual ceiling exhausted a
whole gateway, which put the refusal in the bucket with no reasoning behind its
number. **Each write family has its own anchor, which is why there are five of
them and not one**: the per-user ceilings are 10, 15, 20 and 5 per minute, and a
single shared IP ceiling would be twelve callers for one of them and two for
another. `authenticated-write` is the one exception to the flat twelve — its
hourly side is 30× rather than 12×, because its per-user hourly cap is
deliberately far below a sustained per-minute rate and carrying 12× onto both
windows would propagate that narrowing into the IP ceiling. The fence pins both
multiples separately for exactly that reason.

**What it gives up, stated rather than hidden.** These per-IP buckets run BEFORE
the GoTrue round-trip — that is their job — so 600/min is 600 `auth.getUser()`
calls a minute one address can force with well-formed but invalid tokens. Three
things bound that and none is the IP bucket: a request with no parseable
`Authorization` header never reaches the limiter (the header regex runs first, by
design), a valid token is bounded per-account by the user bucket, and 10 req/s
sustained from one address is the platform's DDoS layer's problem — the same
conclusion §1.1 reached, not a stronger one just because this endpoint costs more.

**The aggregate.** `API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE` is **computed**
from `API_V1_IP_BUCKET_FAMILIES`, and this paragraph deliberately does not
restate it. It used to: “5 × 600 + 2 × 120 + 60 = **3.300/min** per IP across
these eight buckets”, which WU-Q-1 made wrong the moment two buckets landed and
which stayed wrong here while the constant tracked the surface. That is §1.1
happening a third time, in the paragraph that exists to state the figure
honestly. **Read the constant.** Since 2026-08-27 it covers every per-IP bucket
the surface spends, because nothing sits outside it any more.

#### 1.6b The ten that stayed behind — closed 2026-08-27

Ten sibling per-IP buckets under `app/api/v1/pets/**` stayed on the older
ceilings, because WU-EAS-2's scope was `me/**` and `localities/**`. The
consequence was written down here at the time and not softened: *a native client
cold-launches at 600/min on `/me` and `/me/pets`, taps a pet, and lands on 60/min
at `/pets/{token}` — same phone, same gateway, one screen later.*

**The trigger for closing it was the app going live.** On 2026-08-27 the Android
build reached Play internal testing and real testers began installing it on
Argentine carrier networks — the same day and the same reason `LOGIN_IP_LIMIT`
moved. The burst the 600 was sized for (a barrio-wide lost-pet alert, fifty people
behind one carrier gateway opening the app at once) does not stop at the home
screen; what those fifty people do next is tap the pet.

**It is not one derivation, and that is the finding.** The full argument is in the
header of `lib/infra/api-v1-limits.ts`; the shape of it:

- **None of the ten is public.** Every one sits in a handler that calls
  `createClientFromBearer` then `requireLiveUser`, and nine of the ten then call
  `resolvePetHolderAccess` (registration cannot — the pet does not exist yet). The
  anonymous credential surface is a different route with its own file and its own
  1.000-subscribers derivation; it was raised in B13 and never was one of the ten.
- **The five READS were the authenticated-read family's numbers all along.** Their
  own docblocks said so — “identical ON PURPOSE … so one number bounds both” — and
  the family moved without them. They now spend the family constants, per-user
  included, which is the same pair of numbers stated once instead of five times.
- **The five WRITES do not share an anchor, so they did not all land on one
  ceiling.** `api_v1_amend_ip`'s per-user anchor *is* the authenticated-write
  family's, to the digit, and the act is the same class, so it joins that family.
  The two disclosure writes share an anchor with each other and nothing else. The
  asiento and the registration each keep theirs. Every one of the five was upside
  down before: the tightest was one and a third owners at their own per-user
  ceiling, for a whole carrier gateway.
- **`api_v1_pets_register_ip` was a second, sharper cliff.** `/api/v1/localities`
  was raised to 600/min *for a plaza registration drive*, while the registration
  that typeahead feeds sat at 30/min · 120/hr — four accounts per gateway per hour.

**What the raises cost, checked rather than asserted.** In all ten handlers the
ordering is: header regexes (free) → per-IP bucket → GoTrue → per-user bucket → DB
access guard. **No route reads the database before authenticating**, so no raise
widens an unauthenticated read of anything; what each buys a caller holding a
well-formed but invalid token is more `auth.getUser()` round-trips from one
address, the cost §1.6 already states for the read family at 600. One exception is
named because its docblock claimed a second job: `api_v1_pets_register_ip` was
said to bound “a scripted farm running from one host”. The binding constraint on
that farm is `auth_signup_ip`, upstream and far tighter, whether this endpoint
allows 120/hr or 360/hr.

> **The multiple moved a window down on 2026-08-29, and the conclusion did not.**
> This paragraph read “3/min · 15/hr, deliberately unchanged — fifteen accounts an
> hour is fifteen pets an hour … eight times tighter”, an *hourly* comparison,
> which was the only kind available while every auth bucket had only short
> windows. `signup-limits.ts` re-derived that bucket into a burst allowance under
> a per-**day** ceiling, because a pet farm is bounded by its yield and not by its
> best hour. Signup now allows 360 accounts per address per day; this endpoint has
> no daily bound (360/hr = 8,640/day).
>
> **Said completely, because only one window improved.** Signup measured against
> `api_v1_pets_register_ip`, before → after:
>
> | window | before | after |
> |---|---|---|
> | per minute | 3 vs 120 — 40× tighter | 60 vs 120 — **2×** |
> | per hour | 15 vs 360 — 24× tighter | 180 vs 360 — **2×** |
> | per day | 360 vs 8,640 — 24× tighter | 360 vs 8,640 — **24×** |
>
> Both short windows collapsed to 2×; only the day held at 24×. Quoting “24×
> instead of 8×” and stopping would pick the one window that improved. The
> conclusion survives on the ground it always stood on — a farm needs an account
> per pet and is bounded by its daily yield — and signup binds it at the *same*
> 360 pets a day the old 15/hr already yielded over 24 hours. Short-window
> headroom, however, is now 2× and not 24×.

**The family `pre-cgnat` is now `route-local`, and it is empty.** It meant
“knowingly left on the pre-B13 ceiling”; nothing is, so the name described an
empty set. `route-local` names the mechanism instead — a bucket whose route hands
the limiter its own literal — which is what the fence infers from a call site. The
fence asserts it stays empty, so a new per-IP bucket cannot be filed under
“somebody decided” without a derivation: the fix is a family and an argument in
`api-v1-limits.ts`.

---

## 2. The response envelope — ratified, not invented

**A convention already exists** across the handlers under `app/api/**` (34 when
this was written; 35 with the first `/api/v1` route). Track 2 adopts it rather
than inventing a shape the rest of the codebase does not speak.

```ts
// error
NextResponse.json({ error: "snake_case_code" }, { status })
// success — the bare payload, plus an explicit no-store
NextResponse.json(payload, { headers: { "cache-control": "no-store" } })
```

Codes in use today: `forbidden`, `unauthorized`, `not_found`, `rate_limited`,
`missing_province`, `unknown_layer`, and six `*_unavailable` degradation codes.

**Two existing deviations — do not copy either by accident:**

- `app/api/health/route.ts:71` returns `{ status: "rate_limited" }` — `status`,
  not `error`.
- `app/api/panorama/kpis/route.ts:114` merges the error key **into** the payload:
  `{ error: "panorama_kpis_unavailable", ...degradedPanoramaKpis() }` at 503.
  Read this one as a **prototype of the per-section degraded contract**, not as
  a mistake. It is the closest thing in the repo to what Track 2 needs.

**Guard shape to copy:** `app/api/gob/_guard.ts` and `app/api/panorama/_guard.ts`
are deliberate near-duplicate siblings returning
`{ok:true, actor} | {ok:false, response: NextResponse}`, both capping at
`120/min` keyed on `profile.id`. `lib/supabase/bearer.ts:77-80` already contains
the bearer variant's recipe.

**Correction to RN-1:** its improvement #2 says no bearer client exists. One
does — `lib/supabase/bearer.ts`, landed the same day as the review. It uses the
ANON key deliberately (`:24-27`). Do not re-do that work.

---

## 3. The error vocabulary — the real cost of wrapping use-cases

**No shared vocabulary exists to adopt, and three casings are already in play.**

| Source | Casing | Example |
|---|---|---|
| `packages/contract/src/input/intake.ts:108` | `SCREAMING_SNAKE` | `NAME_REQUIRED` |
| `lib/infra/live-user.ts:59` | `SCREAMING_SNAKE` | `NO_SESSION`, `ACCOUNT_ERASED` |
| `lib/infra/pet-access.ts:120` | `kebab-case` | `not-found-or-forbidden` |
| `app/api/**` | `lowercase_snake` | `not_found` |

And the one that actually hurts: **`UseCaseResult`'s failure arm is an untyped
`string`** — in all **ten** module copies (adoption, caretakers, decomiso,
events, foster, organizations, pets, surveillance, transfers, welfare).

```ts
// src/modules/events/application/types.ts:23-25
| { ok: false; error: string }
```

**Three different things travel in that one field**, with nothing in the type to
tell them apart:

| Shape | Example | Where |
|---|---|---|
| Spanish user-facing prose | `"No pudimos finalizar la adopción: …"` | most modules |
| `snake_case` codes | `not_found`, `report_not_found`, `untriaged` | `welfare`, `pets` |
| A raw `err.message` | whatever the driver threw | custody-disputes, auth |

An earlier draft of this document said "a Spanish user-facing string, in all
seven module copies". Both halves were wrong; the count was verified by
`rg 'export type UseCaseResult'` and the shapes by reading the returns. The
correction matters because it changes the remedy: this is not a translation
problem, it is a **missing discriminant**.

**The pattern to copy already exists in this repo.**
`src/modules/welfare/application/add-reporter-comment.ts:50` narrows the arm to
a typed union of codes:

```ts
| { ok: false; error: "forbidden" | "validation" | "no_case" | "report_not_found" | "db_error" }
```

That is the shape the other nine should converge on — it costs nothing at the
call site and it is the only version a native client can branch on.

Every write use-case returns prose a native app cannot branch on and cannot
translate. This is the single largest hidden cost in "just wrap the existing
use-cases in `/api/v1`", and it is invisible until the first write endpoint.

> **DECIDED (§8, D2).** `lowercase_snake`, in `packages/contract` — the casing
> all 34 existing handlers already emit, in the only place a native client can
> import from. The SCREAMING_SNAKE and kebab-case islands stay put; converting
> them is mechanical and must not gate the first endpoint.

---

## 4. `Cache-Control: no-store` is NOT inherited

```ts
// lib/infra/public-cache-policy.ts
const NO_STORE_PREFIXES = ["/p/", "/libreta/compartir/", "/adoptar", "/casos/",
                           "/denuncias/codigo/", "/denuncias/seguimiento"];
```

`middleware.ts:227-229` stamps no-store when the pathname matches. **`/api/v1/...`
matches nothing in that list.**

The privacy class this closed on 2026-07-07 was real: a revoked share and a
found pet were being served stale from the CDN at the exact shared URL. A JSON
endpoint reopens it unless it sets the header per-response, which is what the
gob and panorama handlers already do by hand.

**Checklist line:** every `/api/v1` response that carries pet, case, denuncia or
share data sets `cache-control: no-store` explicitly. Do not rely on the prefix
list, and do not add `/api/` to it without deciding what that means for the
cacheable reads a native client would actually benefit from.

---

## 5. Per-section degraded contract

The point of Track 2, not a refinement of it.

Today a hung query fails soft into a blank section. A human reading a web page
correctly reads that as "something is missing". **A native client rendering the
same blank JSON presents it as a valid credential with no findings** — no
vaccines, no incidents, nothing to worry about.

Every section of a `/api/v1` read therefore reports its own state. A section
that could not be loaded says so; it never renders as empty. The existing
`degradedPanoramaKpis()` pattern (§2) is the working precedent.

The credential loader already has the shape for this: `<DegradedCredentialCard>`
exists at `app/(public)/p/[publicToken]/page.tsx:255,274-282`.

---

## 6. Envelope metadata

`payloadVersion`, `issuedAt`, `staleAfter` on every read, per TRACKS.md. These
are what let a native client cache honestly and what let the credential say
"this is what the server knew at 14:32" instead of implying live truth — which
matters directly for the offline decision (show without signature, say plainly
that it cannot be verified offline).

---

## 7. What a new route handler inherits — the honest table

| Mechanism | Inherited? |
|---|---|
| `middleware.ts` → `updateSession` + CSP | **Yes** — the matcher excludes only static assets |
| `scripts/check-api-guard-headers.ts` | **Yes** — derives header names from `middleware.ts` and scans every route handler (widened 2026-08-21) |
| `Cache-Control: no-store` | **No** — path-prefix allowlist |
| `scripts/check-authz-guards.ts` | **Yes** — its coverage rule scans every `app/**/route.ts` (widened 2026-08-21, D4): each exported handler calls a guard, or carries a `@no-auth-required: <reason>` |
| `public-token-throttle-coverage` | **Only via `publicPetByToken`** — a handler that resolves a token another way is invisible to it. A handler that goes through `lookupPublicCredential` is covered by the fence's SECOND layer instead: every caller of the door must pass `throttle: publicTokenThrottle("<literal>")` naming a known bucket |
| `scripts/check-db-budget.ts` | **Yes, since 2026-08-21** — `ROUTE_GLOBS` gained `app/api/v1/**/route.ts`, so every `/api/v1` handler is a registered heavy call site and must CALL a budget wrapper **or be a named `DELEGATING_ROUTES` entry** (`scripts/check-db-budget.ts:292`) whose `budgetedBy` collaborators really are budgeted (checks 1-7 of that docblock). The first endpoint uses the escape hatch, not the wrapper: `app/api/v1/pets/[publicToken]/credential/route.ts` is registered there because its only DB work belongs to `lookupPublicCredential` and the throttle adapter, both of which budget themselves |
| Any rate limit | **No** — every one is a per-call-site `enforceRateLimit()` |

**Both structural gaps on this list are now closed** (`check-api-guard-headers`
and `check-authz-guards`, same day; `check-db-budget`'s scope followed with the
first endpoint). What a `/api/v1` handler still does NOT inherit is a rate limit
and `no-store` — both remain per-call-site, and §9 is where they are checked.

Two things about the authz coverage rule a new handler should know. Cron-secret
checks (`authorizeCronRequest` / `checkCronSecret`) count as authorization for a
**route handler only**, never for a server action — proving a trusted scheduler
called you leaves "who is acting" unasked, and an action is reached from a
logged-in browser. And the rule reads `export async function GET(…)`: every
other export shape is *reported*, not skipped — a shape that still names a
method (`export const GET = withX(handler)`, `export { handler as POST }`, a
non-async `export function DELETE(`) as an unreadable export shape, and a shape
that names none (`export const { GET, POST } = handlers`, `export * from
"./impl"`) as a file that yields no readable HTTP method at all. The second half
was added 2026-08-21 after a review measured that both nameless shapes produced
zero functions, zero offenders, and a file reported as authorized.

**What that claim does and does not cover.** No *export shape* can make a
handler invisible to the fence — that is the precise version of the statement.
It is not a claim that a handler can never pass unauthorized: the analysis is
regex-based and `scripts/lib/strip-comments.mjs` deliberately KEEPS string and
template-literal contents (a token inside a string can be real emitted markup,
so blanking them would blind the sibling fences to genuine violations). A
handler whose body merely contains the text `requireUser(` inside a string
literal therefore counts as guarded. That is a stated blind spot — the linter's
own header says so — with zero occurrences today. It is one of two remaining
ways past the coverage rule, not the only one: the brace walker in
`extractExportedAsyncFunctions` also counts braces inside string literals, so an
unbalanced `{` in a string makes an unguarded handler swallow its guarded
neighbour's body and read as guarded. Also zero occurrences today (every live
handler body was swept on 2026-08-21), also a consequence of keeping strings.

---

## 8. Open decisions

**All four are now decided.** Two were the PO's (D1, D3 — taken 2026-08-21,
both the recommended option); two were engineering calls made here and recorded
so they are visible rather than silent (D2, D4). Nothing in this document is
waiting on anyone.

Each entry keeps its counter-argument. A decision whose downside was never
written down is one nobody can revisit on purpose.

### D1 — throttle bucket for `/api/v1/p/{token}` · **DECIDED 2026-08-21 (PO)**

**Its own bucket: `public_token_api_credential`.**

It follows the rule already in force and its stated reason — a client hammering
the API must not starve the person loading the credential in the street. The
additive ceiling is the price of that isolation, and it is already being paid
four times over.

**That ceiling, kept current** (this line was written pre-B13 and said
"240 → 300/min"; both halves of B13 have since landed):

| when | per-IP aggregate across all token-resolving surfaces |
|---|---|
| before B13 | 5 × 60 = 300/min |
| B13 part 1 — API bucket raised | 4 × 60 + 600 = 840/min |
| B13 part 2 (2026-08-25) — HTML surfaces raised | 5 × 600 = 3.000/min, 30.000/hr |
| the adoption ficha joins (2026-08-25) — §1.1b | 6 × 600 = **3.600/min**, 36.000/hr |

**The counter-argument was put to the PO and knowingly declined:** at some
number of surfaces "N per surface" stops being a limit, and raising N made that
truer rather than less true. If the aggregate ever matters more than the
isolation, the fix is NOT a shared bucket — it is a second, aggregate limiter
keyed per IP across all token reads, layered on top. That remains available as a
separate change and must not be smuggled into an endpoint. What keeps it
acceptable meanwhile is the corrected §1.1 arithmetic: 3.600/min still leaves a
single-IP walk of the 31^8 space at ~2.700 years, and a distributed walk was
never bounded by any of these numbers.

**What this obliges:** the new bucket name goes in the coverage fence's expected
set like the other four, and §9's checklist line "bucket named" is satisfied by
`public_token_api_credential`, nothing else.

### D2 — error-code casing and home · **engineering, decided**

**Decided: `lowercase_snake`, in `packages/contract`.** Reasons: it is what all
34 existing handlers already emit, so `/api/v1` is consistent with the surface a
native app also talks to; and `packages/contract` is the only place a native
client can import from. The `SCREAMING_SNAKE` and `kebab-case` islands stay
where they are — converting them is a separate, mechanical change that should
not gate the first endpoint.

**The real work this exposes is not the casing** — it is that `UseCaseResult`'s
failure arm is Spanish prose (§3). That needs its own change, and the first
`/api/v1` **write** endpoint is blocked on it. Reads are not.

### D3 — which limit `/api/v1` matches · **DECIDED 2026-08-21 (PO)**

**Per-lookup, atender-style.** Not `gob/mascotas`'s aggregate-only `120/min`
per profile.

An aggregate-only limit bounds how fast one account works, not how much of the
national token space it can enumerate — and enumeration is the threat the whole
oracle list (§1) exists for. An account can walk the padrón slowly and hit no
ceiling at all.

**The accepted cost:** a legitimate high-volume integrator will hit it. That is
a conversation about issuing them a scoped credential, which is a better
conversation to have than an unbounded default — and it is a conversation that
only happens if the limit exists.

> **AMENDED 2026-08-25 (B13).** The SHAPE of the decision stands — per-lookup,
> keyed `${token}:${ip}`, not aggregate-only. The NUMBERS do not: copying
> atender's `{20/min, 100/hr}` copied a limiter calibrated for an
> organization's staff on office IPs onto a surface whose caller is a phone
> sharing one public IPv4 with ~1,000 neighbours. The accepted cost above turned
> out to include the finder standing over a lost animal, which was never the
> intent. Now `{120/min, 1_200/hr}` — still a fifth of the surface ceiling in
> both windows, so it remains the tight one. Arithmetic in `limits.ts`.

**What this obliges:** `/api/v1` credential reads carry a per-resolution
limiter, not only the guard's aggregate cap. It also makes
`app/api/gob/mascotas/[token]/route.ts` the odd one out — it resolves a pet
token under the aggregate cap alone (§1.2). Bringing it in line is a follow-up,
not a blocker, but it should not be cited as precedent for new routes.

### D4 — `check-authz-guards.ts` over `app/api/**` · **LANDED 2026-08-21**

**Decided: before the first endpoint.** Widening a fence over an empty
directory is free; widening it over a directory that already has routes means
auditing each one by hand first. The same widening over
`check-api-guard-headers.ts` on 2026-08-21 surfaced five call sites the moment
it ran — all benign, but each needed reading. Doing that once, at zero, is the
cheap moment.

**Landed 2026-08-21**: the coverage rule now scans every `app/**/route.ts`
handler (`listRouteHandlerFiles`, floor `MIN_ROUTE_HANDLER_FILES = 40`). It was
47 handlers when the fence widened — 41 authorizing, 6 carrying a written
`@no-auth-required` reason (`/api/health`, the two `denuncias/seguimiento`
endpoints, the open-data download, and both auth callbacks). The first `/api/v1`
route made it **48 handlers, 7 opt-outs**, and it is the only one of the seven
whose publicness is the PRODUCT rather than a protocol requirement — the other
six are an OAuth callback, a cookie exchange, a health probe and an open-data
download. The list is pinned in `__tests__/check-authz-guards.test.ts:890`, so
an eighth is a decision that surfaces in review rather than a diff nobody reads.

---

## 9. Merge checklist

A `/api/v1` route handler is not ready until every line has an answer.

- [ ] Rate-limited, with the bucket named and the direction (open/closed) stated.
- [ ] `cache-control: no-store` set explicitly if it carries pet, case, denuncia or share data.
- [ ] Errors use the `{ error: "snake_case" }` envelope and a code from the agreed vocabulary.
- [ ] Every section reports its own availability; nothing degrades to a silent empty.
- [ ] `payloadVersion` / `issuedAt` / `staleAfter` present on reads.
- [ ] Success and failure are indistinguishable wherever an oracle exists (§1.3 is the reference test shape).
- [ ] If it resolves a public token, `publicPetByToken` is the door — so the coverage fence can see it.
- [ ] If it resolves a chip or a DNI, it carries its own limiter; `lookupByChip` and `verifyDni` bring none.
- [ ] If it accepts an upload, it goes through `lib/infra/uploads.ts`. No signed upload URLs.
- [ ] A response-equality test exists for each oracle the route touches.
- [ ] It answers ONLY through `apiV1Json` / `apiV1Error` (`lib/infra/api-v1.ts`) — never `NextResponse.json(`, `new NextResponse(`, `new Response(` or `Response.json(` — so lines 2, 3 and 5 are properties of the helper, not of the author. Reads build their envelope with `apiV1Envelope`. (2026-08-22)
- [ ] If it MUTATES, it accepts an `Idempotency-Key` header and replays the first outcome for a repeated key. **No precedent yet** — the first write endpoint sets the shape; a native client on a flaky link retries, and a retry that creates a second custody transfer is not a retry.
- [ ] Cross-origin / bearer: **PO decision #2 is taken — a bearer API, never native-direct-Supabase** (`dim-interno:docs/reviews/native-readiness/SYNTHESIS.md`). **BEARER LANDED 2026-08-25 (WU-A)**: `GET /api/v1/me` is the first caller of `createClientFromBearer`, and it resolves identity STRICTLY from the `Authorization` header — `createClientFromBearer` → `requireLiveUser({ supabase })`, no cookie fallback, 401 + a code instead of a redirect. An authenticated `/api/v1` route copies that chain; it does not invent a second one. **CORS is still not implemented, and now deliberately so rather than pending**: a native `fetch` does not preflight and sends no `Origin`, so `Access-Control-Allow-*` on these routes would buy nothing and would open the password grant to any web page in a browser. A route that needs it lands the shared preflight as its own change, when a real cross-origin *web* consumer exists.

**Fences that check this list** (each runs in `pnpm verify` and in CI —
`lint:ci-parity` keeps the two equal):

| Fence | Lines it checks |
|---|---|
| `pnpm lint:api-v1` — `scripts/check-api-v1-envelope.ts` | the helper line above (no hand-built responses, helper imported); a LITERAL bucket for `publicTokenThrottle(` and for `perLookup.bucket` (line 1, G4); authorized or `@no-auth-required: <reason>` (reuses `lint:authz`'s handler rule). Non-vacuity floor: ≥1 `app/api/v1/**/route.ts`. RED controls in `__tests__/check-api-v1-envelope.test.ts` |
| `pnpm lint:authz` — `scripts/check-authz-guards.ts` | every exported handler calls a recognised guard or carries a justified opt-out; since 2026-08-22 also that no file DEFINES a function named like a guard (`findShadowedGuardDefinitions`) |
| `pnpm lint:api-headers` — `scripts/check-api-guard-headers.ts` | no handler reads a middleware-stamped header |
| `pnpm lint:db-budget` — `scripts/check-db-budget.ts` | the handler calls a budget wrapper or is a registered delegating route |
| `__tests__/public-token-throttle-coverage.test.ts` | every caller of `lookupPublicCredential` hands over `publicTokenThrottle("<literal>")` from `KNOWN_BUCKETS`, and (G4) a `perLookup.bucket` literal from `KNOWN_LOOKUP_BUCKETS` |

Lines with no fence: per-section availability (§5), the envelope fields on
reads (§6 — `apiV1Envelope` makes it easy, nothing makes it mandatory), the
response-equality tests, Idempotency-Key, CORS/bearer. They are checked by the
reviewer reading §10's table for the new route.

---

## 10. The first endpoint — where each checklist line is answered

`GET /api/v1/pets/{publicToken}/credential`, landed 2026-08-21. This section
exists so the next endpoint has a worked example instead of ten questions, and
so §9 can be audited against code rather than against a claim.

Files:

| | |
|---|---|
| Handler | `app/api/v1/pets/[publicToken]/credential/route.ts` |
| Projection | `app/api/v1/pets/[publicToken]/credential/payload.ts` |
| Wire types | `packages/contract/src/api/public-credential.ts`, `packages/contract/src/api/errors.ts` |
| Tests | `__tests__/api-v1-credential-route.test.ts` |

| # | Checklist line | Satisfied at |
|---|---|---|
| 1 | Rate-limited, bucket named, direction stated | Both limiters arrive through ONE port at `route.ts:171-180`: the surface bucket (`public_token_api_credential`, 600/min + 6.000/hr per IP since B13) as the adapter's literal first argument, and the per-lookup bucket (`public_token_api_credential_lookup`, 120/min + 1.200/hr, keyed `${publicToken}:${ip}` — constants in `limits.ts`, imported by the route) as its `perLookup` option. Ordered SURFACE FIRST inside the adapter (`lib/infra/public-token-throttle.ts`), so a caller the surface limit already refused costs the table zero rows. **Both fail OPEN**, stated at `route.ts:70-74`. Proved by `api-v1-credential-route.test.ts:293` (the 429 path), `:446,:454` (the order, and that a throttled IP writes no per-lookup counter) |
| 2 | `cache-control: no-store` set explicitly | The route no longer owns a private `credentialJson()` helper — `route.ts:104` imports the shared `apiV1Json`/`apiV1Error` (`lib/infra/api-v1.ts`), whose `MANDATORY_HEADERS` (`:40-43`) set `cache-control: no-store` on every response, applied last so no caller override can undo it (`:58-62`). `pnpm lint:api-v1` (`scripts/check-api-v1-envelope.ts`) refuses any `/api/v1` route that builds a response by hand, so "no branch can forget it" is a property of the fence now, not of one file's private helper (route.ts:135-144 records the move, dated 2026-08-22). Proved per-branch by `api-v1-credential-route.test.ts:555` (all five) |
| 3 | `{ error: "snake_case" }` from the agreed vocabulary | `route.ts:187` (`rate_limited`), `:194` (`not_found`), `:202-205` (the degraded 503 — the code is embedded in the JSON body via `apiV1Json`, set at `payload.ts:418`, not a separate `apiV1Error` call); vocabulary at `packages/contract/src/api/errors.ts:40` |
| 4 | Every section reports its own availability | `packages/contract/src/api/public-credential.ts:74` (`CredentialSection<T>`); degraded projection at `payload.ts:413-441`. Proved by `api-v1-credential-route.test.ts:356,:382` |
| 5 | `payloadVersion` / `issuedAt` / `staleAfter` | `payload.ts:106-115` (`credentialEnvelope()`, the three fields set at `:109-111`), shared by the success body (`:313`) AND the degraded body (`:419`). Proved by `api-v1-credential-route.test.ts:572,:585` |
| 6 | Success and failure indistinguishable where an oracle exists | `api-v1-credential-route.test.ts:618,:638,:964` — see the stance below |
| 7 | Resolves the token through `publicPetByToken` | via the door (`route.ts:171-180` → `lookup-public-credential.ts` → `publicPetByToken`). The coverage fence sees it through its door-caller layer, which requires the bucket to be a LITERAL at the call site — it rejected this file twice before it passed, and a third time when the adapter grew a second argument its regex could not parse |
| 8 | Chip / DNI carry their own limiter | N/A — this route resolves neither. It never reads `lookupByChip` or `verifyDni`, and the microchip NUMBER is not in the payload at all (`payload.ts:30-36`) |
| 9 | Uploads go through `lib/infra/uploads.ts` | N/A — read-only endpoint, `GET` is the only export |
| 10 | A response-equality test per oracle | `api-v1-credential-route.test.ts:618` (`not_found` vs `throttled`), `:638` (throttled is token-independent), `:964` (an ERASED pet answers exactly as a token that never existed) |

**The payload's own gates are tested, not just the HTTP mapping** (added
2026-08-21). `lostSectionOf` is the only place this endpoint discloses a
PERSON — a first name, a phone, an email, and where they last saw their animal
— and it had no test of its own, because every route test ran an ACTIVE pet for
which the whole section is `null` and every gate is unreachable.
`api-v1-credential-route.test.ts:661` now drives it from a maximal fixture
(every toggle on, no dispute) and turns exactly one thing off per case; `:835`
pins the key sets of the three whole-object pass-throughs, because TypeScript's
excess-property check does not fire on a variable and an upstream type that
grows a field would otherwise publish it silently. Both suites were proved to
BITE: deleting `&& !disputed` from the phone gate fails
`:725` with the owner's number in the diff.

**The oracle stance, written down because §1.1 asks for it.** This endpoint
discloses existence *exactly* as much as `/p/{publicToken}` already does and no
more: an unknown token gets 404, a live one gets 200, which is what `notFound()`
versus a rendered page already told anybody who asked. What the route adds is
that the three ways it could have leaked MORE are closed and tested:

- a **429 never varies** with the token, so the rate limiter cannot itself
  become the enumeration oracle it exists to prevent — and the two limiters
  return the same 429, so the RESPONSE (status, headers, body) says nothing
  about which budget ran out. That claim is bounded on purpose and the bound is
  stated because the earlier wording ("a caller cannot even probe which budget
  it exhausted") overclaimed: a caller who counts its own requests knows which
  limit it crossed without asking, and response TIMING is not equalised — the
  surface-only refusal skips a DB write the two-limiter path performs. Neither
  channel is closed here, and neither needs to be: the budgets are published in
  this document and in the handler's header. What must not leak is anything
  about the TOKEN, and that is what the equality tests assert;
- **`not_found` and `throttled` differ only in the status line and the error
  code** — same headers, same single-key body. This is where a `Retry-After`,
  an `x-ratelimit-remaining` or an echoed token would have shown up;
- a **soft-deleted (erased) pet is byte-identical to a token that never
  existed** (PO-4 / Ley 25.326 art. 16). The filter lives in the query, so an
  erased subject's row is never read into memory, and the erasure is not
  observable from outside.

**Deviation from the draft plan, recorded rather than silent.** The plan asked
for `Retry-After` on 429. It is NOT set, on either 429 branch. Only one of them
could carry an honest value — the per-lookup limiter throws `RateLimitError`,
which knows its `resetAt`, while the surface limiter arrives as a
boolean-returning port because a use-case may not import `next/headers` at all.
Setting it on one branch and not the other makes the two 429s distinguishable;
inventing a constant for both fabricates a hint. The 503 does carry one
(`route.ts:133,201-205`): it has no sibling branch to stay identical to, and
"the read failed, come back shortly" says nothing about a limiter window. When
the port can report a reset instant, both 429 branches get the header together.

**On the degraded arm: 503 WITH a partial body, not a bare error.** §5 says a
section that could not be loaded must say so and must never render as empty, and
§2 names `app/api/panorama/kpis/route.ts:114` — `{ error, ...degraded }` at 503
— as the prototype for exactly that. A bare `{ error: "temporarily_unavailable" }`
would hand a native client strictly less than the web already gets: the page
renders a `DegradedCredentialCard` with the animal's name and its aviso CTAs,
because those routes run their OWN reads and may still work. Answering the JSON
caller with nothing turns a partial outage into a total one for the client that
most needs the fallback.

**What the payload deliberately does NOT contain**, and this is the part worth
copying: the shape was derived from what `p/[publicToken]/page.tsx` RENDERS, not
from what the loader FETCHES. `CredentialViewData` carries the microchip number,
50 rows of vaccination history, the service-dog credential record and three
internal UUIDs — all of them fetched to derive one boolean or one badge. The
full exclusion list, one line of reasoning each, is the header of
`payload.ts:22-72`. Projecting the loader's return type would have published
every one of them.

---

## Provenance and known drift

Verified against code on 2026-08-21. Two numbers in the planning docs have
drifted and are not worth editing there, but should not be trusted:

- `TRACKS.md:222` says `p/[publicToken]/page.tsx` is 1,423 lines, and this
  paragraph said 1,452 when it was written. Both are stale: the loader moved out
  of the page on 2026-08-21 and `wc -l` reports **1,035** as of that date.
  `RN-1` says 1,450 in one place and 1,423 in another. This is the number in
  this document that rots fastest — measure it, never quote it.
- `RN-1:8` says 33 route handlers under `app/api/**`. There were **34** (25 of
  them crons) and 47 across all of `app/` when this was written; the first
  `/api/v1` endpoint made those 35 and **48**. `pnpm lint:authz` prints the live
  count on every run, so the number in this paragraph is the one that rots, not
  the fence.

- §10's file:line citations were re-verified 2026-08-22 against the *current*
  tree and several had rotted from refactors that landed after this section was
  written: `5fedf2b4` moved the per-lookup limit constants out of `route.ts`
  into `app/api/v1/pets/[publicToken]/credential/limits.ts`, and `892621be`
  replaced the route's private `credentialJson()` helper with the shared
  `apiV1Json`/`apiV1Error` in `lib/infra/api-v1.ts`. Both citations, plus the
  throttle-port line range, the error-code lines, the envelope-field lines, and
  `public-credential.ts`'s `CredentialSection<T>` line (54 → 74), are corrected
  above. §1.2's `atender-access.ts:43,236` also drifted to `:43,237` (one line
  inserted upstream) and is fixed at its own citation.

One thing could not be verified from the repo and needs a staging probe: whether
Next serves `/p/{token}/opengraph-image` as a fully dynamic per-request render in
production. It is DB-backed with a dynamic param and middleware stamps no-store
on it via the `/p/` prefix, so it should be — but "should be" is not a
measurement.
