# Mobile contract — two planes, one wire truth

> Snapshot: `c10f4ff03` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-02
> Verified against code on 2026-09-02 by writer A (opus subagent) · Status: reviewed
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

`apps/mobile` is an Expo / React Native Android client. It is not a second
implementation of the product: it is a second **consumer** of the same data,
through a surface that inherits almost none of the web's accidental protections.
This document states the boundary it talks across.

The rule to carry away first, because everything else follows from it: **the app
has two network planes, they point at different hosts, and confusing them
produces failures that read as anything but their cause.**

---

## 1. The two planes

`apps/mobile/src/config/api.ts` opens by naming them, and the file exists mostly
to keep them apart.

| | DATA plane | AUTH plane |
|---|---|---|
| **Talks to** | `/api/v1/*` on the Next.js origin | Supabase GoTrue, directly |
| **Constant** | `API_BASE_URL` (`apps/mobile/src/config/api.ts:50`) | `SUPABASE_URL` + `SUPABASE_ANON_KEY` (`apps/mobile/src/config/api.ts:70-71`) |
| **Credential** | a bearer token in the `authorization` header | the refresh token, in the device Keystore |
| **Client** | `apps/mobile/src/api/client.ts` | `apps/mobile/src/auth/supabase-auth.ts` |
| **Default when unset** | staging, because that is where the flagship demo pet lives | **none, deliberately** |
| **Carries** | pets, events, custody, credential, denuncias, turnos | token refresh, and nothing else |

### 1.1 Why the data plane is not PostgREST

This is PO decision #2, and the reason is written where the decision is enforced
(`apps/mobile/src/config/api.ts:19-28`): all but one of the
`ownerships`-derived RLS policies carry no role predicate, and the `pet_events`
INSERT policy checks neither role nor event type (RLS audit 2026-08-18, counted
in that comment). Reading pets over the anon
key would put the product's authorization on policies that do not express it.
So the data plane goes through route handlers where `requireLiveUser` runs.

`apps/mobile/src/auth/supabase-auth.ts:13-18` restates the boundary from the
other side: there **is** a Supabase client in a bearer-only app, it refreshes the
token, and nothing in the app calls `.from(...)` anywhere.

### 1.2 Why the auth plane is not proxied

A native client refreshing against GoTrue directly gets clock-skew handling,
collapsing of concurrent refreshes and retry for free — the one thing the SDK is
unambiguously better at than a hand-rolled endpoint. Proxying it would buy a
round trip and a second place to get the refresh-token rotation window wrong.
There is no `POST /api/v1/auth/refresh`, on purpose.

### 1.3 The crossed-planes fence

`planesLookCrossed()` (`apps/mobile/src/config/api.ts:142`) answers **not**
"are the two hosts the same" — in staging they are correctly different — but
"is one of them local and the other not". A build that crosses environments
signs in at staging, receives a token signed with staging's key, hands it to a
local GoTrue, and gets `invalid JWT: unrecognized JWT kid`. Because `setSession`
calls `_getUser` over the network before saving anything, the sign-in screen
reported a **device-storage** problem, and the incident was investigated as a
Keystore fault (measured 2026-08-30, written up at
`apps/mobile/src/config/api.ts:116-141`).

The related trap the same file guards is `??` on an env var: a variable that is
*defined but empty* is not nullish, so the empty string wins. The web already
paid for that once with a QR encoding a host-less relative URL. Every value here
is trimmed first and falls back on anything falsy
(`apps/mobile/src/config/api.ts:32-41`).

### 1.4 A verified token is not a proved address

`requireLiveUser` hands the data plane a `user.email` that GoTrue vouched for.
That vouching is about the **token**, never about the address inside it: an
account can be created with any address, and the token then carries it. Two
rules on this surface are addressee matches rather than principal checks — a
`pet_transfers` row and a `pet_caretaker_grants` row can both be addressed to
somebody who has no account yet, so they store an e-mail and the accept compares
it. Audit A09-1 (2026-09-02) found the consequence: knowing an invited address
was enough to register it and take titularidad.

Both surfaces now carry a second value beside the address,
`callerEmailConfirmed`, folded out of GoTrue's `email_confirmed_at`
(`lib/infra/live-user.ts`). The e-mail arm of the addressee rule refuses without
it; the id arm is unaffected. The list reads (`GET /api/v1/me/transfers`, `GET
/api/v1/me/caretaker-grants`) apply the same term, so an unconfirmed account is
never handed the `transferToken` / `grantToken` either.

**Premise, and its limit.** That guard only means something where the Supabase
project requires confirmation: with `enable_confirmations` OFF, GoTrue
auto-confirms at signup and stamps `email_confirmed_at` itself, so the column
carries no mailbox proof and the term degrades to always-true. It is a second
lock on the same door, not the setting's replacement — it closes the shapes a
project WITH confirmations on can still produce (an admin-created account, an
identity imported from a provider that did not verify the address). The setting
is currently **OFF by deliberate decision** on the remote projects
(`dim-interno:docs/design/handoffs/2026-07-07-deploy-checklist.md` §3, task #65: two-step
onboarding assumes a live session after step 1), so the day that decision is
revisited is the day this guard starts carrying weight. Nobody on this change
verified the live staging or production setting.

---

## 2. `packages/contract` — the wire truth

The package is framework-free by fence (`scripts/check-contract-purity.ts`): no
`next`, no `react`, no `drizzle-orm`, no `@/*` app imports, and one runtime
dependency (`zod`) confined to a single entry point. That is what makes it
installable by a React Native app.

| Entry point | Holds |
|---|---|
| `packages/contract/src/events` | `EVENT_TYPES` — the <!-- fact:event_types -->55<!-- /fact --> event types, and the payload vocabulary |
| `packages/contract/src/api` | the `/api/v1` wire shapes: `public-credential.ts`, `pets.ts`, `my-privacy.ts`, `pet-lost.ts`, `pet-shares.ts`, `welfare-report.ts`, `errors.ts` and their siblings — one file per resource |
| `packages/contract/src/input` | zod schemas for what a client may send; the **only** entry point with a runtime dependency |
| `packages/contract/src/links` | `deepLinkMap`, `deepLinkPath`, `deepLinkUrl`, the custom scheme, and the Android/iOS identifiers |
| `packages/contract/src/viz` | visualization scales — `viz-scales.ts` holds test-pinned colour constants that outrank any design handoff |
| `packages/contract/src/reference` | static catalogs (breeds, species) |
| `packages/contract/src/tokens`, `packages/contract/src/icons`, `packages/contract/src/notifications` | design tokens, profile icons, notification sort order |

Two properties are worth naming because the app depends on them:

- **Error codes are typed, not stringly.** `apiV1Error` on the server is typed
  against the contract's vocabulary, so a route cannot invent a code the client
  cannot import (`lib/infra/api-v1.ts:24-26`). The phone maps every code through
  one exhaustive switch in `apps/mobile/src/api/error-copy.ts`.
- **Identifiers have one home.** `ANDROID_PACKAGE_NAME` and
  `IOS_BUNDLE_IDENTIFIER` come from `packages/contract/src/links` into
  `apps/mobile/app.config.ts`, because the web app publishes the same package
  name in `/.well-known/assetlinks.json` and Android rejects any mismatch
  silently.

---

## 3. The envelope and the limiters — see `api-invariants.md`

`docs/architecture/api-invariants.md` is the merge-gating checklist for the
`/api/v1` surface and this document does not duplicate it. What a mobile reader
needs to know it exists:

- **One envelope, enforced by a fence.** `lib/infra/api-v1.ts` provides
  `apiV1Json` (unoverridable `cache-control: no-store`, explicit charset),
  `apiV1Error` (the single-key `{ error }` shape) and `apiV1Envelope`
  (`payloadVersion` / `issuedAt` / `staleAfter`). `scripts/check-api-v1-envelope.ts`
  refuses any v1 route that builds a response by hand. See §2 and §6 of
  `docs/architecture/api-invariants.md`.
- **Rate-limit families**, §1.6 of `docs/architecture/api-invariants.md`:
  `authenticated-read`, `authenticated-write`, `account-security`,
  `public-reference`, `pet-disclosure-write`, `pet-record-write`,
  `pet-registration`, `inbox-state`. Ceilings live in
  `lib/infra/api-v1-limits.ts`; bucket names stay at each route's own call site
  because the throttle-coverage fence requires a literal there.
  `__tests__/api-v1-rate-limit-families.test.ts` pins the family map against the
  source in both directions. The authenticated ceilings are derived from
  Argentine carrier-NAT assumptions **times an app-adoption guess about an
  unlaunched product** — stated in the module rather than buried, and the first
  thing to re-derive once there is telemetry.
- **The public credential surface** carries its own throttle, at
  <!-- fact:throttle_per_min -->600<!-- /fact --> per minute and
  <!-- fact:throttle_per_hour -->6000<!-- /fact --> per hour per IP, per bucket
  (`lib/infra/public-token-throttle.ts`). Every limiter on this surface is
  **fail-open**: a limiter error lets the request through.

### 3.1 The client's own layers

`apps/mobile/src/api/client.ts` splits transport from session on purpose.

- `performRequest` (`apps/mobile/src/api/client.ts:142`) answers only "did the
  server answer, and with what". It reads the transport and the body in separate
  `try` blocks, because a truncated body reported as "revisá tu conexión" sends
  someone to restart a router while the server is the problem.
- `apiRequest` (`apps/mobile/src/api/client.ts:238`) attaches the bearer, gates
  the payload version, and owns the session policy — stated once so no screen
  re-derives it:

| Response | Action |
|---|---|
| 401 `auth_expired` | refresh **once**, retry **once**; still 401 → sign out |
| 401 `session_shift_expired` | sign out immediately, **never** refresh — the refresh would succeed and the retry would be refused forever |
| 401 `auth_required` | sign out; our idea of "signed in" and the server's disagree |
| 403 `account_deactivated` / `account_erased` | sign out; the session is live and useless |

Outcomes are a union, not thrown errors, because most of them are normal
operation: a 429, a 404 for a token that resolves to nothing, a 503, a phone
with no signal. Folding them into one `catch` produces the "algo salió mal" copy
this product's per-section honesty exists to avoid.

**A `profilePending` session is signed in, and exactly one door accepts it.**
`GET /api/v1/me` and `POST /api/v1/auth/login` both answer
`MeV1User.profilePending: true` for an account that finished step 1 and nothing
else; `useGate` routes it to `identidad-pendiente`, and every other authenticated
endpoint refuses it (`/pets` with `identity_pending`, `/me/profile` with
`not_found`). The exception is **`POST /api/v1/me/identity`** — signup step 2,
moved into the app on 2026-09-05 because the browser handoff it replaces was
reading as "confirm your email" to pilot testers. It takes
`{ firstName, lastName }` (`completeIdentityInputSchema` in
`@dim/contract/input`), it answers the FRESH `MeV1User` (`IdentityCompletedV1`)
rather than `{ saved: true }` — so the client swaps its stored session in one
round trip instead of two, with no window in which its own gate still refuses —
and `session-store.ts`'s `completeIdentity` is the only caller, for the reason
`signOutEverywhere` gives: the request and the session-state transition are one
act. Its two own error codes are `identity_name_provisional` (422 — the name
would leave the caller pending anyway) and `identity_failed` (500, safely
retryable: an identity is a value, not an append). **The DNI did not move** — the
screen still links to `/registro?from=app` for it.

`expectedPayloadVersion` is checked **before any field is read**, so an old build
says "actualizá la app" instead of rendering half a screen from a shape it is
guessing at.

Every `/api/v1` call the app makes is in one file, `apps/mobile/src/api/endpoints.ts`.
Its header refuses to state a count of writes, and says why: the count used to
live there, drifted, and ended up contradicting three docblocks below it. It
keeps the checkable claim instead — **not every write there is an append.**
`registerPet`, `recordPetEvent` and `amendPetEvent` are pure inserts onto the
append-only spine; `sendLostCommand`, `sendShareCommand` and
`sendTransferCommand` move `pets.status`, mint and revoke bearer tokens, and can
change who owns an animal.

---

## 4. The offline credential cache

`apps/mobile/src/credential/credential-cache.ts` — **display only**, PO decision
2026-08-25.

- **What it is for:** a phone in a basement, a rural clinic with no signal. One
  write per successful read turns "no pudimos conectarnos" into a dated answer.
- **Where it lives:** `AsyncStorage`, not the Keystore, and the reasoning is
  about *whose* data it is: a credential is the **public** face of a pet — the
  same JSON any stranger scanning the QR receives. Keeping the owner's copy of a
  public document on the owner's own device is not a new disclosure. The things
  that must not touch a plain file are the tokens, and those are in the Keystore
  via `apps/mobile/src/auth/secure-store-auth-storage.ts`.
- **Versioned by key**, not only by value, so a `payloadVersion` bump strands old
  entries instead of parsing and discarding them.
- **Cleared on every sign-out** (`forgetAllCachedCredentials`), because the
  device may be shared.
- **Never rendered silently.** A cached credential always carries its age and
  the fact that it came from the cache, and the age is computed from the
  **server's** `issuedAt` / `staleAfter`, not from the device clock at write
  time — so a phone with a wrong clock still reports honestly. Rendering a stale
  credential without the banner would let someone present a "vigente" rabies
  status that expired last month.

---

## 5. Deep links — what resolves, and what does not

`packages/contract/src/links/deep-link-map.ts` maps a logical destination to the
path that resolves it, and it exists because three consumers disagreed about
what a path even is: the web renders `href="/p/{token}"`, a QR needs an absolute
URL with an origin, and the check-in QR at `/mis-turnos/{token}` encodes a custom
scheme whose path shape matches no web route at all.

| Mechanism | Status |
|---|---|
| Custom scheme `mimar://` | **Wired.** Declared in `apps/mobile/app.json`, filtered explicitly in `apps/mobile/app.config.ts`. Enough for an OAuth redirect back into the app |
| Verified App Links (`https://…/p/{token}` opening the installed app) | **Not wired, and cannot be from this repo.** Android needs `/.well-known/assetlinks.json` carrying the SHA-256 of the signing certificate; under Play App Signing that key is Google's and the fingerprint only exists after upload. iOS needs a Team ID from an enrolment that does not exist |

The consequence for any slide: **scanning a miMAR QR opens the browser.** A
custom scheme cannot change that — no phone camera will follow `mimar://p/{token}`
from a code it finds in the street, and it must not, because any app could have
claimed the scheme. `publicCredentialPageUrl` (`apps/mobile/src/config/api.ts:166`)
therefore encodes the `https` web page, built from the same link table the web
app uses, so the QR keeps working unchanged on the day App Links land.

Several screens deliberately hand off to the web rather than reimplement it —
identity completion at `/registro`, the two legal documents, the account-deletion
page. Each constant in `apps/mobile/src/config/api.ts` carries the argument for
why, and one of them carries a warning the copy must repeat: **the web resolves
a visitor from a cookie while the app holds a bearer token**, so an in-app link
lands on a signed-out browser.

---

## 6. Observability — mobile has Sentry, the web has nothing

`apps/mobile/src/observability/sentry.ts`:

- The DSN is read at **build time** in `apps/mobile/app.config.ts` from
  `SENTRY_DSN` (no `EXPO_PUBLIC_` prefix, so it never reaches `process.env` in
  the bundle) and carried into the manifest as `extra.sentryDsn`. A build without
  one resolves to `null` and `initSentry` **deliberately does nothing** — an SDK
  initialized with a garbage DSN retries uploads forever.
- `sendDefaultPii: false`, stated even though it is the default: this product
  hashes DNIs at the boundary and its crash reporter does not get to be the one
  surface that ships identifying data by accident.
- `tracesSampleRate: 0` — the pilot's question is "does it crash", not "is it
  fast".
- The `@sentry/react-native/expo` config plugin wires the **native** crash layer
  during prebuild, because a startup crash never reaches a JS `Sentry.init`.
  Source-map upload is off: it needs a `SENTRY_AUTH_TOKEN` EAS does not hold, so
  crashes arrive with minified frames.

**The web app has no crash reporter at all.** A browser error reaches
`console.error` and dies in the tab; server errors reach Vercel logs through
`lib/infra/report-error.ts`. The engineering seam is built and the choice of
sink is an open PO/legal decision —
`docs/architecture/client-error-sink-pending-decision.md`. Never let a diagram
imply symmetric observability.

---

## 7. Build and release

### 7.1 EAS profiles — `apps/mobile/eas.json`

| Profile | Channel | Distribution | Android artifact |
|---|---|---|---|
| `development` | `development` | internal | `apk`, with the dev client |
| `preview` | `preview` | internal | `apk` |
| `production` | `production` | store | `app-bundle`, `autoIncrement: true` |

`appVersionSource: "remote"` — the version counter lives on EAS rather than in a
file a human has to remember to bump. **The channel is declared per profile and
never in `apps/mobile/app.config.ts`**, which is what keeps a preview update
from reaching a production install.

### 7.2 Secrets and configuration — `apps/mobile/app.config.ts`

The static values live in `apps/mobile/app.json`; this file adds only the
declarations that need paragraphs of explanation. Three things it handles:

- **The DSN**, as above: injected by EAS at config-resolution time, carried in
  `extra`. A DSN is a publish address, not a secret — every shipped app exposes
  its own — so `extra` is an appropriate home. What *is* baked into the binary
  and cannot be changed afterwards are the `EXPO_PUBLIC_*` values, inlined by
  babel at bundle time; a build made with `EXPO_PUBLIC_SUPABASE_*` empty ships an
  app that cannot sign in, which is exactly what happened to Play build 5
  (`dim-interno:docs/agents/open-work.md`).
- **OTA updates, fenced to hotfixes** by PO decision
  (`docs/mobile/ota-policy.md`). The mechanism that makes the policy enforceable
  rather than aspirational is `runtimeVersion: { policy: "fingerprint" }`: an
  update is only served to a build whose native-runtime fingerprint matches, so
  shipping JS that calls a native module the installed binary lacks becomes a
  delivery that reaches zero devices instead of a crash that reaches all of
  them. `fallbackToCacheTimeout: 0` means the launch never waits on the network,
  so a hotfix arrives on the user's *second* open.
- **The fingerprint's own trap**, learned from the first real build (2026-08-26,
  errored): `@expo/fingerprint` hashes the native dependency set **by path**, and
  pnpm's virtual-store directory names truncate at a length that defaults
  differently per platform. The pin lives in `pnpm-workspace.yaml`
  (`virtualStoreDirMaxLength: 60`) and is part of the release policy, not of the
  package manager's configuration — see `docs/mobile/eas-build-profiles.md`.

As of this snapshot **nothing has been published over the air**: the project
exists on EAS, one production build has been attempted, and no `eas update` has
ever run. The `updates` block is a declaration whose runtime half has never
executed.

---

## 8. Tests

<!-- fact:mobile_jest_files -->130<!-- /fact --> test files under
`apps/mobile/src`, run by `jest-expo` through `apps/mobile/jest.config.js`. Three
things about that config are decisions, not defaults:

- **A separate runner from the web's Vitest, on purpose.** The root
  `vitest.config.ts` walks the repo for `*.test.ts` and excludes `apps`; without
  that exclusion these files would be collected in jsdom with the web app's
  aliases and fail as *broken files* in the `pnpm test:verified` verdict — a
  mobile test taking the web gate down.
- **Wired into the root gate anyway**, since 2026-08-25, through
  `pnpm verify:mobile` (this app's `tsc --noEmit`, its tests, and
  `expo config --type public`). The reversal was not a change of taste: a clean
  `git merge` broke this app's build one morning and nothing went red, because
  neither gate was in `pnpm verify` nor in `.github/workflows/ci.yml`.
- **`roots` is a path and `testMatch` is a relative glob**, because micromatch
  reads `\` as an escape character. An absolute Windows `testMatch` containing
  `\.claude\` silently matched nothing, and Jest reported that it had checked
  the files and matched none — with no hint that the pattern was the problem.

The session-policy port (`SessionPort`, `apps/mobile/src/api/client.ts:72`)
exists so the most test-worthy behaviour in this app — refresh-and-retry — can
be exercised with three fakes and no mocking of `expo-secure-store`, which
cannot run under Jest.
