# Load probes

Two of them, and they are not interchangeable:

| script | `pnpm` | surface | caller | credential |
|---|---|---|---|---|
| `scripts/load-probe.ts` | `probe:load` | the three panorama analytics routes + `/api/health` | a govt operator | reconstructed `@supabase/ssr` **cookie** |
| `scripts/load-probe-api-v1.ts` | `probe:load:v1` | the `/api/v1` client surface | a citizen | `Authorization: **Bearer**` |

The `/api/v1` one is documented at the bottom of this file. Everything until
that heading is about the panorama probe.

---

## Panorama probe — `scripts/load-probe.ts`

A repeatable concurrency probe against DIM/MiMAR's hottest endpoints: the
three panorama analytics routes (`/api/panorama/kpis`, `/api/panorama/perdidas`,
`/api/panorama/cobertura`) and the liveness check (`/api/health`). It reports
per-endpoint p50/p95/max latency, error/degraded counts, and cache-header
distribution, then PASS/FAILs against latency and error-rate targets.

Run it: before a demo (catch a cold environment before a funcionario does),
and after any infra change that could shift latency or caching — a migration,
a Supabase plan change, a change to the panorama cache TTLs, a Vercel region
or plan change, a dependency bump touching the DB pool.

## Running it

```bash
# Local — against `pnpm dev` / `pnpm start` on :3000
pnpm probe:load

# Staging
PROBE_URL=https://dim-staging.vercel.app pnpm probe:load
```

Defaults: 3 waves of 6 concurrent requests per endpoint. Override with
`PROBE_WAVES` / `PROBE_CONCURRENCY` env vars for a heavier or lighter run.

Exit code is `0` on overall PASS, `1` on overall FAIL — safe to wire into a
CI job or a pre-demo checklist script later. It is intentionally **not**
wired into `pnpm verify` — this is a live-environment probe, not a static
check, and has no place gating every commit.

## Auth

The probe needs a session to call the panorama routes (admin/govt only — see
`app/api/panorama/_guard.ts`). It logs in headlessly as the demo govt account
(`govt@dim.test`, see `e2e/demo/_helpers.ts` `ACCOUNTS.govt` +
`SHARED_PASSWORD`) by calling the Supabase auth REST API directly with
`@supabase/supabase-js` and reconstructing the `@supabase/ssr` session cookie
— the same technique `scripts/qa-session.ts` uses. No browser, no Playwright.

This works whenever `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
in `.env.local` (or `.env`) point at the same Supabase project the target
origin authenticates against — true for local (`http://localhost:3000` next
to the local Supabase stack) and for staging today (one shared project).

If that ever stops being true (a WAF in front of a target, a Supabase project
the local env doesn't have keys for, etc.), skip headless login by setting
`PROBE_COOKIE` to a session cookie captured from a real browser:

1. Log in as `govt@dim.test` at the target's `/login` in a real browser.
2. Open DevTools → Application/Storage → Cookies, copy the full value of the
   `sb-<project-ref>-auth-token` cookie (or all its `.0`, `.1`, … chunks if
   the session was split — see the comment in `scripts/qa-session.ts` for why
   that happens).
3. Run:
   ```bash
   PROBE_URL=https://dim-staging.vercel.app \
   PROBE_COOKIE='sb-<ref>-auth-token=<value>' \
   pnpm probe:load
   ```

## What gets measured

For each endpoint: `WAVES` sequential waves of `CONCURRENCY` concurrent
requests (default 3×6 = 18 requests). Latency is measured from request start
to full body read (matches what a real client pays, not just TTFB).

- **p50 / p95 / max** — latency distribution across all requests for that
  endpoint.
- **5xx** — server errors or fetch failures. Any 5xx is an automatic FAIL for
  that endpoint (a live `/api/health` 503 during a real degraded state is
  correctly flagged here too — that IS the signal the probe exists to catch).
- **4xx** — reported but does not fail the probe on its own (e.g. a rate
  limit tripped by the probe's own concurrency, not the app under normal use).
- **cache distribution** — value counts of `x-kpi-cache` / `x-layer-cache`
  (`hit` / `miss`), read straight off the response headers set by
  `app/api/panorama/kpis/route.ts` and `app/api/panorama/[layer]/route.ts`.

## Targets and what they mean

| Target | Default (local) | Default (remote) | Override |
|---|---|---|---|
| `/api/health` p95 | < 500ms | < 1000ms | `PROBE_HEALTH_P95_MS` |
| Panorama API p95 | < 800ms | < 800ms | `PROBE_API_P95_MS` |
| 5xx anywhere | 0 | 0 | — |

These are baselines measured against a locally seeded (small) database and
the staging deployment, not universal SLOs — retune them with `PROBE_*_MS`
if the seed data grows or the deployment topology changes materially.

**Cold-cache caveat**: the panorama routes cache KPI/layer results server-side
(`x-kpi-cache` / `x-layer-cache`). The FIRST wave against a cold cache is a
miss and pays the full query cost, which can push that endpoint's p95 over
target even though every subsequent wave is a fast cache hit. A single-wave
FAIL driven by one slow miss in an otherwise-fast run is expected — read the
cache distribution line, not just the FAIL, before treating it as a
regression. A real regression shows hits that are ALSO slow, or a p95 that
stays high across all three waves.

## Sample local run

Captured against a local `next start` on `:3000` with the local Supabase
stack running and seeded data (`pnpm seed:panorama`):

```
====================================================================================================
  DIM/MiMAR LOAD PROBE REPORT
  Target: http://localhost:3000   Waves: 3 x 6 concurrent
====================================================================================================
  Endpoint     reqs   p50       p95       max       5xx   4xx   Result
  ------------------------------------------------------------------------------------------------
  kpis         18     155ms     1185ms    1185ms    0     0     FAIL
    ✗ p95 1185ms exceeds target 800ms
    cache (x-kpi-cache): miss=6, hit=12
  perdidas     18     172ms     230ms     230ms     0     0     PASS
    cache (x-layer-cache): miss=6, hit=12
  cobertura    18     153ms     773ms     773ms     0     0     PASS
    cache (x-layer-cache): miss=6, hit=12
  health       18     26ms      33ms      33ms      0     0     PASS
====================================================================================================

  OVERALL: FAIL
```

Reading this one: `kpis` FAILed on p95, but the cache distribution shows only
the first wave (6 requests) missed — the other 12 were hits, and `perdidas`/
`cobertura` (same cache mechanism) passed comfortably. This is the cold-cache
caveat above, not a regression — running the probe again immediately after
(cache already warm from the run above) confirmed it:

```
  Endpoint     reqs   p50       p95       max       5xx   4xx   Result
  ------------------------------------------------------------------------------------------------
  kpis         18     129ms     162ms     162ms     0     0     PASS
    cache (x-kpi-cache): hit=18
  perdidas     18     133ms     143ms     143ms     0     0     PASS
    cache (x-layer-cache): hit=18
  cobertura    18     139ms     154ms     154ms     0     0     PASS
    cache (x-layer-cache): hit=18
  health       18     22ms      29ms      29ms      0     0     PASS

  OVERALL: PASS
```

Treat a lone FAIL driven by first-wave misses as a prompt to re-run and check
the cache split before opening an issue — a real regression shows hits that
are ALSO slow, or a p95 that stays high across all three waves.

---

# `/api/v1` p95 probe — `scripts/load-probe-api-v1.ts`

What a native client waits for, measured. Per-route p50/p95/max over the
`/api/v1` surface, plus an explicit inventory of every route the run did **not**
drive and why.

Run it: after any change to a `/api/v1` route, its use-case, or the pooler; and
before shipping a native build that depends on one. It is deliberately **not**
in `pnpm verify` — it is a live-environment probe, not a static check.

```bash
# Local — against `pnpm start` on :3000, with the local Supabase stack up
pnpm probe:load:v1

# Staging
PROBE_URL=https://dim-staging.vercel.app pnpm probe:load:v1
```

## The target is an allowlist, not a warning

Unknown origins are **refused** unless you pass `--allow-unknown-target` on the
command line. Local and `https://dim-staging.vercel.app` need no flag.

A flag rather than an env var, on purpose: an env var set once in a shell stays
set for every later run in that shell, and this guard exists to interrupt the run
nobody thought about. The probe signs in as a real account and drives that
account's reads, so an unintended origin costs somebody's data and somebody's
bill.

## Load it with the env that matches the target

The probe signs in headlessly as `owner@dim.test` (bootstrap tier — present on
any seeded database) against `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, then sends the resulting access token to
`PROBE_URL`.

**Those two have to be the same environment.** Pointed at staging from a
checkout whose `.env.local` holds LOCAL keys, the probe mints a token against
`127.0.0.1:54321` and staging answers 401 — and it caught itself doing exactly
that on its first run, reporting a healthy 204ms p95 over four endpoints that had
said no ten times each. Two guards now stop it: a split-environment check that
refuses the token (and reports the authenticated routes as unreached, with the
reason), and a per-route **expected status**, so a row of refusals fails instead
of passing with a flattering number.

For staging, load `.env.staging.local` — or set `PROBE_V1_BEARER` to a token you
obtained yourself.

## The rate-limit interaction, and what it costs

`/api/v1`'s per-IP ceilings were re-derived against carrier NAT in WU-EAS-2
(`lib/infra/api-v1-limits.ts`, and §1.6 of `docs/architecture/api-invariants.md`).
A default run is well inside them — but CI has ONE egress address, shared with
every other automated run.

So the probe sends a random RFC 5737 documentation IP in `x-real-ip` for the
whole run — **and that header decides the bucket only against a LOCAL target.**
The script encodes exactly that: `SPOOF_IP_IS_HONOURED = SPOOF_IP !== "" &&
isLocalTarget` (`scripts/load-probe-api-v1.ts`). Nothing sits in front of a bare
`next start`, so `callerIp()` reads whatever arrives and the run really does land
in a private bucket. Against a Vercel origin the edge **overwrites** the header
before `callerIp()` ever sees it — measured 2026-08-26 against
`https://dim-staging.vercel.app`: 80 concurrent requests with a ROTATED
`x-real-ip` gave 60×401 then 20×429, against a fixed-address control's 59×401
then 21×429. The same ceiling, one request apart. A believed header would have
produced no 429 at all. The full method, including the positive control that
makes that null result mean anything, is in `lib/infra/rate-limit.ts` above
`callerIp()`. `playwright.staging.config.ts` carries the same header under the
same rule, and its own file header says so — honoured wherever no rewriting edge
sits in front of the origin, inert on Vercel.

What that buys and costs, per target, both stated:

- **Local** — it **buys** a p95 that measures the application rather than the
  limiter. Refusals are fast, so a throttled run reports a *better* number while
  meaning less. It **costs** any coverage of the limiters: such a run is **not** a
  rate-limit test and must not be cited as one — the ceilings are pinned by
  `__tests__/api-v1-rate-limit-families.test.ts` and each route's own cases.
- **Staging, or any origin behind a rewriting edge** — it buys **nothing**. The
  run spends the REAL per-IP buckets of the egress address it left from, exactly
  as if the header were absent.

`PROBE_V1_SPOOF_IP=0` sends no header at all. Against a **local** target that is
how you confirm a ceiling on purpose — attended, once, never unattended. Against
staging it changes nothing about which bucket the run spends (there is only ever
the real one); it changes only the honesty of the printed report.

### Scheduling a staging run: you are in the shared bucket

An operator who schedules a probe against staging is **not** isolated, with or
without the flag, and contends for the same per-IP budgets as the nightly
Playwright run and anything else leaving that egress address.

The failure mode is a failed run, not a silent lie. A 429 is not a route's
`expectStatus`, so the off-status check fires; the dedicated 429 check fires too;
`failures.length > 0` marks the route FAIL, `printReport` returns false and
`main()` exits 1. Two independent guards, one exit code, and no silent
sample-dropping — a throttled run is a run whose latency figure means something
else, so its 429s are reported and **fail** the row rather than being dropped
from the sample.

## The bound

| | |
|---|---|
| samples per route | 20 (`PROBE_V1_SAMPLES`, hard cap **100**) |
| warm-up per route | 3, **excluded** from every percentile, median printed separately |
| in flight | 4 (`PROBE_V1_CONCURRENCY`, hard cap **8**) |
| worst case, one run | 6 routes × (100 + 3) = **618 requests** |
| default run | 6 × 23 = **138 requests** |

The caps are enforced in code, not merely defaulted: a default is a suggestion,
and an env var on a CI job is how a suggestion becomes 10.000. Staging is a
Vercel deployment against a shared Supabase project — 138 requests is a probe.

## What it cannot measure

Six routes are driven. The rest are printed by name with a reason, derived from
the route tree rather than a hand-written list — and a `/api/v1` route with **no
declared reason fails the run**, so "we did not measure it" costs as much to
write as measuring it.

- **Writes** are never driven: they register animals, mint share links that
  disclose owner contact data, put real animals into lost mode, or revoke the
  probe's own session.
- **`/api/v1/auth/login`** spends `auth_login_email` — 5/min · 20/hr keyed on the
  EMAIL, so a unique `x-real-ip` does nothing and a probe would lock the shared
  demo account out for every other run on that target.
- **Owner-scoped pet reads** (`/pets/{token}`, `libreta`, `events`, `lost` GET,
  `shares` GET) need a pet the probe ACCOUNT holds. Discovery only finds PUBLIC
  tokens off `/adoptar`, and a token the account does not hold answers 404 —
  which would time a refusal and call it a read.
- **The credential read** needs a public token, discovered at runtime from the
  target's own `/adoptar` catalogue (never hardcoded — `e2e/README.md`'s rule).
  An empty catalogue reports it unreached. `PROBE_V1_TOKEN` names one by hand.

## Sample staging run

Captured 2026-08-26 against `https://dim-staging.vercel.app` with
`.env.staging.local` loaded, `PROBE_V1_SAMPLES=10`:

```
  Route                  n    warm      p50       p95       max       Result
  ------------------------------------------------------------------------------------------------
  localities             10   344ms     123ms     201ms     201ms     PASS
  me                     10   340ms     153ms     388ms     388ms     PASS
  me/pets                10   386ms     190ms     210ms     210ms     PASS
  me/transfers           10   188ms     183ms     315ms     315ms     PASS
  me/caretaker-grants    10   200ms     171ms     189ms     189ms     PASS
  credential             10   348ms     219ms     272ms     272ms     PASS
```

Reading it: the `warm` column is the median of the three excluded warm-up
requests, and it is 1,5-3× the p50 on every route — that is the Vercel cold start,
and folding it into the percentiles is exactly how a p95 hides the number an
operator actually wants. Nothing here is near the 1500ms remote target; the value
of the run is that the next one has something to be compared against.
