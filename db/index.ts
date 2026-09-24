// Database client. Use this `db` export from server-side code (server components,
// server actions, route handlers). NEVER import this file into client components.

// Enforced boundary: pulling this module into a CLIENT bundle is now a hard build
// error with a clear message, instead of the cryptic postgres "Can't resolve 'net'".
// (Type-only `import type { ... } from "@/db"` is erased and unaffected. For const
// values/enums from the schema, import from "@/db/schema" in client code.)
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL guard — DEFERRED to first use, not thrown at module load.
//
// This module used to `throw` here at import time when DATABASE_URL was unset.
// That made `next build` page-data collection hard-fail ("DATABASE_URL is not
// set") for any route that imports @/db (e.g. /auth/callback) whenever the build
// environment lacked the var — the Vercel branch/preview builds, which don't
// carry DATABASE_URL, all died here. postgres() itself is lazy (it connects on
// first query, never at construction — verified), so the ONLY import-time
// failure was this throw.
//
// We now keep import side-effect-free: when DATABASE_URL is present the exports
// are the real drizzle handles (identical behaviour); when it is absent they are
// proxies that throw the SAME clear message on first access, so a genuinely
// misconfigured runtime still fails loudly — just not at build time.
const DATABASE_URL_PRESENT = Boolean(process.env.DATABASE_URL);

function missingDatabaseUrl(handle: "db" | "analyticsDb"): never {
  throw new Error(`DATABASE_URL is not set in environment (accessed \`${handle}\`)`);
}

function missingDbProxy(handle: "db" | "analyticsDb"): PostgresJsDatabase<typeof schema> {
  return new Proxy({} as PostgresJsDatabase<typeof schema>, {
    get: () => missingDatabaseUrl(handle),
    apply: () => missingDatabaseUrl(handle),
    has: () => missingDatabaseUrl(handle),
  });
}

// In test environments (vitest runs with fileParallelism:false — one file at a
// time, single process) a large pool is wasteful and causes "worker exited
// unexpectedly" errors when connections outlive the worker lifespan or exhaust
// the Postgres connection limit (Supabase local default: 100).
//
// Cap the pool at 3 in tests:
//   - Enough for concurrent awaits within a single test file (most files do
//     ≤ 3 concurrent queries).
//   - idle_timeout: return idle connections quickly so the next test file
//     doesn't inherit open sockets from the previous file's cleanup.
//   - connect_timeout: fail fast rather than hanging if the local stack is not
//     started (gives a clear error instead of a silent hang → worker-exit).
//   - max_lifetime: recycle connections after 60 s so long-running suites do
//     not accumulate stale state across hundreds of test files.
//
// In production the default max (10) is fine; Supavisor/pgBouncer sits in
// front anyway.
const isTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";

// Dev-only HMR guard: Next.js re-evaluates this module on every hot reload. Without
// caching the client, each recompile spins up a NEW postgres-js pool (default max 10)
// without closing the previous one — leaked pools accumulate until Postgres runs out
// of connection slots, at which point auth's profile lookup fails and the user is
// bounced to /login (looks like a 1-2 min "session expiry" on heavy operator pages).
// Caching on globalThis reuses one pool across reloads. NOT applied in test (vitest
// runs files serially in one process and relies on per-file pool recycling) or in
// production (no HMR; Supavisor/pgBouncer sits in front).
const globalForDb = globalThis as unknown as {
  __dimPgClient?: ReturnType<typeof postgres>;
  __dimPgAnalyticsClient?: ReturnType<typeof postgres>;
};

// SERVERLESS RESILIENCE (task #74 — staging DB death spiral). On Vercel each
// lambda holds its own postgres-js pool in front of the Supabase transaction
// pooler (supavisor, port 6543). Under contention on the shared micro DB the
// pooler degrades and queries hang; abandoned/slow connections then starve the
// pool further (the spiral). These options make the client FAIL FAST and RELEASE
// connections PROMPTLY instead of accumulating stuck backends. Each is chosen
// deliberately:
//   - max: 5 — keep the per-lambda pool SMALL. The console fans out ~11 queries;
//     multiplexing them over a few connections bounds how many backends one
//     lambda can pin on the shared micro DB (the root of the spiral). The client
//     budget (withDbBudget) bounds total latency so the queue can't hang a request.
//   - connect_timeout: 10s — fail with a clear error instead of hanging when the
//     pooler is unreachable/saturated.
//   - idle_timeout: 20s — return idle connections to the pooler quickly so a warm
//     lambda doesn't sit on backends between requests.
//   - max_lifetime: 300s — recycle connections so none lingers across the pooler's
//     own recycling and accumulates stale/degraded server-side state.
//   - statement_timeout / idle_in_transaction_session_timeout (15s) — the DB-level
//     backstop, sent as the libpq `options` startup parameter (`-c ...`). It
//     cancels a runaway query server-side (SQLSTATE 57014) so it releases its
//     pooler slot — verified against direct Postgres. ⚠️ MEASURED ON STAGING
//     (task #74 follow-up): supavisor TRANSACTION mode (6543) does NOT apply
//     this startup parameter — `show statement_timeout` through the pooler
//     returns the server default. It still protects direct + local + SESSION-
//     pooler connections, which is why the analytics client below (session
//     pooler) is where it actually bites in production.
// Tests keep the tighter, no-statement-timeout profile (local direct DB, serial
// runner) — a 15s statement_timeout could flake a legitimately slow suite.
const client =
  globalForDb.__dimPgClient ??
  // Cast: when DATABASE_URL is unset this pool is never queried (the `db` export
  // is the missing-url proxy), and postgres() constructs lazily either way.
  postgres(process.env.DATABASE_URL as string, {
    prepare: false,
    // keep_alive: TCP SO_KEEPALIVE probe delay. Without it, a socket silently
    // dropped by a NAT/pooler between packets becomes a zombie: the pool never
    // learns it died and the next query queues forever behind it (observed
    // twice on 2026-08-14 — multi-hour remote seed runs wedging mid-province
    // with zero errors). With probes the OS errors the socket, the pool evicts
    // it, and the next query reconnects. Short-lived serverless connections
    // never reach the first probe, so this is a no-op in lambdas.
    keep_alive: 30,
    ...(isTest
      ? {
          max: 3,
          idle_timeout: 20, // seconds — return idle connections quickly between files
          connect_timeout: 10, // seconds — fail fast when the local stack isn't running
          max_lifetime: 60, // seconds — recycle to avoid stale-state accumulation
        }
      : {
          max: 5, // small per-lambda pool — bounds backends pinned on the shared DB
          connect_timeout: 10, // seconds — fail fast when the pooler is saturated
          idle_timeout: 20, // seconds — release idle connections back to the pooler
          max_lifetime: 300, // seconds — recycle to avoid stale/degraded connections
          connection: {
            // Server-side query + idle-txn ceilings, forwarded through the
            // transaction pooler as libpq startup `options`. 15s > the client
            // budget so the client degrades first; this only fires for a truly
            // runaway query, cancelling it so it releases its pooler slot.
            options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000",
          },
        }),
  });

if (process.env.NODE_ENV === "development") globalForDb.__dimPgClient = client;

export const db: PostgresJsDatabase<typeof schema> = DATABASE_URL_PRESENT
  ? drizzle(client, { schema })
  : missingDbProxy("db");

// ---------------------------------------------------------------------------
// ANALYTICS pool (task #74 follow-up — dual-pool split).
//
// MEASURED ON STAGING: the panorama analytics fan-out (getPanoramaKpis,
// universal scope, 3y window — ~11 aggregate statements) runs in ~1.7s through
// the SESSION pooler (5432) but >180s through the TRANSACTION pooler (6543) on
// the SAME freshly-restarted DB — a >100x supavisor transaction-mode pathology
// for many-statement analytics reads. And transaction mode ignores the
// `options` startup GUCs, so no statement_timeout lands there either.
//
// Split the traffic:
//   - `db` (above, DATABASE_URL → transaction pooler): ALL OLTP — short reads,
//     every write. Transaction mode is the only mode a micro instance survives
//     under wide lambda concurrency, so OLTP stays there.
//   - `analyticsDb` (ANALYTICS_DATABASE_URL → SESSION pooler, 5432): ONLY the
//     heavy read-only analytics paths (panorama repository + the dashboard
//     fetchers getPanoramaKpis composes). Falls back to DATABASE_URL when the
//     var is unset (local dev/direct connections behave identically).
//
// Session-pooler-appropriate settings — session mode assigns ONE backend per
// client connection for the connection's LIFETIME, so the pool must be tiny and
// must let go of backends fast:
//   - max: 3 — hard-bounds the backends this lambda can pin (the fan-out
//     multiplexes over them; measured total is ~1.7s anyway).
//   - idle_timeout: 10s — release the backend quickly after the burst; a warm
//     lambda must not sit on session-pooler backends between requests.
//   - max_lifetime: 300s + connect_timeout: 10s — same recycling/fail-fast
//     rationale as the OLTP pool.
//   - statement_timeout / idle_in_transaction_session_timeout (15s): session
//     mode DOES honor startup GUCs (verified: SQLSTATE 57014 cancellation), so
//     the runaway-query backstop is real on this pool.
//
// Analytics statement_timeout (ms). Default 15s — the request-path backstop.
//
// NOTE (task #22, cube read-handle): raising ANALYTICS_STATEMENT_TIMEOUT_MS is NOT
// how a background job escapes the 15s backstop anymore. The value bakes into the
// pool at MODULE LOAD, and on Vercel env vars are per-deployment — so the old
// "the cube builder sets it to 120000" wiring never worked there (the cron imports
// the builder statically → the pool is constructed with 15s before the handler
// runs). Background builders now construct their OWN lazy read client and route
// downstream reads to it via runWithAnalyticsReadHandle (below). This env stays
// honored as a deliberate project-wide override only.
/** Resolve the analytics pool's statement_timeout (ms) from env; default 15000 —
 * the request-path backstop (task #74 death-spiral protection). Pure; exported so
 * tests can pin the default without constructing a pool. */
export function analyticsStatementTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return Number(env.ANALYTICS_STATEMENT_TIMEOUT_MS ?? "15000");
}

/** libpq startup `options` string carrying the server-side query + idle-txn
 * ceilings. Session-pooler and direct connections honor it (verified SQLSTATE
 * 57014); the transaction pooler ignores it. Pure; shared by every client here
 * and by the cube builder's dedicated clients. */
export function statementTimeoutOptions(ms: number): string {
  return `-c statement_timeout=${ms} -c idle_in_transaction_session_timeout=${ms}`;
}

const ANALYTICS_STATEMENT_TIMEOUT_MS = analyticsStatementTimeoutMs();

// In tests both exports share ONE pool (max 3): the analytics split is a
// production concern, and a second pool would double connections per test file.
const analyticsClient = isTest
  ? client
  : (globalForDb.__dimPgAnalyticsClient ??
    postgres((process.env.ANALYTICS_DATABASE_URL ?? process.env.DATABASE_URL) as string, {
      prepare: false, // harmless on session mode; keeps the DATABASE_URL fallback transaction-pooler-safe
      // max: 2 — MEASURED ON STAGING (2026-07-09), retuned after perf 1.1/1.2.
      // The old max: 1 hard-bounded backends back when a load fanned out to the
      // page SSR + ~5 concurrent /api/panorama/[layer] lambdas; at max 3 each,
      // that burst exhausted the session pooler's pool_size (15) with
      // EMAXCONNSESSION → every layer 503'd ("Sin datos para esta capa") and the
      // KPI fan-out starved past its budget (degraded tiles). After 1.1
      // (cross-request layer cache) + 1.2 (first-visit preset seed) a cold
      // panorama load is now only ~4 analytics lambdas: the page SSR + the
      // /api/panorama/kpis route + at most 2 layer cache-misses. At max 2 that is
      // ~8 backends per cold user; 3 concurrent cold users ≈ 24, comfortably
      // under the raised pool_size (30, up from 15). The 2nd connection lets the
      // ~11-statement KPI fan-out and a layer aggregate progress in parallel
      // instead of serializing over one warm backend, without re-risking
      // EMAXCONNSESSION.
      max: 2,
      keep_alive: 30, // TCP probes — evict silently-dropped sockets (see main client note)
      connect_timeout: 10, // seconds — fail fast when the pooler is saturated
      idle_timeout: 5, // seconds — release session-pooler backends fast (was 10; see max note)
      max_lifetime: 300, // seconds — recycle to avoid stale/degraded connections
      connection: {
        // Session mode honors this startup GUC (verified: SQLSTATE 57014). 15s is
        // the request-path backstop, ALWAYS. A background builder (the panorama
        // cube refresh) does NOT raise it here — it brings its own lazy read client
        // with a long timeout and routes reads to it via runWithAnalyticsReadHandle
        // (task #22; see cube-builder.ts).
        options: statementTimeoutOptions(ANALYTICS_STATEMENT_TIMEOUT_MS),
      },
    }));

if (process.env.NODE_ENV === "development") globalForDb.__dimPgAnalyticsClient = analyticsClient;

// LOUD startup warning (task #74 follow-up): in production, an unset
// ANALYTICS_DATABASE_URL silently routes heavy analytics onto the DATABASE_URL
// transaction pooler (6543). Measured on staging, that pooler ignores the
// statement_timeout GUC and exhibits a >100x (>180s) pathology for the
// many-statement panorama fan-out — so admin panorama KPIs permanently render
// the degraded state and the 15s backstop never fires. The fallback MUST keep
// working for local dev, so we do NOT throw — we warn once at module load so a
// misconfigured production deploy is impossible to miss in the logs.
// Fix: set ANALYTICS_DATABASE_URL to the SESSION pooler (5432) string (the
// dual-pool split; deploy checklist in the internal ops docs).
if (process.env.NODE_ENV === "production" && !process.env.ANALYTICS_DATABASE_URL) {
  console.warn(
    "[db] ANALYTICS_DATABASE_URL is UNSET in production — heavy analytics are " +
      "falling back to the DATABASE_URL transaction pooler (6543), which ignores " +
      "the 15s statement_timeout backstop and shows a measured >180s pathology " +
      "for the panorama fan-out (admin KPIs will render the degraded state). " +
      "Set it to the SESSION pooler (5432) string (dual-pool split).",
  );
}

// The REAL analytics handle (15s request-path backstop baked in). Internal —
// consumers get the `analyticsDb` proxy below, which resolves to this unless a
// background builder has installed an override for the current async context.
const realAnalyticsDb: PostgresJsDatabase<typeof schema> = DATABASE_URL_PRESENT
  ? drizzle(analyticsClient, { schema })
  : missingDbProxy("analyticsDb");

// ---------------------------------------------------------------------------
// Analytics READ-handle override (task #22 — cube refresh read-timeout fix).
//
// PROBLEM: the cube builder's heavy reads reuse the live panorama loaders, which
// (transitively, across lib/metrics + lib/analytics fetchers) all resolve to the
// module-level `analyticsDb` — whose 15s statement_timeout is baked at module
// load. A national-scale rollup (a Buenos Aires department read measures ~96s)
// is cancelled at 15s (SQLSTATE 57014) → the whole atomic build fails → the
// reader falls back to live for everything. Raising the timeout project-wide
// would reopen the request-path death-spiral the 15s backstop prevents (#74).
//
// FIX: an AsyncLocalStorage override. A background builder constructs its own
// session-pooler client with a LONG statement_timeout, LAZILY (per invocation,
// not at module load), and runs its read phase inside
// `runWithAnalyticsReadHandle(readDb, …)`. Every `analyticsDb` method call in
// that async context — at ANY module depth, with ZERO call-site changes —
// dispatches to the override. Request paths never install an override, so they
// keep the 15s backstop untouched.
// ---------------------------------------------------------------------------
const analyticsReadOverride = new AsyncLocalStorage<PostgresJsDatabase<typeof schema>>();

/** Run `fn` with every `analyticsDb` call in its async context dispatched to
 * `handle` (a dedicated long-timeout client). Background builders ONLY — never
 * install an override on a request path. */
export async function runWithAnalyticsReadHandle<T>(
  handle: PostgresJsDatabase<typeof schema>,
  fn: () => Promise<T>,
): Promise<T> {
  return analyticsReadOverride.run(handle, fn);
}

/** The analytics handle active in the current async context: the installed
 * override, or the real request-path handle. Exported as a test seam. */
export function resolveAnalyticsReadHandle(): PostgresJsDatabase<typeof schema> {
  return analyticsReadOverride.getStore() ?? realAnalyticsDb;
}

/**
 * Drizzle handle for HEAVY READ-ONLY analytics (panorama fan-out + the
 * dashboard fetchers it composes). Routed through the session pooler in
 * production (`ANALYTICS_DATABASE_URL`). Never use this for writes or for
 * request-path OLTP reads — those belong on `db`.
 *
 * Dispatch note: this is a thin per-call proxy over `resolveAnalyticsReadHandle()`
 * so a background builder's read-handle override (above) is honored transparently.
 * With no override installed it is behaviorally identical to the raw handle.
 */
export const analyticsDb: PostgresJsDatabase<typeof schema> = new Proxy(realAnalyticsDb, {
  get(_target, prop) {
    const active = resolveAnalyticsReadHandle();
    const value = Reflect.get(active as object, prop, active);
    // Bind methods to the RESOLVED handle so drizzle's internal `this` stays
    // consistent (never the proxy). Fluent chains continue on `active` directly.
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(active)
      : value;
  },
});

/**
 * Close the postgres.js pool(s) held by THIS module registry. Test lifecycle
 * only — never call it from app code, which wants its pool to outlive a request.
 *
 * WHY IT EXISTS: vitest gives each test file its own module registry, so each
 * db-project file builds its own pool. The previous design ABANDONED those pools
 * and leaned on `idle_timeout: 20` to drain them 20 seconds later. That race is
 * only won if the run keeps going for another 20 seconds — when the last file
 * finishes, the worker exits immediately and the still-open sockets are torn
 * down under it, which surfaced as:
 *
 *   Error: [vitest-pool]: Worker forks emitted error
 *   Caused by: Error: Worker exited unexpectedly
 *
 * That made `pnpm test` exit 1 on a run with ZERO failing tests, and a suite
 * whose exit code is 1 by design cannot tell a real regression from its own
 * noise — the instrument stops measuring. Draining explicitly at the end of each
 * file makes the recycling the comment above already claims actually happen.
 *
 * In test `analyticsClient === client`, so the Set collapses to one pool; in
 * other environments it closes both.
 */
export async function closeDbPools(): Promise<void> {
  if (!DATABASE_URL_PRESENT) return;
  const pools = new Set([client, analyticsClient]);
  await Promise.all(
    // Never let a teardown failure fail a green run: the pool is being discarded
    // either way, and this function exists to REMOVE exit-code noise.
    [...pools].map((pool) => pool.end({ timeout: 5 }).catch(() => undefined)),
  );
}

// Re-export everything from schema so app code can `import { pets, db } from "@/db"`.
export * from "./schema";
