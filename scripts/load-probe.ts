/**
 * Repeatable load probe for DIM/MiMAR's hot panorama endpoints + health check.
 *
 * Fires concurrency waves against a target origin, reports per-endpoint
 * p50/p95/max latency, error/degraded counts, and cache-header distribution,
 * then PASS/FAILs against latency + error-rate targets. See
 * docs/ops/load-probe.md for when to run this and what the targets mean.
 *
 * Usage:
 *   pnpm probe:load                                    # http://localhost:3000
 *   PROBE_URL=https://dim-staging.vercel.app pnpm probe:load
 *
 * Auth: logs in headlessly as the demo govt account (govt@dim.test — see
 * e2e/demo/_helpers.ts ACCOUNTS.govt + SHARED_PASSWORD) via the Supabase auth
 * REST API and reconstructs the @supabase/ssr session cookie, the same
 * technique scripts/qa-session.ts uses. No browser required.
 *
 * If headless login doesn't work against a given target (env vars for that
 * Supabase project unavailable locally, a WAF in front of staging, etc.), set
 * PROBE_COOKIE to a session cookie captured from a real browser instead — see
 * docs/ops/load-probe.md for how to grab one.
 *
 * Env:
 *   PROBE_URL             target origin (default http://localhost:3000)
 *   PROBE_COOKIE           pre-captured session Cookie header (skips login)
 *   PROBE_WAVES            concurrency waves per endpoint (default 3)
 *   PROBE_CONCURRENCY      concurrent requests per wave (default 6)
 *   PROBE_HEALTH_P95_MS     health p95 target override (default 500 local / 1000 remote)
 *   PROBE_API_P95_MS        panorama API p95 target override (default 800)
 */

import "./_load-env";

import { createClient } from "@supabase/supabase-js";
import { upgradeSeedSessionToAal2 } from "./lib/seed-mfa";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROBE_URL = (process.env.PROBE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WAVES = Number.parseInt(process.env.PROBE_WAVES ?? "3", 10);
const CONCURRENCY = Number.parseInt(process.env.PROBE_CONCURRENCY ?? "6", 10);

const isLocalTarget = /^(localhost|127\.0\.0\.1)$/.test(new URL(PROBE_URL).hostname);

const HEALTH_P95_TARGET_MS = Number.parseInt(
  process.env.PROBE_HEALTH_P95_MS ?? (isLocalTarget ? "500" : "1000"),
  10,
);
const API_P95_TARGET_MS = Number.parseInt(process.env.PROBE_API_P95_MS ?? "800", 10);

// Demo govt account — see e2e/demo/_helpers.ts ACCOUNTS.govt + SHARED_PASSWORD.
const GOVT_EMAIL = "govt@dim.test";
const GOVT_PASSWORD = "Test1234!";

type EndpointSpec = {
  name: string;
  path: string;
  auth: boolean;
  cacheHeader: "x-kpi-cache" | "x-layer-cache" | null;
  p95TargetMs: number;
};

const ENDPOINTS: EndpointSpec[] = [
  {
    name: "kpis",
    path: "/api/panorama/kpis",
    auth: true,
    cacheHeader: "x-kpi-cache",
    p95TargetMs: API_P95_TARGET_MS,
  },
  {
    name: "perdidas",
    path: "/api/panorama/perdidas",
    auth: true,
    cacheHeader: "x-layer-cache",
    p95TargetMs: API_P95_TARGET_MS,
  },
  {
    name: "cobertura",
    path: "/api/panorama/cobertura",
    auth: true,
    cacheHeader: "x-layer-cache",
    p95TargetMs: API_P95_TARGET_MS,
  },
  {
    name: "health",
    path: "/api/health",
    auth: false,
    cacheHeader: null,
    p95TargetMs: HEALTH_P95_TARGET_MS,
  },
];

// ---------------------------------------------------------------------------
// Headless login — mirrors scripts/qa-session.ts (same cookie-reconstruction
// technique: sign in against the Supabase auth REST API, then rebuild the
// @supabase/ssr session cookie the app's middleware expects).
// ---------------------------------------------------------------------------

const MAX_CHUNK_SIZE = 3180;

function createChunks(key: string, value: string): Array<{ name: string; value: string }> {
  const encodedValue = encodeURIComponent(value);
  if (encodedValue.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }];
  }
  const chunks: string[] = [];
  let remaining = encodedValue;
  while (remaining.length > 0) {
    let encodedChunkHead = remaining.slice(0, MAX_CHUNK_SIZE);
    const lastEscapePos = encodedChunkHead.lastIndexOf("%");
    if (lastEscapePos > MAX_CHUNK_SIZE - 3) {
      encodedChunkHead = encodedChunkHead.slice(0, lastEscapePos);
    }
    let valueHead = "";
    while (encodedChunkHead.length > 0) {
      try {
        valueHead = decodeURIComponent(encodedChunkHead);
        break;
      } catch (e) {
        if (
          e instanceof URIError &&
          encodedChunkHead.at(-3) === "%" &&
          encodedChunkHead.length > 3
        ) {
          encodedChunkHead = encodedChunkHead.slice(0, encodedChunkHead.length - 3);
        } else {
          throw e;
        }
      }
    }
    chunks.push(valueHead);
    remaining = remaining.slice(encodedChunkHead.length);
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }));
}

function projectRefFromUrl(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "local";
  }
}

async function loginAsGovt(): Promise<string> {
  if (process.env.PROBE_COOKIE) {
    console.error("[load-probe] Using PROBE_COOKIE from env (skipping headless login).");
    return process.env.PROBE_COOKIE;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — set PROBE_COOKIE " +
        "instead (see docs/ops/load-probe.md for how to capture one).",
    );
  }

  console.error(`[load-probe] Signing in ${GOVT_EMAIL} against ${supabaseUrl} ...`);
  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: GOVT_EMAIL,
    password: GOVT_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${GOVT_EMAIL}: ${error?.message ?? "no session returned"}`);
  }
  // Institutional accounts owe TOTP since T2-S6: bring the session to aal2
  // (no-op for personal accounts). scripts/lib/seed-mfa.ts.
  await upgradeSeedSessionToAal2(supabase, GOVT_EMAIL, GOVT_PASSWORD);
  const session = (await supabase.auth.getSession()).data.session ?? data.session;

  const projectRef = projectRefFromUrl(supabaseUrl);
  const cookieKey = `sb-${projectRef}-auth-token`;
  const sessionJson = JSON.stringify(session);
  const pairs = createChunks(cookieKey, sessionJson);
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}

// ---------------------------------------------------------------------------
// Request firing
// ---------------------------------------------------------------------------

type RequestResult = {
  status: number;
  latencyMs: number;
  cacheHeaderValue: string | null;
  error?: string;
};

async function fireOne(endpoint: EndpointSpec, cookie: string): Promise<RequestResult> {
  const headers: Record<string, string> = {};
  if (endpoint.auth) headers.Cookie = cookie;
  const t0 = performance.now();
  try {
    const resp = await fetch(`${PROBE_URL}${endpoint.path}`, { headers, redirect: "manual" });
    // Drain the body — total latency should include body read, matching what
    // a real client pays, not just time-to-first-byte.
    await resp.text();
    const latencyMs = performance.now() - t0;
    const cacheHeaderValue = endpoint.cacheHeader ? resp.headers.get(endpoint.cacheHeader) : null;
    return { status: resp.status, latencyMs, cacheHeaderValue };
  } catch (e) {
    return {
      status: 0,
      latencyMs: performance.now() - t0,
      cacheHeaderValue: null,
      error: String(e),
    };
  }
}

function fireWave(endpoint: EndpointSpec, cookie: string): Promise<RequestResult[]> {
  return Promise.all(Array.from({ length: CONCURRENCY }, () => fireOne(endpoint, cookie)));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// Per-endpoint probe + PASS/FAIL evaluation
// ---------------------------------------------------------------------------

type EndpointReport = {
  endpoint: EndpointSpec;
  requestCount: number;
  p50: number;
  p95: number;
  max: number;
  errorCount: number; // 5xx or fetch failure
  degradedCount: number; // 4xx (auth misconfiguration, rate limit, etc.)
  cacheDistribution: Record<string, number>;
  pass: boolean;
  failReasons: string[];
};

async function probeEndpoint(endpoint: EndpointSpec, cookie: string): Promise<EndpointReport> {
  const results: RequestResult[] = [];
  for (let w = 0; w < WAVES; w++) {
    process.stderr.write(
      `  ${endpoint.name} wave ${w + 1}/${WAVES} (${CONCURRENCY}x concurrent) ... `,
    );
    const wave = await fireWave(endpoint, cookie);
    results.push(...wave);
    const okCount = wave.filter((r) => r.status >= 200 && r.status < 300).length;
    process.stderr.write(`${okCount}/${wave.length} ok\n`);
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const max = latencies.at(-1) ?? 0;

  const errorCount = results.filter((r) => r.status >= 500 || r.status === 0).length;
  const degradedCount = results.filter((r) => r.status >= 400 && r.status < 500).length;

  const cacheDistribution: Record<string, number> = {};
  if (endpoint.cacheHeader) {
    for (const r of results) {
      const key = r.cacheHeaderValue ?? "absent";
      cacheDistribution[key] = (cacheDistribution[key] ?? 0) + 1;
    }
  }

  const failReasons: string[] = [];
  if (p95 > endpoint.p95TargetMs) {
    failReasons.push(`p95 ${p95.toFixed(0)}ms exceeds target ${endpoint.p95TargetMs}ms`);
  }
  if (errorCount > 0) {
    failReasons.push(`${errorCount} request(s) returned 5xx or failed to fetch`);
  }

  return {
    endpoint,
    requestCount: results.length,
    p50,
    p95,
    max,
    errorCount,
    degradedCount,
    cacheDistribution,
    pass: failReasons.length === 0,
    failReasons,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(reports: EndpointReport[]): boolean {
  console.log("\n");
  console.log("=".repeat(100));
  console.log("  DIM/MiMAR LOAD PROBE REPORT");
  console.log(`  Target: ${PROBE_URL}   Waves: ${WAVES} x ${CONCURRENCY} concurrent`);
  console.log("=".repeat(100));
  console.log(
    `  ${"Endpoint".padEnd(12)} ${"reqs".padEnd(6)} ${"p50".padEnd(9)} ${"p95".padEnd(9)} ${"max".padEnd(9)} ${"5xx".padEnd(5)} ${"4xx".padEnd(5)} Result`,
  );
  console.log(`  ${"-".repeat(96)}`);

  for (const r of reports) {
    console.log(
      `  ${r.endpoint.name.padEnd(12)} ${String(r.requestCount).padEnd(6)} ${`${r.p50.toFixed(0)}ms`.padEnd(9)} ${`${r.p95.toFixed(0)}ms`.padEnd(9)} ${`${r.max.toFixed(0)}ms`.padEnd(9)} ${String(r.errorCount).padEnd(5)} ${String(r.degradedCount).padEnd(5)} ${r.pass ? "PASS" : "FAIL"}`,
    );
    for (const reason of r.failReasons) {
      console.log(`    ✗ ${reason}`);
    }
    if (r.endpoint.cacheHeader) {
      const dist = Object.entries(r.cacheDistribution)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.log(`    cache (${r.endpoint.cacheHeader}): ${dist}`);
    }
  }

  console.log("=".repeat(100));
  const overallPass = reports.every((r) => r.pass);
  console.log(`\n  OVERALL: ${overallPass ? "PASS" : "FAIL"}\n`);
  return overallPass;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error(`[load-probe] Target: ${PROBE_URL} (${isLocalTarget ? "local" : "remote"})`);
  console.error(`[load-probe] Waves: ${WAVES} x ${CONCURRENCY} concurrent`);
  console.error(
    `[load-probe] Targets: health p95 < ${HEALTH_P95_TARGET_MS}ms, API p95 < ${API_P95_TARGET_MS}ms, no 5xx`,
  );

  const cookie = await loginAsGovt();
  console.error("[load-probe] Login OK.\n");

  const reports: EndpointReport[] = [];
  for (const endpoint of ENDPOINTS) {
    console.error(`[load-probe] Probing ${endpoint.name} (${endpoint.path}) ...`);
    reports.push(await probeEndpoint(endpoint, cookie));
  }

  const overallPass = printReport(reports);
  process.exit(overallPass ? 0 : 1);
}

main().catch((e) => {
  console.error("[load-probe] Fatal error:", e);
  process.exit(1);
});
