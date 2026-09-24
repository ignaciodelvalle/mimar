/**
 * Page latency sweep for MiMAR production build at http://localhost:3001
 *
 * Usage: pnpm exec tsx scripts/qa-timing.ts
 *
 * For each route: 1 warm-up then 3 timed requests.
 * Records: median TTFB (time to first byte, body read excluded)
 *          and total time (including body read).
 * Also captures pg_stat_statements before/after for app query analysis.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { upgradeSeedSessionToAal2 } from "./lib/seed-mfa";

const BASE = "http://localhost:3001";
const REPS = 3;

// ---------------------------------------------------------------------------
// Auth helpers (same as qa-routes.ts)
// ---------------------------------------------------------------------------

const MAX_CHUNK_SIZE = 3180;

function createChunks(key: string, value: string): Array<{ name: string; value: string }> {
  let encodedValue = encodeURIComponent(value);
  if (encodedValue.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }];
  }
  const chunks: string[] = [];
  while (encodedValue.length > 0) {
    let encodedChunkHead = encodedValue.slice(0, MAX_CHUNK_SIZE);
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
    encodedValue = encodedValue.slice(encodedChunkHead.length);
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }));
}

async function getCookie(email: string, password: string): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Sign-in failed for ${email}: ${error?.message}`);
  // Institutional accounts owe TOTP since T2-S6: bring the session to aal2
  // (no-op for personal accounts). scripts/lib/seed-mfa.ts.
  await upgradeSeedSessionToAal2(supabase, email, password);
  const session = (await supabase.auth.getSession()).data.session ?? data.session;

  const url = new URL(supabaseUrl);
  const projectRef = url.hostname.split(".")[0];
  const cookieKey = `sb-${projectRef}-auth-token`;
  const sessionJson = JSON.stringify(session);
  const pairs = createChunks(cookieKey, sessionJson);
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

type TimingResult = {
  audience: string;
  route: string;
  status: number;
  ttfb_ms: number[]; // raw TTFB per rep
  total_ms: number[]; // raw total (TTFB + body) per rep
  median_ttfb: number;
  median_total: number;
  skipped?: boolean;
  error?: string;
};

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function timeRoute(
  audience: string,
  route: string,
  cookie: string | undefined,
): Promise<TimingResult> {
  const url = `${BASE}${route}`;
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;

  const ttfbs: number[] = [];
  const totals: number[] = [];
  let lastStatus = 0;
  let fetchError: string | undefined;

  // Warm-up (untimed)
  try {
    const resp = await fetch(url, { headers, redirect: "manual" });
    lastStatus = resp.status;
    await resp.text();
  } catch (e) {
    fetchError = String(e);
  }

  if (lastStatus === 404) {
    return {
      audience,
      route,
      status: 404,
      ttfb_ms: [],
      total_ms: [],
      median_ttfb: 0,
      median_total: 0,
      skipped: true,
    };
  }

  // Timed reps
  for (let i = 0; i < REPS; i++) {
    try {
      const t0 = performance.now();
      const resp = await fetch(url, { headers, redirect: "manual" });
      const ttfb = performance.now() - t0;
      lastStatus = resp.status;
      // Read body for total time
      await resp.text();
      const total = performance.now() - t0;
      ttfbs.push(ttfb);
      totals.push(total);
    } catch (e) {
      fetchError = String(e);
      ttfbs.push(-1);
      totals.push(-1);
    }
  }

  const validTtfb = ttfbs.filter((v) => v >= 0);
  const validTotal = totals.filter((v) => v >= 0);

  return {
    audience,
    route,
    status: lastStatus,
    ttfb_ms: validTtfb,
    total_ms: validTotal,
    median_ttfb: median(validTtfb),
    median_total: median(validTotal),
    error: fetchError,
  };
}

// ---------------------------------------------------------------------------
// pg_stat_statements helpers
// ---------------------------------------------------------------------------

async function pgQuery(sql: string): Promise<unknown[]> {
  const PGPASS = "postgres";
  const { execSync } = await import("node:child_process");
  // postgres superuser: supabase_admin lacks SELECT on pg_stat_statements.
  const cmd = `docker exec -e PGPASSWORD=${PGPASS} supabase_db_DIM psql -U postgres -d postgres -t -A -F"|||" -c "${sql.replace(/"/g, '\\"')}"`;
  try {
    const output = execSync(cmd, { encoding: "utf8" });
    return output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.split("|||"));
  } catch (e) {
    console.error("[pg] Query failed:", String(e));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error("[qa-timing] Signing in test users...");

  const ownerCookie = await getCookie("owner@dim.test", "Test1234!");
  console.error("[qa-timing] owner OK");
  const orgadminCookie = await getCookie("orgadmin@dim.test", "Test1234!");
  console.error("[qa-timing] orgadmin OK");
  const govtLocalCookie = await getCookie("govt-local@dim.test", "Test1234!");
  console.error("[qa-timing] govt-local OK");
  const adminCookie = await getCookie("admin@dim.test", "Test1234!");
  console.error("[qa-timing] admin OK");

  // Discover first pet token for owner
  console.error("[qa-timing] Discovering owner pet token...");
  let petToken: string | null = null;
  try {
    const resp = await fetch(`${BASE}/mis-mascotas`, {
      headers: { Cookie: ownerCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    const matches = [...html.matchAll(/href="\/mis-mascotas\/([A-Z0-9-]+)"/g)];
    const allTokens = [...new Set(matches.map((m) => m[1]))];
    const filtered = allTokens.filter((t) => !["nueva", "reclamar", "reclamar-dni"].includes(t));
    petToken = filtered[0] ?? null;
    console.error(`[qa-timing] Pet token: ${petToken}`);
  } catch (e) {
    console.error("[qa-timing] Could not discover pet token:", e);
  }

  // ---------------------------------------------------------------------------
  // Route inventory
  // ---------------------------------------------------------------------------

  type RouteSpec = { audience: string; route: string; cookie?: string };

  const ORG = "/org/DIM-D7MW-HHPE";

  const routes: RouteSpec[] = [
    // --- anon ---
    { audience: "anon", route: "/" },
    { audience: "anon", route: "/perdidas" },
    { audience: "anon", route: "/adoptar" },
    { audience: "anon", route: "/refugios" },
    { audience: "anon", route: "/denuncias/nueva" },
    { audience: "anon", route: "/casos" }, // skip if 404
    { audience: "anon", route: "/login" },

    // --- owner ---
    { audience: "owner", route: "/inicio", cookie: ownerCookie },
    { audience: "owner", route: "/mis-mascotas", cookie: ownerCookie },
    ...(petToken
      ? [
          { audience: "owner", route: `/mis-mascotas/${petToken}`, cookie: ownerCookie },
          {
            audience: "owner",
            route: `/mis-mascotas/${petToken}?tab=vacunas`,
            cookie: ownerCookie,
          },
        ]
      : []),
    { audience: "owner", route: "/notificaciones", cookie: ownerCookie },
    { audience: "owner", route: "/cuenta", cookie: ownerCookie },
    { audience: "owner", route: "/mis-turnos", cookie: ownerCookie },

    // --- orgadmin ---
    { audience: "orgadmin", route: `${ORG}`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/mascotas`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/agenda`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/casos`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/miembros`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/maltrato/recibidos`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/transferencias/recibidas`, cookie: orgadminCookie },
    { audience: "orgadmin", route: `${ORG}/servicios`, cookie: orgadminCookie },

    // --- govt-local ---
    { audience: "govt-local", route: "/gob", cookie: govtLocalCookie },
    { audience: "govt-local", route: "/gob/cola", cookie: govtLocalCookie },
    { audience: "govt-local", route: "/gob/perdidas", cookie: govtLocalCookie },
    { audience: "govt-local", route: "/gob/maltrato", cookie: govtLocalCookie },
    // F9 (2026-08-01): /gob/analytics is a redirect now — timing it would
    // measure the hop, not the dashboard. Point at the vista itself.
    { audience: "govt-local", route: "/gob/programa?vista=analitica", cookie: govtLocalCookie },
    { audience: "govt-local", route: "/gob/vigilancia", cookie: govtLocalCookie },
    { audience: "govt-local", route: "/gob/casos", cookie: govtLocalCookie },
    { audience: "govt-local", route: "/gob/usuarios?q=test", cookie: govtLocalCookie },

    // --- admin ---
    { audience: "admin", route: "/admin", cookie: adminCookie },
    { audience: "admin", route: "/admin/outbox", cookie: adminCookie },
    { audience: "admin", route: "/admin/sistema", cookie: adminCookie },
    { audience: "admin", route: "/admin/historial", cookie: adminCookie },
    { audience: "admin", route: "/admin/casos", cookie: adminCookie }, // skip if 404
  ];

  // ---------------------------------------------------------------------------
  // Warm-up pass (untimed) — also resets pg_stat_statements after warm-up
  // ---------------------------------------------------------------------------
  console.error(`\n[qa-timing] Warm-up pass (${routes.length} routes)...`);
  for (const { route, cookie } of routes) {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    try {
      const resp = await fetch(`${BASE}${route}`, { headers, redirect: "manual" });
      await resp.text();
      process.stderr.write(".");
    } catch {
      process.stderr.write("x");
    }
  }
  console.error("\n[qa-timing] Warm-up done.");

  // Reset pg_stat_statements AFTER warm-ups, BEFORE timed sweep
  console.error("[qa-timing] Resetting pg_stat_statements...");
  await pgQuery("SELECT pg_stat_statements_reset()");
  console.error("[qa-timing] pg_stat_statements reset OK.");

  // ---------------------------------------------------------------------------
  // Timed sweep
  // ---------------------------------------------------------------------------
  console.error(`\n[qa-timing] Timed sweep (${REPS} reps each)...`);
  const results: TimingResult[] = [];

  for (const { audience, route, cookie } of routes) {
    process.stderr.write(`  ${audience} ${route} ... `);
    const r = await timeRoute(audience, route, cookie);
    results.push(r);
    if (r.skipped) {
      process.stderr.write("SKIP (404)\n");
    } else if (r.error) {
      process.stderr.write(`ERROR: ${r.error}\n`);
    } else {
      process.stderr.write(
        `TTFB=${r.median_ttfb.toFixed(0)}ms total=${r.median_total.toFixed(0)}ms\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // pg_stat_statements — top 15 app queries
  // ---------------------------------------------------------------------------
  console.error("\n[qa-timing] Querying pg_stat_statements...");

  const statsRows = await pgQuery(`
    SELECT
      LEFT(query, 120) AS q,
      calls,
      ROUND(mean_exec_time::numeric, 2) AS mean_ms,
      ROUND(total_exec_time::numeric, 2) AS total_ms
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_%'
      AND query NOT ILIKE '%information_schema%'
      AND query NOT ILIKE '%pg_stat_statements%'
      AND calls > 0
    ORDER BY total_exec_time DESC
    LIMIT 15
  `);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  const audiences = ["anon", "owner", "orgadmin", "govt-local", "admin"];

  console.log("\n");
  console.log("═".repeat(110));
  console.log("  MIMAR PRODUCTION PAGE LATENCY REPORT  —  localhost:3001 (next start, seeded DB)");
  console.log("  Caveats: local DB is tiny (seeded only). Times are a FLOOR, not national-scale.");
  console.log(
    "  What matters: (a) relative ranking  (b) query COUNT per page  (c) pages slow even on tiny data",
  );
  console.log("═".repeat(110));

  for (const aud of audiences) {
    const audResults = results.filter((r) => r.audience === aud);
    if (audResults.length === 0) continue;

    console.log(`\n┌─ ${aud.toUpperCase()}`);
    console.log(
      `│  ${"Route".padEnd(50)} ${"Status".padEnd(8)} ${"Med TTFB".padEnd(12)} ${"Med Total".padEnd(12)} Notes`,
    );
    console.log(`│  ${"-".repeat(100)}`);

    for (const r of audResults) {
      const routeDisplay = r.route.length > 49 ? `${r.route.slice(0, 48)}…` : r.route.padEnd(50);
      const statusDisplay = String(r.status).padEnd(8);
      const ttfbDisplay = r.skipped
        ? "SKIPPED".padEnd(12)
        : `${r.median_ttfb.toFixed(0)} ms`.padEnd(12);
      const totalDisplay = r.skipped
        ? "SKIPPED".padEnd(12)
        : `${r.median_total.toFixed(0)} ms`.padEnd(12);
      const notes = r.error ? `ERR: ${r.error.slice(0, 40)}` : r.skipped ? "skip (404)" : "";
      console.log(`│  ${routeDisplay} ${statusDisplay} ${ttfbDisplay} ${totalDisplay} ${notes}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Slowest pages (ranked by median TTFB, non-skipped)
  // ---------------------------------------------------------------------------
  const ranked = results
    .filter((r) => !r.skipped && r.median_ttfb > 0)
    .sort((a, b) => b.median_ttfb - a.median_ttfb);

  console.log("\n");
  console.log("═".repeat(110));
  console.log("  RANKED BY MEDIAN TTFB (slowest first)");
  console.log("═".repeat(110));
  console.log(
    `  ${"#".padEnd(4)} ${"Audience".padEnd(12)} ${"Route".padEnd(50)} ${"Med TTFB".padEnd(12)} Med Total`,
  );
  console.log(`  ${"-".repeat(96)}`);
  ranked.slice(0, 20).forEach((r, i) => {
    const routeDisplay = r.route.length > 49 ? `${r.route.slice(0, 48)}…` : r.route.padEnd(50);
    console.log(
      `  ${String(i + 1).padEnd(4)} ${r.audience.padEnd(12)} ${routeDisplay} ${(`${r.median_ttfb.toFixed(0)} ms`).padEnd(12)} ${r.median_total.toFixed(0)} ms`,
    );
  });

  // ---------------------------------------------------------------------------
  // pg_stat_statements
  // ---------------------------------------------------------------------------
  console.log("\n");
  console.log("═".repeat(110));
  console.log(
    "  TOP 15 APP QUERIES BY TOTAL EXEC TIME  (pg_stat_statements, reset before timed sweep)",
  );
  console.log("═".repeat(110));
  console.log(
    `  ${"#".padEnd(4)} ${"calls".padEnd(8)} ${"mean_ms".padEnd(10)} ${"total_ms".padEnd(12)} Query (first 120 chars)`,
  );
  console.log(`  ${"-".repeat(106)}`);

  if (statsRows.length === 0) {
    console.log("  (no rows — pg_stat_statements may not be enabled or extension missing)");
  } else {
    statsRows.forEach((row, i) => {
      const cols = row as string[];
      const q = (cols[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      const calls = (cols[1] ?? "").padEnd(8);
      const meanMs = (cols[2] ?? "").padEnd(10);
      const totalMs = (cols[3] ?? "").padEnd(12);
      console.log(`  ${String(i + 1).padEnd(4)} ${calls} ${meanMs} ${totalMs} ${q}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Queries-per-page estimate for 5 worst pages
  // ---------------------------------------------------------------------------
  const totalPageLoads = results.filter((r) => !r.skipped && r.status < 400).length * REPS;
  const totalAppCalls = statsRows.reduce<number>((sum, row) => {
    const cols = row as string[];
    return sum + (Number.parseInt(cols[1] ?? "0", 10) || 0);
  }, 0);

  console.log("\n");
  console.log("═".repeat(110));
  console.log("  QUERIES-PER-PAGE ESTIMATE (5 WORST PAGES)");
  console.log(
    `  Total page loads in timed sweep: ${totalPageLoads}  |  Total tracked app DB calls: ${totalAppCalls}`,
  );
  console.log(
    `  Avg queries/page (across all routes): ${totalPageLoads > 0 ? (totalAppCalls / totalPageLoads).toFixed(1) : "n/a"}`,
  );
  console.log(
    "  Note: per-page breakdown requires per-route statement diffing; below uses TTFB as proxy for query depth.",
  );
  console.log("═".repeat(110));

  const worst5 = ranked.slice(0, 5);
  worst5.forEach((r, i) => {
    console.log(
      `  ${i + 1}. [${r.audience}] ${r.route}  →  TTFB ${r.median_ttfb.toFixed(0)}ms / total ${r.median_total.toFixed(0)}ms`,
    );
    console.log(
      "     Interpretation: high TTFB on tiny seeded data = sequential awaits / waterfall queries, not volume.",
    );
  });

  console.log("\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("[qa-timing] Fatal error:", e);
  process.exit(1);
});
