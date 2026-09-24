# ADR: Native (iOS/Android) Readiness Contract

- **Status**: accepted
- **Date**: 2026-07-18
- **Deciders**: Ignacio Del Valle (PO)
- **Companion docs**: [`docs/architecture/hexagonal-lite.md`](../architecture/hexagonal-lite.md) (module layering this ADR builds on), [`AGENTS.md`](../../AGENTS.md) (event model, Mi Argentina federation premise, user roles)

---

## Context

DIM/MiMAR ships today as a Next.js 15 PWA. Per `AGENTS.md`, **the pet is the credential** — a globally-unique public token resolving to a QR-verifiable page — and **Mi Argentina federation is the premise**, not a nice-to-have. A federated layer implies, sooner or later, first-class native clients (iOS/Android) issued or verified through Mi Argentina rather than a browser tab. The PO has decided: the web app stays the product for now, but every architectural step we take from here must keep a future native app *cheap*, not free — we are not building it today, we are not blocking on it, but we refuse to accumulate decisions that would force a rewrite to get there.

The codebase is mid-strangler-migration from fat `lib/`-era server actions to `src/modules/<domain>/{domain,application,infrastructure}` (documented in `docs/architecture/hexagonal-lite.md`). That migration already produces the raw material native readiness needs: framework-free use-cases with a Biome-enforced import fence. This ADR makes that property a **standing requirement** instead of an incidental side-effect, and specifies the shape of the pieces native will eventually need (API contract, auth, push transport) so today's extractions don't foreclose them.

Concrete grounding, verified at this repo's current `HEAD` (`02fb1a5dd`):

- **Module layering example** — `src/modules/adoption/{domain,application,infrastructure}/` and `src/modules/pets/application/update-pet.ts`, `src/modules/pets/application/register-pet.ts`. Use-cases take a plain-data `input` + an injected `Deps` bag (repository interface), never `FormData`, `headers()`, or `next/navigation`.
- **The import fence already exists** — `biome.json` (lines 42-65) applies `nursery.noRestrictedImports` to `src/modules/*/domain/**`, blocking `@/db`, `drizzle-orm`, `next`, `next/cache`, `next/navigation`, `next/headers`, and `server-only`. Today it only covers `domain/`; this ADR extends the *intent* (not yet the lint rule) to `application/` as well — see Decision 1.
- **Result shape today** — `src/modules/events/application/types.ts` defines `UseCaseResult<T> = { ok: true; value: T; notifications: NewNotification[] } | { ok: false; error: string }`. Use-cases **return** a discriminated result; they do not throw for expected domain failures, and `error` is a free-text Spanish string, not a machine-readable code. This is the gap Decision 2 closes.
- **Auth today** — `lib/pet-access.ts` (`requirePetAccess` / `requireAlivePetAccess`) resolves access via `createClient()` from `lib/supabase/server.ts` (Supabase Auth, cookie-backed). Session refresh happens in `lib/supabase/middleware.ts` (`updateSession`), invoked from `middleware.ts` on every request. Drizzle bypasses RLS by design, so `requirePetAccess` — not RLS — is the security boundary; this stays true for a token-authed API adapter.
- **Rate limiting** — `lib/rate-limit.ts` (`enforceRateLimit`, `callerIp`), DB-backed via `rate_limit_buckets`, already IP-and-endpoint keyed and safe across serverless workers. Applies unchanged to any future `/api/v1` surface.
- **Idempotency precedent already shipped** — `lib/event-idempotency.ts` (`insertEventIdempotent`, `findExistingByKey`) dedupes `pet_events` inserts on `(pet_id, event_type, client_idempotency_key)` via a partial unique index (`pet_events_idempotency_idx`), used today by `src/modules/surveillance/infrastructure/surveillance-repository.ts` (`insertIncidentEventIdempotent`) for the bite-report flow. Decision 2 generalizes this existing convention rather than inventing a new one.
- **Notification transport abstraction** — `src/modules/events/application/types.ts` (`NewNotification`) plus `flushNotifications` in `src/modules/events/actions.ts` and `src/modules/pets/actions.ts`: use-cases collect plain-data `NewNotification[]` and return them; the *action* layer flushes them post-transaction, today by inserting rows into the `notifications` table (`db/schema.ts`, `NewNotification = typeof notifications.$inferInsert`). This is the transport-agnostic seam push will attach to (Decision 4). A second, architecturally-related but distinct outbox exists — `db/migrations/0048_event_notification_outbox.sql` / `lib/event-outbox-enqueue.ts` / `lib/outbox-drainer.ts` — but that one is the async, retry-with-backoff **jurisdiction/SLA delivery** outbox (government notification routing), drained by `app/api/cron/drain-outbox/route.ts`. It is not the in-app notification path; it is cited here only because its retry/backoff shape is the right model if `notifications` delivery ever needs the same durability (see Decision 4).
- **No `/api/v1` today** — `app/api/**` contains only `app/api/cron/*` routes (cron-secret authed, internal). Confirmed no versioned public API exists yet.
- **PWA push** — confirmed **not yet implemented**: no service worker, no `web-push`/VAPID code, no `pwa-push` module in the tree. It is planned (per the mission that produced this ADR), not shipped.

---

## Decision

### 1. Standing rule: every strangler extraction stays API-exposable

Every use-case that graduates from a fat action into `src/modules/<domain>/application/` MUST, from the moment it's written:

- Accept a **plain-data input** (a typed object — no `FormData`, no `Request`, no `Headers`).
- Return a **plain-data result** (JSON-serializable — no Drizzle row types, no Next.js response objects).
- Signal failure through **typed, discriminated results** (see Decision 2) — not by throwing for expected domain conditions.
- Import nothing from `next`, `next/cache`, `next/navigation`, `next/headers`, `server-only`, or the raw `@/db`/`drizzle-orm` client. The dependency is injected (a repository interface), per `docs/architecture/hexagonal-lite.md`'s existing rule.

**Enforcement.** The Biome `noRestrictedImports` fence (`biome.json` lines 42-65) already covers `src/modules/*/domain/**`. As a fitness-function follow-up (tracked, non-blocking — not part of this ADR's scope to implement), extend the `include` glob to `src/modules/*/application/**` so the same guardrail catches an accidental `next/headers` import creeping into a use-case, not just the domain layer. Until that lint extension lands, this is a **review-time** rule (see Fitness hooks, below).

This is not new work — it is what the strangler migration in `docs/architecture/hexagonal-lite.md` already produces (`actions.ts` stays a thin edge; `application/` stays framework-free). This ADR makes it a **contract we hold the line on**, not an emergent property that erodes under time pressure.

### 2. API contract shape (when native arrives)

Native clients will call **versioned REST route handlers** (`/api/v1/...`) that are **thin adapters** over the *same* `application/` use-cases the server actions already call — no logic forking, no parallel "mobile" business rules. An `/api/v1/pets/[publicToken]/events` route handler parses the JSON body into the same `input` shape a server action builds from `FormData`, resolves auth (Decision 3), calls the same use-case, and serializes the same `UseCaseResult`.

**Envelope.**

```jsonc
// success
{ "ok": true, "data": { /* use-case value, JSON-serializable */ } }

// failure
{
  "ok": false,
  "error": {
    "code": "PET_DECEASED",          // stable, machine-readable, SCREAMING_SNAKE_CASE
    "message": "Esta mascota está registrada como fallecida y no acepta nuevos eventos." // es-AR, human-facing
  }
}
```

**Gap this closes.** `UseCaseResult`'s failure branch today is `{ ok: false; error: string }` — a free-text Spanish sentence (see `requireAlivePetAccess` in `lib/pet-access.ts` for a representative example: `"Esta mascota está registrada como fallecida y no acepta nuevos eventos."`). That string is exactly right as a **message** but is not a stable contract a native client can `switch` on. Going forward, new use-case error branches SHOULD carry a stable `code` alongside the existing `message`. This is additive — it does not require touching every existing call site the day this ADR lands, but new/touched use-cases should adopt `{ ok: false; error: { code, message } }` (or equivalent) rather than the bare string, so the eventual `/api/v1` adapter has something machine-readable to forward. No repo-wide migration of existing error strings is in scope now.

**Pagination.** Cursor-based (keyset), matching the existing internal precedent (`__tests__/keyset-pagination.test.ts`) rather than offset-based — offset pagination degrades under the event-sourced append-only model (`AGENTS.md` invariant: events are append-only) as tables grow.

**Idempotency for event-writing endpoints.** Reuse the existing convention verbatim: a client-supplied `Idempotency-Key` header maps to `pet_events.client_idempotency_key`, deduped via the partial unique index `pet_events_idempotency_idx` on `(pet_id, event_type, client_idempotency_key)`, exactly as `lib/event-idempotency.ts` (`insertEventIdempotent`) already does for the bite-report flow (`src/modules/surveillance/infrastructure/surveillance-repository.ts`). Any new `/api/v1` event-writing route requires this header; conflict resolution is last-stable-wins, matching decision B8 already recorded in `lib/event-idempotency.ts`'s own header comment. Nothing new to invent here — generalize what's shipped.

### 3. Auth for native

Native clients cannot hold a cookie jar and cannot benefit from `middleware.ts`'s automatic session refresh (`lib/supabase/middleware.ts` → `updateSession`, which reads/writes cookies on every request). For native:

- Auth is **Supabase Auth's token flow**: client obtains an access JWT + refresh token at login, sends `Authorization: Bearer <access_jwt>` on each API call, refreshes explicitly when the access token expires (Supabase client SDKs do this natively — the mobile SDK is a drop-in for what `@supabase/ssr` does for cookies today).
- **Same RLS.** No new authorization model. `requirePetAccess`/`requireAlivePetAccess` (`lib/pet-access.ts`) stay the security boundary for pet-scoped operations — Drizzle bypasses RLS by design (documented at the top of `lib/pet-access.ts`), so this holds regardless of transport. A future `/api/v1` adapter resolves the user from the bearer JWT (via `supabase.auth.getUser()` against the token, not a cookie) and then calls the *same* `requirePetAccess`.
- **Public tier stays anonymous.** The public-token-resolves-to-QR-verifiable-page path (`AGENTS.md` invariant 1) needs no auth today and needs none from native either — a native "scan a tag" flow hits the same public read path a browser does.

**What must NOT be assumed** by any code written against a future `/api/v1`:
- No cookie jar. Do not read `next/headers` cookies for identity in a route handler meant to serve native — resolve identity from the `Authorization` header only.
- No middleware session refresh. A stale/expired native access token is the client's problem to refresh, not something `middleware.ts` silently fixes — the API must return a clear `401`/`AUTH_EXPIRED` code (per the envelope in Decision 2), not redirect (there's no browser to redirect).
- No implicit CSRF protection from same-origin cookies — a bearer-token API needs its own abuse controls, which is exactly what `lib/rate-limit.ts` (`enforceRateLimit`, already IP-and-endpoint keyed, DB-backed, cross-worker-safe) already provides and requires no change to extend to `/api/v1`.

### 4. Push

The planned **pwa-push tanda** (service worker + Web Push, not yet built — confirmed no `web-push`/VAPID/service-worker code exists at this repo's `HEAD`) is the stepping stone, not a detour. The transport-agnostic seam already exists: use-cases collect `NewNotification[]` (plain data — `userId`, `notificationType`, `title`, `body`, `severity`, `ctaUrl`, …, per `src/modules/events/application/types.ts`) and return them in `UseCaseResult`; the **action** layer flushes them post-transaction (`flushNotifications` in `src/modules/events/actions.ts` and `src/modules/pets/actions.ts`), today by inserting rows into `notifications` (in-app only).

When pwa-push ships, `flushNotifications` grows a second delivery leg (Web Push, via VAPID) fed by the *same* `NewNotification[]` the use-case already produces — no use-case changes. When native arrives, native swaps the transport again (APNs/FCM) behind that *same* seam — still no use-case changes, only the delivery leg the action layer calls changes. This is why Decision 1's "plain-data result" rule matters concretely for push: a `NewNotification` is already exactly the payload shape a push provider needs (title/body/cta), because it was never allowed to carry a Next.js- or web-specific type.

If push delivery later needs retry/backoff durability beyond today's post-tx best-effort insert, the pattern to borrow is already shipped and running: `event_notification_outbox` (`db/migrations/0048_event_notification_outbox.sql`, `lib/event-outbox-enqueue.ts`, drained by `lib/outbox-drainer.ts` / `app/api/cron/drain-outbox/route.ts`) — transactional enqueue + cron-driven exponential-backoff drain. That table is scoped to jurisdiction/government SLA routing today and should not be repurposed directly, but its *shape* (enqueue-in-tx, drain-with-backoff, cap attempts) is the template if push delivery needs the same durability guarantee `notifications` doesn't currently have.

### 5. What we deliberately do NOT do now

- **No React Native (or other native) code.** No mobile project scaffolded.
- **No `/api/v1` routes.** `app/api/**` stays cron-only until a real native (or third-party) consumer exists.
- **No token-auth endpoints.** No bearer-JWT verification path is built; cookie-based Supabase Auth stays the only auth transport in the running app.
- **No repo-wide error-code migration.** Existing `UseCaseResult` failure strings are not being retrofitted with `code` fields today — only new/touched use-cases adopt the coded shape going forward (Decision 2).
- **No lint-rule extension yet.** Widening `noRestrictedImports` to `application/**` is a tracked follow-up, not done in this ADR.

This ADR is the **contract**, written down *before* those things are needed, specifically so that when they are needed, no strangler extraction between now and then has to be redone.

---

## Consequences

**Positive**
- Every domain migrated under `docs/architecture/hexagonal-lite.md`'s strangler plan (`adoption`, `pets`, `foster`, `transfers`, `welfare`, `surveillance`, `organizations`, `events`, per its Module map) is native-ready *by construction*, at no extra cost beyond discipline already required for testability.
- The idempotency and notification seams needed for native already exist and are exercised in production by the bite-report and adoption flows — native isn't waiting on new infrastructure, only on a thin adapter layer.
- `requirePetAccess` remains the single security boundary regardless of transport (cookie or bearer token), so there is no "second auth model" to keep in sync.

**Negative / costs accepted**
- `UseCaseResult`'s error branch is inconsistent for a transition period: some use-cases carry only a string, newer ones carry `{ code, message }`. The `/api/v1` adapter (when built) must tolerate both until the coded shape reaches full coverage.
- The Biome fence not yet covering `application/**` means the "framework-free use-case" rule is reviewer-enforced, not tool-enforced, until the fitness-hook follow-up lands — see below.
- This ADR adds review overhead: every new use-case now carries an explicit "would this work behind `/api/v1`?" check (see Fitness hooks) even though `/api/v1` doesn't exist yet.

---

## Fitness hooks

A future PR touching `src/modules/*/application/**` should be reviewed against:

1. **No framework imports.** Does the use-case import `next`, `next/cache`, `next/navigation`, `next/headers`, `server-only`, or the raw `@/db`/`drizzle-orm` client directly? (Should be caught by Biome once the fence extends to `application/**`; until then, reviewer-checked.)
2. **Plain-data boundary.** Does the use-case's `input` type serialize to/from JSON with no loss (no `FormData`, no Drizzle row types, no `Date`-only fields without a documented serialization)? Does its success `value` do the same?
3. **Auth stays at the edge.** Does the use-case assume a cookie session, or does it receive an already-authorized context (per `docs/architecture/hexagonal-lite.md`'s existing rule that auth lives in `actions.ts`)?
4. **New error branches carry a code.** If this PR adds a new `{ ok: false, error: ... }` branch, does it use the coded shape (`{ code, message }`) rather than a bare string?
5. **Notifications stay plain-data.** If this PR adds a `NewNotification`, does it avoid encoding transport-specific fields (e.g., a web-only URL scheme) that would break under APNs/FCM?

None of these require `/api/v1` to exist to check — they're checkable today, on every strangler extraction, which is the point.
