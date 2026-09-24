/**
 * p95 probe for the `/api/v1` client surface — the API a native client talks to.
 *
 * Reports per-route p50/p95/max, and refuses to pretend it measured what it did
 * not: every `/api/v1` route this run did NOT drive is listed by name, with the
 * reason, derived from the route tree rather than from a hand-written list.
 *
 * Usage:
 *   pnpm probe:load:v1                                         # localhost:3000
 *   PROBE_URL=https://dim-staging.vercel.app pnpm probe:load:v1
 *   PROBE_URL=https://example.test pnpm probe:load:v1 --allow-unknown-target
 *
 * ===========================================================================
 * WHY THIS IS A SECOND SCRIPT AND NOT A MODE OF `load-probe.ts`
 * ===========================================================================
 * `scripts/load-probe.ts` drives the panorama analytics routes as a signed-in
 * GOVT operator, over a reconstructed `@supabase/ssr` COOKIE, against latency
 * targets sized for cached analytics. Every one of those four nouns is different
 * here: the caller is a citizen, the credential is an `Authorization: Bearer`
 * header (`/api/v1` has no cookie fallback and its tests make the cookie door
 * throw), and the target is an uncached read whose whole point is that a phone
 * on mobile data waits for it.
 *
 * A mode flag over that script would have been two probes sharing a name and a
 * report format while sharing no decision, and the first person to tune one
 * would have tuned the other by accident.
 *
 * ===========================================================================
 * THE RATE LIMITS THIS PROBE JUST WALKED INTO
 * ===========================================================================
 * WU-EAS-2 re-derived the `/api/v1` per-IP ceilings against carrier NAT
 * (lib/infra/api-v1-limits.ts). A probe firing 20 samples at four authenticated
 * reads is 80 requests from ONE address inside a minute — comfortably under the
 * new 600/min, and comfortably OVER the old 60/min, which is worth stating
 * because it means this script could not have existed in its current shape a day
 * earlier without measuring the limiter instead of the app.
 *
 * It is still the wrong thing to spend a real bucket on, for a reason that has
 * nothing to do with the ceiling: CI has ONE egress address, and behind it sits
 * every other automated run plus anybody sharing that NAT. So this probe sends
 * a random RFC 5737 documentation IP in `x-real-ip` for the whole run.
 *
 * ===========================================================================
 * THAT HEADER WORKS LOCALLY AND DOES NOTHING AGAINST STAGING — measured
 * ===========================================================================
 * THIS PARAGRAPH USED TO SAY the header buys "a fresh bucket" full stop, and the
 * report printed "the limiters are NOT exercised" as a fact on every run. It was
 * false against the deployed origin, and it was false in the exact way that is
 * hardest to notice: the runs that motivated the claim never tripped a ceiling,
 * so nothing ever contradicted it.
 *
 * On 2026-08-26 it was measured against https://dim-staging.vercel.app: 80
 * concurrent requests with a ROTATED `x-real-ip` (one distinct address each)
 * produced 60×401 then 20×429, against a fixed-address control's 59×401 then
 * 21×429 — the same ceiling, one request apart, which is what racing 80
 * requests at a counter of 60 looks like. A believed header would not have
 * wobbled by one; it would have produced no 429 at all. The edge overwrites the
 * header and `callerIp()` never sees the value this script chose. The full
 * method, including the positive control that makes the result mean anything and
 * the reason the ceiling read 60 rather than this file's 600, is in
 * `lib/infra/rate-limit.ts` above `callerIp()`.
 *
 * SO WHY IS THE HEADER STILL SENT. Because the DEFAULT target of this script is
 * `http://localhost:3000`, and there is no edge in front of a local `next
 * start`. Nothing overwrites the header there, `callerIp()` reads it, and the
 * run really does land in a private bucket instead of sharing the one every
 * other local run shares (`callerIp()` answers "unknown" for all of them
 * otherwise — one bucket for the whole machine). The header is load-bearing for
 * the common case and inert for the remote one; deleting it would cost the
 * former to tidy up the latter.
 *
 * WHAT THAT BUYS AND WHAT IT COSTS, per target, both stated:
 *   LOCAL   BUYS a p95 that measures the APPLICATION and not the limiter (429s
 *           are fast; they would make the number look BETTER while meaning
 *           less). COSTS: a local run does not exercise the per-IP limiters and
 *           must never be cited as a rate-limit test.
 *   REMOTE  BUYS nothing. The run spends the REAL per-IP buckets of whatever
 *           egress address it left from, exactly as if the header were absent.
 *
 * Set PROBE_V1_SPOOF_IP=0 to send no header at all. Against a remote target that
 * changes nothing but the honesty of the printed report; against a local one it
 * is how you confirm a ceiling on purpose, and never in an unattended run.
 *
 * ===========================================================================
 * SO CAN THIS PROBE NOW MEASURE ITS OWN REFUSALS? Checked, with the numbers.
 * ===========================================================================
 * Not at any setting this script permits, and if it ever could, the run FAILS
 * rather than lying — which is the property that matters and it was verified
 * rather than assumed:
 *
 *   · A 429 is not `expectStatus` (200), so the off-status check fires; the
 *     dedicated 429 check fires too; `failures.length > 0` marks the route FAIL;
 *     `printReport` returns false and `main()` exits 1. Two independent guards,
 *     one exit code, no silent sample-dropping.
 *
 *   · PER-IP is not close. Each route this probe drives has its own bucket at
 *     600/min (`localities` included). The hard cap here is 100 samples + 3
 *     warm-up = 103 requests per route, ≤ 8 in flight — 17% of one ceiling. The
 *     default run is 23 per route.
 *
 *   · PER-USER IS THE BINDING ONE, and no header can dodge it because it is
 *     keyed on `live.user.id`. All four authenticated reads spend
 *     API_V1_AUTHENTICATED_READ_USER_LIMIT — 120/min. 103 against 120 leaves
 *     SEVENTEEN requests of headroom at the cap, so a maxed-out run followed
 *     immediately by a second maxed-out run inside the same minute WILL be
 *     refused. That is a real edge and it is left in place deliberately: the
 *     cure is the exit code above, not a smaller cap that would also shrink the
 *     instrument's range. Re-running at `PROBE_V1_SAMPLES=100` twice in a minute
 *     is an operator decision, and it fails loudly instead of measuring the
 *     limiter.
 *
 * ANY 429 IS REPORTED AND FAILS THE ROUTE. Not filtered out of the sample: a
 * throttled run is a run whose latency figure means something else, and silently
 * dropping those samples is how a probe reports a healthy p95 for an endpoint
 * that was refusing its callers.
 *
 * ===========================================================================
 * THE BOUND — WHY THIS IS A PROBE AND NOT A LOAD ATTACK
 * ===========================================================================
 * Concurrency is 4 and samples are 20 per route, both capped in code
 * (MAX_SAMPLES = 100, MAX_CONCURRENCY = 8) rather than merely defaulted, because
 * a default is a suggestion and an env var on a CI job is how a suggestion
 * becomes 10.000. With at most 6 measurable routes the ceiling on a single run is
 *
 *     6 routes × (100 samples + 3 warm-up) = 618 requests, ≤ 8 in flight
 *
 * and the DEFAULT run is 6 × 23 = 138. Staging is a Vercel deployment against a
 * shared Supabase project; that is a probe. Ten times that is somebody else's
 * afternoon.
 *
 * WARM-UP IS SEPARATE AND STATED. The first requests to a cold serverless
 * function pay a start the twentieth does not, so WARMUP_SAMPLES requests per
 * route run first and are EXCLUDED from every percentile — with their own count
 * and their own median printed, because "the cold start costs 900ms" is exactly
 * the fact a p95 with the warm-up folded in would hide.
 *
 * Env:
 *   PROBE_URL              target origin (default http://localhost:3000)
 *   PROBE_V1_SAMPLES       measured samples per route (default 20, max 100)
 *   PROBE_V1_CONCURRENCY   in-flight requests (default 4, max 8)
 *   PROBE_V1_P95_MS        p95 target override (default 800 local / 1500 remote)
 *   PROBE_V1_SPOOF_IP      "0" to send no x-real-ip (only changes anything
 *                          against a LOCAL target — see the header)
 *   PROBE_V1_TOKEN         a public pet token, when discovery cannot find one
 *   PROBE_V1_BEARER        a pre-obtained access token (skips headless sign-in)
 */

import "./_load-env";

import { randomInt } from "node:crypto";
import { globSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Target resolution — the guard `load-probe.ts` does not have
// ---------------------------------------------------------------------------
//
// The older probe takes PROBE_URL and fires. That is fine for the surfaces it
// drives and it is not fine here, for one asymmetric reason: this script signs
// in as a real citizen account and drives reads that the person behind that
// account can see. Pointing it at an origin nobody meant to point it at is a
// mistake whose blast radius includes somebody's data and somebody's bill.
//
// So the target is an ALLOWLIST, not a warning. Local is allowed. The known
// staging origin is allowed. Anything else needs `--allow-unknown-target` on the
// command line — a flag, not an env var, because an env var set once in a shell
// stays set for every later run in that shell and this guard exists precisely to
// interrupt the run that was not thought about.
const KNOWN_TARGETS = ["https://dim-staging.vercel.app"];

const PROBE_URL = (process.env.PROBE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const allowUnknownTarget = process.argv.includes("--allow-unknown-target");

const targetHost = new URL(PROBE_URL).hostname;
const isLocalTarget = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(targetHost);
const isKnownTarget = isLocalTarget || KNOWN_TARGETS.includes(PROBE_URL);

if (!isKnownTarget && !allowUnknownTarget) {
  console.error(
    [
      `\n[probe-v1] I refuse: ${PROBE_URL} is not a target I know.`,
      "",
      "  Allowed without a flag:",
      "    http://localhost:3000 (or 127.0.0.1)",
      ...KNOWN_TARGETS.map((t) => `    ${t}`),
      "",
      "  This probe signs in as a real account and drives that account's reads,",
      "  so an unintended origin costs somebody's data and somebody's bill. If",
      "  you meant it, re-run with --allow-unknown-target.\n",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Bounds — capped in code, not merely defaulted
// ---------------------------------------------------------------------------

const MAX_SAMPLES = 100;
const MAX_CONCURRENCY = 8;
const WARMUP_SAMPLES = 3;

function bounded(name: string, raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  if (parsed > max) {
    console.error(`[probe-v1] ${name}=${parsed} exceeds the hard cap of ${max}; using ${max}.`);
    return max;
  }
  return parsed;
}

const SAMPLES = bounded("PROBE_V1_SAMPLES", process.env.PROBE_V1_SAMPLES, 20, MAX_SAMPLES);
const CONCURRENCY = bounded(
  "PROBE_V1_CONCURRENCY",
  process.env.PROBE_V1_CONCURRENCY,
  4,
  MAX_CONCURRENCY,
);
const P95_TARGET_MS = Number.parseInt(
  process.env.PROBE_V1_P95_MS ?? (isLocalTarget ? "800" : "1500"),
  10,
);

// One random documentation-range address (TEST-NET-3, RFC 5737) for the whole
// run — see the header. Honoured only where no edge overwrites it, which in
// practice means the local target. Empty when the operator asked to send none.
const SPOOF_IP = process.env.PROBE_V1_SPOOF_IP === "0" ? "" : `203.0.113.${randomInt(1, 255)}`;

/**
 * Does the header this run sends actually decide the bucket?
 *
 * Only where nothing rewrites it. Measured 2026-08-26: Vercel's edge overwrites
 * a client-supplied `x-real-ip`, so against staging the answer is no however
 * many distinct addresses the run sends. A bare local server has no such edge.
 *
 * Derived from `isLocalTarget` rather than from a hand-set flag, so pointing the
 * probe at a new remote origin with `--allow-unknown-target` cannot accidentally
 * inherit the local answer.
 */
const SPOOF_IP_IS_HONOURED = SPOOF_IP !== "" && isLocalTarget;

// Bootstrap-tier citizen — present on any freshly seeded database, unlike the
// demo-tier accounts (e2e/demo/_helpers.ts ACCOUNTS.owner + SHARED_PASSWORD).
const OWNER_EMAIL = "owner@dim.test";
const OWNER_PASSWORD = "Test1234!";

// ---------------------------------------------------------------------------
// The routes this probe drives
// ---------------------------------------------------------------------------

type ProbeRoute = {
  /** Matches the route's directory under app/api/v1, for the coverage report. */
  readonly routeFile: string;
  readonly name: string;
  /** `sample` is the 0-based request index, so a typeahead can vary its query. */
  readonly path: (sample: number) => string;
  readonly auth: boolean;
  /**
   * The status a REAL measurement has on this route.
   *
   * NOT decoration, and the first run of this script is why it exists. Pointed
   * at staging from a checkout whose `.env.local` holds LOCAL Supabase keys, the
   * probe signed in against `127.0.0.1:54321`, sent the resulting token to
   * `dim-staging.vercel.app`, collected `401×10` on all four authenticated
   * routes and printed PASS with a p95 of 204ms. It had measured how fast
   * staging says no.
   *
   * That is the exact defect this script's header claims to be about, produced
   * by the script itself on its first run. The split-environment guard below
   * stops the specific cause; this field stops the CLASS, because a row whose
   * statuses are not the expected one is not a slower measurement — it is a
   * measurement of something else.
   */
  readonly expectStatus: number;
};

/** Rotating typeahead prefixes — a real client never sends the same `q` twice. */
const LOCALITY_QUERIES = ["cor", "bue", "ros", "men", "sal", "tuc", "par", "san"];

function baseRoutes(publicToken: string | null): ProbeRoute[] {
  const routes: ProbeRoute[] = [
    {
      routeFile: "app/api/v1/localities/route.ts",
      name: "localities",
      path: (i) => `/api/v1/localities?q=${LOCALITY_QUERIES[i % LOCALITY_QUERIES.length]}`,
      auth: false,
      expectStatus: 200,
    },
    {
      routeFile: "app/api/v1/me/route.ts",
      name: "me",
      path: () => "/api/v1/me",
      auth: true,
      expectStatus: 200,
    },
    {
      routeFile: "app/api/v1/me/pets/route.ts",
      name: "me/pets",
      path: () => "/api/v1/me/pets",
      auth: true,
      expectStatus: 200,
    },
    {
      routeFile: "app/api/v1/me/transfers/route.ts",
      name: "me/transfers",
      path: () => "/api/v1/me/transfers",
      auth: true,
      expectStatus: 200,
    },
    {
      routeFile: "app/api/v1/me/caretaker-grants/route.ts",
      name: "me/caretaker-grants",
      path: () => "/api/v1/me/caretaker-grants",
      auth: true,
      expectStatus: 200,
    },
  ];

  if (publicToken) {
    routes.push({
      routeFile: "app/api/v1/pets/[publicToken]/credential/route.ts",
      name: "credential",
      path: () => `/api/v1/pets/${publicToken}/credential`,
      auth: false,
      expectStatus: 200,
    });
  }
  return routes;
}

/**
 * Why a `/api/v1` route is NOT driven by this probe.
 *
 * Keyed by route file so `reportUnmeasured()` can subtract the probed set from
 * the real route tree and demand a reason for every remainder. A route that
 * lands without one makes this script FAIL — which is the point: "we did not
 * measure it" has to cost as much to write as measuring it, or it becomes the
 * default and the report becomes decoration.
 */
const NOT_MEASURED: Record<string, string> = {
  "app/api/v1/auth/login/route.ts":
    "spends auth_login_email (5/min · 20/hr keyed on the EMAIL, not the IP) — a probe " +
    "would lock the shared demo account out for every other run on the target",
  "app/api/v1/auth/signup/route.ts": "creates accounts",
  "app/api/v1/me/revoke-sessions/route.ts":
    "kills every session for the account, including this probe's own bearer token",
  "app/api/v1/pets/route.ts": "registers an animal in the national registry",
  "app/api/v1/pets/[publicToken]/route.ts":
    "needs a pet the probe ACCOUNT holds; discovery only finds PUBLIC tokens, and a " +
    "token the account does not hold answers 404 — which would time a refusal, not a read",
  "app/api/v1/pets/[publicToken]/libreta/route.ts": "same fixture gap as the pet detail read",
  "app/api/v1/pets/[publicToken]/events/route.ts":
    "GET has the same fixture gap; POST writes an event",
  "app/api/v1/pets/[publicToken]/events/[eventId]/route.ts": "needs an event id under a held pet",
  "app/api/v1/pets/[publicToken]/events/[eventId]/amend/route.ts": "writes a correction event",
  "app/api/v1/pets/[publicToken]/lost/route.ts":
    "GET has the fixture gap; POST puts a real animal into lost mode and notifies",
  "app/api/v1/pets/[publicToken]/shares/route.ts":
    "GET has the fixture gap; POST mints a share link that discloses owner contact data",
};

// ---------------------------------------------------------------------------
// Credentials and fixtures
// ---------------------------------------------------------------------------

type Bearer = { token: string } | { unavailable: string };

async function signIn(): Promise<Bearer> {
  if (process.env.PROBE_V1_BEARER) {
    console.error("[probe-v1] Using PROBE_V1_BEARER from env (skipping sign-in).");
    return { token: process.env.PROBE_V1_BEARER };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    // NOT a fatal error and NOT a silent skip. The anonymous routes are still
    // worth measuring, and the authenticated ones are reported by name as
    // unreached — see printReport.
    return {
      unavailable:
        "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set for this target",
    };
  }

  // THE SPLIT ENVIRONMENT, and this guard is not hypothetical: it is what the
  // first run of this script did. `.env.local` holds the LOCAL Supabase keys, so
  // pointed at staging the probe signed in against `127.0.0.1:54321`, sent that
  // token to `dim-staging.vercel.app`, and every authenticated route answered
  // 401. `scripts/_env-target.ts` was written for the same shape on the seeds —
  // "el seed escribía con Drizzle en STAGING mientras el SDK de Auth leía de la
  // base LOCAL" — and its lesson is that the mixed state must be its OWN branch
  // rather than a value that classifies as one side and continues.
  //
  // It refuses the TOKEN rather than the run: the anonymous routes are still
  // measurable, and this ends up in the report as an unreached-routes line with
  // the reason attached instead of as four rows of fast 401s.
  const authIsLocal = /(?:127\.0\.0\.1|localhost)/.test(supabaseUrl);
  if (authIsLocal !== isLocalTarget) {
    return {
      unavailable: `SPLIT ENVIRONMENT — the target is ${isLocalTarget ? "LOCAL" : "REMOTE"} but NEXT_PUBLIC_SUPABASE_URL points at ${new URL(supabaseUrl).host} (${authIsLocal ? "LOCAL" : "REMOTE"}). A token minted there does not authenticate here; load the matching env, or pass PROBE_V1_BEARER`,
    };
  }

  console.error(`[probe-v1] Signing in ${OWNER_EMAIL} against ${new URL(supabaseUrl).host} ...`);
  const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.signInWithPassword({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  });
  if (error || !data.session) {
    return { unavailable: `sign-in failed: ${error?.message ?? "no session returned"}` };
  }
  return { token: data.session.access_token };
}

/**
 * Finds a real public pet token from the target's own public adoption catalogue.
 *
 * NEVER hardcoded, for the reason `e2e/README.md` gives: a token baked into a
 * script is a fixture that silently stops existing. A target with an empty
 * catalogue reports the credential route as unmeasured rather than probing a
 * token that 404s and calling the refusal a latency figure.
 */
async function discoverPublicToken(): Promise<string | null> {
  if (process.env.PROBE_V1_TOKEN) return process.env.PROBE_V1_TOKEN;
  try {
    const resp = await fetch(`${PROBE_URL}/adoptar`, { headers: runHeaders(false) });
    if (!resp.ok) return null;
    const html = await resp.text();
    return html.match(/\/adoptar\/(DIM-[A-Z0-9-]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

function runHeaders(authorized: boolean, token?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (SPOOF_IP) headers["x-real-ip"] = SPOOF_IP;
  if (authorized && token) headers.authorization = `Bearer ${token}`;
  return headers;
}

type Sample = { status: number; latencyMs: number };

async function fireOne(route: ProbeRoute, sample: number, token?: string): Promise<Sample> {
  const t0 = performance.now();
  try {
    const resp = await fetch(`${PROBE_URL}${route.path(sample)}`, {
      headers: runHeaders(route.auth, token),
      redirect: "manual",
    });
    // Drain the body: the latency a client pays includes reading it, not just
    // time to first byte.
    await resp.text();
    return { status: resp.status, latencyMs: performance.now() - t0 };
  } catch {
    return { status: 0, latencyMs: performance.now() - t0 };
  }
}

/** Runs `count` requests with at most CONCURRENCY in flight. */
async function fireMany(
  route: ProbeRoute,
  count: number,
  offset: number,
  token?: string,
): Promise<Sample[]> {
  const out: Sample[] = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= count) return;
      out.push(await fireOne(route, offset + index, token));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

type RouteReport = {
  route: ProbeRoute;
  sampleCount: number;
  warmupCount: number;
  warmupMedian: number;
  p50: number;
  p95: number;
  max: number;
  statusCounts: Record<number, number>;
  throttled: number;
  failures: string[];
};

async function probeRoute(route: ProbeRoute, token?: string): Promise<RouteReport> {
  process.stderr.write(`  ${route.name}: ${WARMUP_SAMPLES} warm-up + ${SAMPLES} measured ... `);

  const warmup = await fireMany(route, WARMUP_SAMPLES, 0, token);
  const measured = await fireMany(route, SAMPLES, WARMUP_SAMPLES, token);

  const warmLatencies = warmup.map((s) => s.latencyMs).sort((a, b) => a - b);
  const latencies = measured.map((s) => s.latencyMs).sort((a, b) => a - b);

  const statusCounts: Record<number, number> = {};
  for (const s of measured) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;

  const throttled = statusCounts[429] ?? 0;
  const serverErrors = Object.entries(statusCounts)
    .filter(([status]) => Number(status) >= 500 || Number(status) === 0)
    .reduce((n, [, count]) => n + count, 0);
  const p95 = percentile(latencies, 95);

  const failures: string[] = [];
  // OFF-STATUS FIRST, because it decides whether the rest of the row is about
  // this route at all. A refusal is fast, so a row full of them reports a
  // BETTER p95 than a healthy one — which is how the first run of this script
  // printed PASS over four endpoints that had answered 401 ten times each.
  const onStatus = statusCounts[route.expectStatus] ?? 0;
  if (onStatus < measured.length) {
    failures.push(
      `${measured.length - onStatus}/${measured.length} answered something other than ` +
        `${route.expectStatus} — this row timed a refusal or an error, not the read`,
    );
  }
  // 429 next, because it names WHICH refusal, and the cure is different.
  if (throttled > 0) {
    failures.push(
      `${throttled}/${measured.length} throttled (429) — this row timed the limiter, not the route${
        SPOOF_IP_IS_HONOURED
          ? " (and this run had its OWN per-IP bucket, so it was the per-USER ceiling or a shared local bucket)"
          : " (this run spends the real per-IP buckets of its egress address)"
      }`,
    );
  }
  if (serverErrors > 0) failures.push(`${serverErrors} request(s) returned 5xx or failed to fetch`);
  if (p95 > P95_TARGET_MS) failures.push(`p95 ${p95.toFixed(0)}ms exceeds ${P95_TARGET_MS}ms`);

  process.stderr.write(`${failures.length === 0 ? "ok" : "FAIL"}\n`);

  return {
    route,
    sampleCount: measured.length,
    warmupCount: warmup.length,
    warmupMedian: percentile(warmLatencies, 50),
    p50: percentile(latencies, 50),
    p95,
    max: latencies.at(-1) ?? 0,
    statusCounts,
    throttled,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Report — including, loudly, what was NOT measured
// ---------------------------------------------------------------------------

function statusLine(counts: Record<number, number>): string {
  return (
    Object.entries(counts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([status, n]) => `${status === "0" ? "fetch-failed" : status}×${n}`)
      .join(" ") || "none"
  );
}

/**
 * Every `/api/v1` route the run did not drive, derived from the route tree.
 *
 * Returns the routes with NO declared reason. A silent omission is the failure
 * this whole function exists to make impossible: a probe that quietly stops
 * covering a route reports the same green as one that covers everything.
 */
function reportUnmeasured(probed: ProbeRoute[], authSkipped: ProbeRoute[]): string[] {
  const all = globSync("app/api/v1/**/route.ts").map((f) => f.replaceAll("\\", "/"));
  const measured = new Set(probed.map((r) => r.routeFile));

  console.log("\n  NOT MEASURED — every route this run did not drive, and why:");

  const undeclared: string[] = [];
  for (const file of all.sort()) {
    if (measured.has(file)) continue;
    const skipped = authSkipped.find((r) => r.routeFile === file);
    if (skipped) {
      console.log(`    ${file}\n      ↳ auth-gated and no usable credential this run`);
      continue;
    }
    const reason = NOT_MEASURED[file];
    if (reason) {
      console.log(`    ${file}\n      ↳ ${reason}`);
    } else {
      console.log(`    ${file}\n      ↳ *** NO DECLARED REASON ***`);
      undeclared.push(file);
    }
  }
  return undeclared;
}

function printReport(
  reports: RouteReport[],
  authSkipped: ProbeRoute[],
  authReason: string | null,
  tokenFound: boolean,
): boolean {
  console.log(`\n${"=".repeat(100)}`);
  console.log("  DIM/MiMAR — /api/v1 p95 PROBE");
  console.log(`  Target: ${PROBE_URL}`);
  console.log(
    `  ${SAMPLES} measured samples/route, ${WARMUP_SAMPLES} warm-up (excluded), ` +
      `≤${CONCURRENCY} in flight, p95 target ${P95_TARGET_MS}ms`,
  );
  // WHAT BUCKET THIS RUN SPENT, and it is a MEASURED claim rather than an
  // intended one. This line used to print "a fresh bucket — the limiters are NOT
  // exercised" whenever a header was sent, on every target. Against a Vercel
  // origin that is false: the edge overwrites x-real-ip and the run lands in the
  // real per-IP bucket of its egress address (measured 2026-08-26 — see the
  // header). A report that states the wrong bucket is worse than one that states
  // none, because the next reader plans a run against it.
  console.log(
    `  Rate-limit bucket: ${
      SPOOF_IP_IS_HONOURED
        ? `x-real-ip ${SPOOF_IP} (no edge in front of a local target, so this IS a fresh bucket — the per-IP limiters are NOT exercised)`
        : SPOOF_IP
          ? `THE REAL ONE for this run's egress address. x-real-ip ${SPOOF_IP} was sent and the edge overwrites it — see the header`
          : "THE REAL ONE (x-real-ip not sent)"
    }`,
  );
  // The per-USER buckets are spent whatever the answer above is: they are keyed
  // on the account id, so no header reaches them. 120/min per authenticated
  // read against at most 103 requests here.
  console.log("  Per-user buckets: ALWAYS the real ones (keyed on the account, not the address)");
  console.log("=".repeat(100));
  console.log(
    `  ${"Route".padEnd(22)} ${"n".padEnd(4)} ${"warm".padEnd(9)} ${"p50".padEnd(9)} ${"p95".padEnd(9)} ${"max".padEnd(9)} Result`,
  );
  console.log(`  ${"-".repeat(96)}`);

  for (const r of reports) {
    const pass = r.failures.length === 0;
    console.log(
      `  ${r.route.name.padEnd(22)} ${String(r.sampleCount).padEnd(4)} ` +
        `${`${r.warmupMedian.toFixed(0)}ms`.padEnd(9)} ${`${r.p50.toFixed(0)}ms`.padEnd(9)} ` +
        `${`${r.p95.toFixed(0)}ms`.padEnd(9)} ${`${r.max.toFixed(0)}ms`.padEnd(9)} ${pass ? "PASS" : "FAIL"}`,
    );
    console.log(`    status: ${statusLine(r.statusCounts)}`);
    for (const f of r.failures) console.log(`    ✗ ${f}`);
  }

  if (authReason) {
    console.log(`\n  AUTHENTICATED ROUTES UNREACHED — ${authReason}`);
    for (const r of authSkipped) console.log(`    ${r.name}`);
  }
  if (!tokenFound) {
    console.log(
      "\n  CREDENTIAL ROUTE UNREACHED — no public pet token found on this target's" +
        " /adoptar catalogue (set PROBE_V1_TOKEN to name one).",
    );
  }

  const undeclared = reportUnmeasured(
    reports.map((r) => r.route),
    authSkipped,
  );

  console.log(`\n${"=".repeat(100)}`);
  const measuredPass = reports.every((r) => r.failures.length === 0);
  // A route with no declared reason fails the RUN, not just a row: an
  // undocumented gap in coverage is a defect in this script.
  const declared = undeclared.length === 0;
  if (!declared) {
    console.log(`  ${undeclared.length} /api/v1 route(s) are neither measured nor explained.`);
    console.log("  Add each one to NOT_MEASURED in this script, with the reason.");
  }
  if (reports.length === 0) {
    console.log("  NOTHING WAS MEASURED — this run proves nothing about p95.");
  }
  const overall = measuredPass && declared && reports.length > 0;
  console.log(`\n  OVERALL: ${overall ? "PASS" : "FAIL"}\n`);
  return overall;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error(`[probe-v1] Target: ${PROBE_URL} (${isLocalTarget ? "local" : "remote"})`);

  const bearer = await signIn();
  const token = "token" in bearer ? bearer.token : undefined;
  const authReason = "unavailable" in bearer ? bearer.unavailable : null;
  if (authReason) {
    console.error(`[probe-v1] No bearer token: ${authReason}`);
    console.error("[probe-v1] Continuing with the anonymous routes; the rest are reported.");
  }

  const publicToken = await discoverPublicToken();
  if (publicToken) console.error(`[probe-v1] Public token for the credential read: ${publicToken}`);

  const routes = baseRoutes(publicToken);
  const runnable = routes.filter((r) => !r.auth || token);
  const authSkipped = routes.filter((r) => r.auth && !token);

  const reports: RouteReport[] = [];
  for (const route of runnable) reports.push(await probeRoute(route, token));

  process.exit(printReport(reports, authSkipped, authReason, Boolean(publicToken)) ? 0 : 1);
}

main().catch((e) => {
  console.error("[probe-v1] Fatal error:", e);
  process.exit(1);
});
