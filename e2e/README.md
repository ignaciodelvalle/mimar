# e2e — Playwright

Browser-level regression tests running against the **built** Next.js app
(`next build && next start`), not the dev server — see `playwright.config.ts`.

## Prerequisites

- Local Supabase stack up (`supabase start` or your usual local setup).
- DB bootstrapped: `pnpm db:bootstrap` (schema + RLS + `owner@dim.test` and
  friends via `scripts/seed-test-users.ts`). Idempotent — safe to re-run.

## Running

```bash
# First run (or after a code change) — builds, then starts on :3333.
pnpm playwright test

# Fast re-run — skip the build if you already have a fresh one.
pnpm build
NEXT_BUILT=1 pnpm playwright test

# A single spec file (or a glob):
NEXT_BUILT=1 pnpm playwright test e2e/crisis-public.spec.ts
NEXT_BUILT=1 pnpm playwright test e2e/crisis-*.spec.ts
```

`pnpm e2e` is `playwright test` with `.env.local` (then `.env`) loaded first —
so the local-DB cleanups in `demo/_db-cleanup.ts` get their `DATABASE_URL`
without anyone exporting it by hand, and the run prints which host they will be
allowed to touch. A variable already in the environment always wins, so CI's
explicit `env:` block is untouched. See `scripts/run-e2e.ts`; a bare
`pnpm exec playwright test` still loads nothing.

## Layout

- `crisis-public.spec.ts` — PUBLIC crisis-path surfaces, no auth: the
  landing CrisisBand code lookup, and the lost-vs-non-lost contrast on
  `/p/[publicToken]`. Real tokens are discovered at runtime from `/adoptar`
  and `/perdidas` (never hardcoded); tests skip cleanly when the seed has no
  matching pet.
- `crisis-owner-lost-flow.spec.ts` — AUTHENTICATED owner flow: logs in as
  `owner@dim.test`, drives the real "Marcar como perdida" wizard on the
  seeded pet Michi, then opens a **fresh browser context** (no session) to
  verify the public credential as a stranger would see it — lost banner,
  disclosed phone CTA, and that undisclosed fields (owner name, last-seen
  location) stay hidden. Reverts Michi to "found" in a `finally` block so
  the local DB is left as it started.
- `chapas.spec.ts` — PHYSICAL TAGS end to end: admin issuance on
  `/admin/chapas` (the issuance CSV is captured from the real download —
  the only artifact that ever carries a plaintext activation code, so it
  is also this spec's fixture source), the public resolver `/t/[serial]`
  in all three non-redirect states, owner self-activation, the uniform
  evidence-gate refusal, and revocation. Cleans up its own lote through
  `deleteTagsByLotePrefix` (local DB only) — there is no "delete a chapa"
  flow in the product.
- `api-v1-public-contract.spec.ts` — the ANONYMOUS `/api/v1` surface, over the
  `request` fixture (no browser): the locality typeahead's envelope and its
  five projected fields, the documented "one character → 200 with no results"
  non-error, an unknown province → 400, and the credential read for a token
  **discovered at runtime** from `/adoptar`. The load-bearing assertion is
  `Cache-Control: no-store` on a DEPLOYED origin — §4 says the header is not
  inherited, and the 2026-07-07 privacy class (a found pet served stale from the
  CDN at the exact shared URL) is a CDN-level defect no unit test can see.
- `api-v1-auth-refusals.spec.ts` — the `/api/v1` auth failure space a native
  client writes ONE handler for: `auth_required` vs `auth_expired` across the
  four `/me` reads and the three `/me` writes, plus what a refusal must never
  BECOME in production — a redirect (there is no browser to redirect; ADR
  2026-07-18 D3), an HTML error page from an edge layer, a cacheable 401, or an
  envelope with more than one key. **Signs in nowhere**, on purpose: every case
  is a refusal, so it never spends `auth_login_email` — the EMAIL-keyed budget
  whose reset helper is local-DB-only and which a serial staging run shares with
  every spec that logs in.
- `public-smoke.spec.ts`, `auth.spec.ts`, `auth-bypass.spec.ts`,
  `create-pet.spec.ts`, `cross-tenant-isolation.spec.ts`,
  `owner-shell.spec.ts`, `admin-topbar.spec.ts`, `executive-smoke.spec.ts`,
  `a11y-operator-auth.spec.ts` — pre-existing coverage (routes, auth,
  RLS/tenant isolation, a11y).
- `demo/` — long-running (15–18 min) narrated recording scripts, not
  regression tests. Do not run these as part of a normal e2e pass.

Both `api-v1-*` specs join the **nightly staging pass automatically** —
`playwright.staging.config.ts` has `testDir: "./e2e"` and ignores only `demo/`
and `perf/`, so a new spec file is in the 06:00 AR run
(`dim-interno:.github/workflows/e2e-nightly.yml`) without touching the workflow. Adding a
parallel job for them would have been a second place to keep in sync for no
coverage. They need no secret beyond the public `STAGING_URL`.

## Conventions

- **CI's fresh-seed DB is the judge, not your laptop.** `pnpm db:bootstrap`
  seeds reference data + `scripts/seed-test-users.ts` and STOPS — no cases, no
  lost pets, no share tokens, and none of the demo/storyline seeds. A dev DB
  accumulates state (a lost first pet, an emptied refugio, same-day duplicate
  events) that makes local runs of some specs fail or pass for reasons the code
  has nothing to do with. Iterate locally on ONE spec; trust the CI verdict for
  the suite.
- **A fixture-gated check branches on the ENVIRONMENT, never on the data.**
  `test.skip(rowsFound === 0, …)` self-retires: the day a seed stops publishing
  the fixture, the check stops running and the summary stays green. Three gates
  in `public-smoke.spec.ts` were in that state, two of them axe scans (one on
  the lost-mode credential — the Ley 26.653 "hero moment"). Use
  `e2e/_seed-profile.ts` instead: it resolves a **seed profile** and turns a
  missing fixture into a skip only where absence is documented.
  - `bootstrap` (the default): `pnpm db:bootstrap` and nothing else — what CI's
    e2e job runs. No lost pets, no adoption listings, no cases, no share
    tokens. A missing fixture SKIPS, with a reason that names the coverage hole.
  - `full`: the deployed staging origin the nightly pass drives (`STAGING_URL`
    set → inferred automatically). It carries the demo/storyline seeds — 317
    lost pets and 3 adoption listings when this was measured (2026-08-04). A
    missing fixture **FAILS**.
  - Driving a locally seeded QA DB through `playwright.local3000.config.ts`?
    Export `E2E_SEED_PROFILE=full` so a missing fixture is red there too.
  The resolver is a pure function pinned by `__tests__/e2e-seed-profile.test.ts`
  — the gate itself must not become an assertion that cannot fail.
- No hardcoded DB ids/tokens — discover them from a real page at runtime
  (`a[href^="/adoptar/DIM"]`, `a[href^="/mis-mascotas/DIM"]`, etc.) and
  `test.skip(...)` when the seed doesn't have the fixture you need. Note org
  tokens are `DIM-`-prefixed too: capture the `/mascotas/<pet>` segment, not
  the first `DIM-` match in an href.
- Deterministic only: web-first assertions (`expect(locator).toBeVisible()`),
  no arbitrary `sleep`, no reliance on `Date.now()`/random.
- Shared login/demo-account helpers live in `demo/_helpers.ts`
  (`loginAs`, `ACCOUNTS`).

### Hard-won rules (2026-08-03/04, retiring a standing CI red)

- **Rate limits are real and the suite trips them.** `auth_login_email` is
  5/min · 20/hour keyed on the EMAIL (a unique `x-real-ip` does nothing), and
  Playwright REPLACES the worker after every failure — emptying `loginAs`'s
  session cache, so real sign-ins scale with FAILURES, not with tests. A few
  genuine failures used to starve every later spec. `loginAs` now calls
  `resetAuthLoginRateLimits()` (`demo/_db-cleanup.ts`, local DB only) before a
  real sign-in. Any spec with its own private login MUST do the same. The
  anonymous denuncia is 1/min per IP — pass a unique `uniqueIp()` per walk.
  **`uniqueIp()` is honoured against a LOCAL target only.** Measured 2026-08-26:
  Vercel's edge overwrites a client-supplied `x-real-ip` before `callerIp()` sees
  it, so under `playwright.staging.config.ts` every per-IP budget in the suite is
  spent from the runner's ONE egress address regardless of the header (method and
  positive control in `lib/infra/rate-limit.ts` above `callerIp()`; consequences
  for the nightly in the header of `playwright.staging.config.ts`). Against
  staging the protection is structural — sign in once per account per worker, and
  space repeated anonymous writes — never the header.
- **A login refusal now says which KIND it is, and you should grep for it before
  believing a red run.** The two refusals look alike in a failure list and mean
  opposite things: a credential refusal is about that spec, a budget refusal is
  about the whole run — the ceiling is shared from one egress address and
  `retries: 1` doubles the spend, so every later failure is suspect and none of
  them is necessarily the bug. `loginAs` raises **`LOGIN BUDGET EXHAUSTED`**
  (`LOGIN_BUDGET_MARKER` in `demo/_helpers.ts`) for the second kind, with the
  reasoning in the message. It is deliberately an English token and not the es-AR
  copy: before it existed, the only way to ask "did the run exhaust its login
  budget?" was to already know the Spanish sentence to search for. The ceilings
  themselves are NOT restated here — they are `LOGIN_IP_LIMIT` and
  `LOGIN_EMAIL_LIMIT` in `src/modules/auth/application/login-limits.ts`, with the
  derivation next to them. Specs with their own private sign-in do not go through
  `loginAs` and get none of this; `rg -l --sort path 'storageState' e2e` lists
  the ones that would have to adopt `loginRefusalError()` to get it.
- **Never assert a 404 by HTTP status.** Streaming routes flush the shell
  before the scoped lookup resolves, so `notFound()` fires after headers went
  out and a DENIED page answers **200** with the branded boundary rendered.
  Assert the surface (`branded-not-found` testid), never `response.status()`.
- **Never wait on a post-action URL.** The client half of the N3 contract
  (`useActionRedirect` → `window.location.assign`) drops often enough to
  matter — the documented Next 15.5.x behaviour in
  `lib/ui/full-page-action-nav.ts`. Assert the OUTCOME the mutation produces;
  if you need an id the redirect carried, read it from the index page instead.
- **Dates must be ART-local**, not `toISOString()`. The server rejects future
  dates in Argentina time, and from ~21:00 ART the UTC date is already
  tomorrow — that made a seam pass every morning and fail every night.
  Use `Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })`.
- **A filed denuncia does NOT land in a fixed stage.** `create-welfare-report`
  auto-flags an anonymous report into **Moderación** only when a heuristic fires
  (`lib/infra/welfare-moderation.ts`); otherwise it goes straight to **Triage**.
  `walkDenunciaWizard`'s text is long, mixed-case, "moderado" and carries a
  photo, so the only rule it can trip is `duplicate_within_24h` — i.e. whether
  an EARLIER SPEC in the same serial run already filed that same description.
  So the stage is an emergent property of spec ORDER, never a constant: probe
  and assert the SAME stages, or probe both. `8adeb437` (bootstrap now seeds two
  real `cases`) silently stopped `admin-case-detail-shell` from filing the first
  copy, which flipped the govt-side denuncia from Moderación to Triage and made
  synthetic-monitor (c) red — with nothing wrong in the product.
- **`Locator.count()` does not auto-retry — and a skip built on one lies.**
  `count()` is a single read of the DOM as it is right now; unlike `expect`, it
  never waits. After a `goto` into a route that streams under a Suspense
  boundary it routinely returns 0 for an element that arrives 200ms later. Gate
  every read behind an auto-retrying `expect` first — the pattern the repo's own
  helpers already use (`e2e/demo/_helpers.ts:246-250`: `await
  expect(links.nth(index), "…").toBeVisible({ timeout: 20_000 })` before the
  `getAttribute`). And `test.skip(await x.count() === 0, "…")` is the worst
  shape of all: a race that reports itself as a deliberate, green skip with a
  confident false reason. **Skips are for genuine ENVIRONMENTAL conditions** —
  a capability the browser lacks, a service the run has no credentials for —
  never for a fixture this repo seeds. If the seed guarantees it, ASSERT it, so
  a missing fixture is red instead of quietly absent (`rehome-by-titular.spec.ts`
  did exactly this swap). Whatever remains a skip must PRINT its reason: the CI
  e2e job runs `--reporter=list,github,html`, and `list` is the reporter that
  puts the skip and its reason in the job log instead of only in the HTML
  artifact nobody downloads.
- **Walk multi-step wizards.** Mark-lost and denuncia submits live on the LAST
  step; clicking that button's name from step 1 waits for an element that step
  never renders. `playwright.config.ts` now sets `actionTimeout: 15s` so this
  fails legibly instead of silently eating the test budget (Playwright's
  default is 0 — no limit — and an unbounded action cannot be caught by
  `try/catch`, because it never throws).

## Credentials — local vs. staging (`E2E_STAGING_PASSWORD`, C4b)

Every seed script writes the SAME literal password (`"Test1234!"`) to every
test account — see `scripts/seed-test-users.ts`. That is fine locally: it
never leaves a throwaway Postgres. It is NOT fine against a deployed target,
because this repo is public and the literal sits right there in it.

`e2e/_credentials.ts` resolves the password every login actually uses:

- Local target (`localhost` / `127.0.0.1`) → the published literal.
- Any other target (`playwright.staging.config.ts` against
  `https://dim-staging.vercel.app`, or an ad-hoc `STAGING_URL` run) →
  `process.env.E2E_STAGING_PASSWORD`, and the run THROWS if that variable is
  unset. There is no silent fallback to the literal.

Two helpers cover the two ways a spec authenticates:

- `passwordForPage(page.url(), email)` — call it right after
  `page.goto(SIGN_IN_PATH)`, for any spec driving the real login form.
- `passwordForSupabaseUrl(supabaseUrl, email)` — for a spec that signs in
  directly via `@supabase/supabase-js` instead of the login page
  (`cross-tenant-isolation.spec.ts`).

Both REQUIRE the account being signed into: on a remote target they throw for
any account outside the rotated eight, before `E2E_STAGING_PASSWORD` is even
read, so no spec can hand the rotated password to another account.

`E2E_STAGING_PASSWORD` is the password of exactly the 8 rotated accounts
below. On a remote target any OTHER account (`admin@`, `govt@`, … — not
rotated, and locked on staging) is refused BEFORE the login form is touched:
`skipUnlessRemoteLoginAllowed(page.url(), email)` (`e2e/_mfa.ts`) skips the
test with the reason (the helpers above would throw instead). `loginAs`,
`admin-topbar.spec.ts`, `executive-smoke.spec.ts`, `authz-ab-isolation.spec.ts`
and `owner-ia-p6.spec.ts` call it; a new private login must too.
`cross-tenant-isolation.spec.ts` reports a non-rotated account as not seeded
on a remote project instead of trying to sign in.

The nightly staging run lives in the private companion repository since
2026-09-24 (`dim-interno:.github/workflows/e2e-nightly.yml`, which checks this
repository out and runs the suite from it), and so does the
`E2E_STAGING_PASSWORD` GitHub secret. The workflow passes it to the
Playwright step only, not the whole job, and fails the job immediately —
before checkout, before paying for install or the browser download — if that
secret is empty. The daily synthetic monitor moved with it
(`dim-interno:.github/workflows/staging-synthetic.yml`): it signs in on staging
too, so it needs the same secret, and it runs with `--trace=off` and no
report upload for the reason below. No workflow in THIS repository holds a
staging secret.

**No trace, video or HTML report against staging.** A trace records every
`fill()` value and the login POST body, and the HTML report titles each step
`Fill "<value>"` — the password included. A workflow artifact is
downloadable by anyone who can read the repository (in a public one, by any
signed-in GitHub user).
`playwright.staging.config.ts` therefore runs with `trace: "off"`,
`video: "off"`, the `github` + `list` reporters only, and the nightly uploads
no artifact; read failures from the job log. That log is not value-free by
construction (an error can quote what a step was given): the control that
keeps the password out of it is GitHub's secret masking, which replaces the
exact value of `E2E_STAGING_PASSWORD` with `***`. **Never transform or
re-encode `E2E_STAGING_PASSWORD` before typing it** — a URL-encoded, base64 or
sliced value is not the secret GitHub masks. Do not turn trace, video or the
HTML reporter back on for that config.

**Rotating the 8 staging accounts the nightly run logs into** (`owner@`,
`owner2@`, `orgadmin@`, `alejo@`, `vet@`, `lilian@`, `graciela@`, `carla@` —
all `@dim.test`). The script calls `gh` itself — no pipe — so a failed run can
never store an empty secret, and nothing it prints is secret:

```bash
# dry run: checks the target is staging, that gh can manage the repo's
# secrets, and that all 8 accounts exist — changes nothing
node --env-file=.env.staging.local --import tsx \
  scripts/ops/rotate-staging-e2e-password.ts --repo ignaciodelvalle/dim-interno

# apply
node --env-file=.env.staging.local --import tsx \
  scripts/ops/rotate-staging-e2e-password.ts --repo ignaciodelvalle/dim-interno --apply
```

Order: gh check → the 8 passwords (stops at the first failure and names the
accounts already changed) → `gh secret set E2E_STAGING_PASSWORD` with the
password on stdin, only after all 8 succeeded → a global sign-out of every
existing session of the 8 accounts (a password update alone does not end
them). **If any step fails, run the same command again**: it rotates all 8
from scratch and re-sets the secret. If only the session revocation fails, the
script prints the fallback SQL (`delete from auth.sessions …`) to run on
staging. Ignacio-gated, like every write against a remote project in this repo.

Seeds never undo a rotation: against a remote target they set a password only
on accounts they CREATE, never on one that already exists.

## Institutional accounts and the second factor (TOTP, T2-S6)

Since T2-S6 every **institutional** account (`admin@`, `govt@`, `govt-local@`,
`nacional@`, `lucas@` — any `admin` / `govt` / `national` role) must pass a
TOTP code before any portal or action. After the password the server sends the
browser to `/mfa` (a verified factor exists) or `/mfa/configurar` (none yet).
`leftSignIn` is true on both, so **a login helper that stops at `leftSignIn` is
not logged in** for these accounts.

The convention:

- **Every login helper calls `passSecondFactorIfAsked(page, email, password)`**
  (`e2e/_mfa.ts`) right after it leaves the sign-in page. It is a no-op for
  personal accounts. `loginAs` in `demo/_helpers.ts` already does, and so do the
  five specs with a private login; a new private login must too.
- The helper walks the **real** `/mfa` screen with a code computed from a secret
  the harness knows. There is no test bypass in the app, and none may be added.
- The secret comes from `scripts/lib/seed-mfa.ts`: it enrols the account through
  its OWN session (enroll → challengeAndVerify — GoTrue generates the secret and
  has no API to set one) and keeps it in `e2e/.auth/totp-secrets.json`
  (gitignored), keyed by Supabase URL + user id + factor id. Idempotent: a known
  factor is reused; an unknown one (fresh DB, a factor somebody enrolled by hand)
  is deleted with the service-role admin API and replaced. A lock file keeps
  parallel workers from enrolling the same account at once.
- The codes are RFC 6238 (`scripts/lib/totp.ts`, pinned by the RFC's own test
  vectors in `__tests__/mfa-institutional.test.ts`). GoTrue accepts a code again
  inside the same 30-second step (measured), and the helper waits one step and
  retries once anyway.
- `resetAuthLoginRateLimits` also clears `auth_mfa_code_user:*` (5/min · 30/h
  per account) for the same worker-churn reason as the login buckets.
- API-driven QA scripts (`qa-session`, `qa-mint-sessions`, `qa-routes`,
  `qa-timing`, `qa-query-census`, `load-probe`) call
  `upgradeSeedSessionToAal2(client, email, password)` after
  `signInWithPassword`, so the cookie they build carries the aal2 token.

**LOCAL / CI ONLY.** The harness rewrites the factor of whatever account it is
pointed at. Against a shared environment where a PERSON uses the same account
(staging's `admin@dim.test`), it would replace that person's authenticator — and
without the service-role key it cannot clear a factor it did not enrol. So the
helper enforces it: on any host other than localhost it never enrols. Inside a
test it SKIPS with the reason (the nightly staging run reports those specs as
skipped, not red); outside a test (a QA script) it throws. Institutional
coverage on staging needs an operator-provided secret — a PO decision.

Inspecting the state by hand: the factor list is `auth.mfa_factors` in the local
DB; deleting `e2e/.auth/totp-secrets.json` makes the next run re-enrol every
account it touches.
