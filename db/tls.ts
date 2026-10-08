// TLS for every postgres.js client in this repo (security hotfix, 2026-10).
//
// postgres.js defaults to `ssl: false`: with no `sslmode` in the URL it speaks
// plaintext. Staging's Supabase pooler (aws-…pooler.supabase.com) ACCEPTS a
// plaintext connection, and the configured DATABASE_URL carried no sslmode, so
// the app → database leg (password exchange and every row) crossed the internet
// unencrypted. Nothing failed, which is exactly why nobody saw it.
//
// The rule, in one place, applied by every `postgres(` call site (pinned by
// db/__tests__/postgres-tls-callsites.test.ts so a new client cannot forget it):
//
//   1. An explicit `sslmode` / `ssl` / `sslrootcert=system` in the URL wins, with
//      exactly the meaning postgres.js gives it. Passing the `ssl` OPTION would
//      otherwise silently override the URL (postgres.js reads `k in options`
//      before the query string), so the helper reproduces that parse itself.
//   2. EXCEPT: an explicit plaintext request (`sslmode=disable`, `ssl=false`) on a
//      NON-local host THROWS in production (`NODE_ENV=production` or any
//      `VERCEL_ENV`). A production deploy must never be one URL edit away from
//      plaintext without anyone noticing.
//   3. Otherwise a local host gets `false` (the Supabase CLI stack does not speak
//      TLS, and loopback traffic never leaves the machine) and every other host
//      gets `"require"`: encrypted, certificate NOT verified. That is the floor,
//      not the ceiling — verify-full against Supabase's published CA is the
//      follow-up (it needs the CA bundle shipped with the app).
//
// "Local" is loopback, on ANY port: the writer-grade host set in
// scripts/_db-target.ts (localhost, 127.0.0.1, ::1). The Supabase CLI's ports
// (54322 database, 54329 pooler) are all on loopback. The read-only fences'
// broader LOCAL_HOSTS (`db`, `host.docker.internal`, …) is deliberately NOT used:
// a name a DNS search domain could resolve elsewhere does not get to skip TLS.

import type postgres from "postgres";

import { WRITER_LOCAL_HOSTS, describeTarget } from "../scripts/_db-target";

/** The `ssl` option postgres.js accepts. */
export type PostgresSsl = postgres.Options<Record<string, postgres.PostgresType>>["ssl"];

type Env = Record<string, string | undefined>;

/** True when a database at this URL is on this machine (loopback, any port). */
export function isLoopbackDatabaseUrl(url: string): boolean {
  const target = describeTarget(url);
  return target.parseError === null && WRITER_LOCAL_HOSTS.has(target.host);
}

function isProductionRuntime(env: Env): boolean {
  return env.NODE_ENV === "production" || Boolean(env.VERCEL_ENV);
}

/**
 * The TLS request the URL itself makes, as postgres.js would read it, or
 * `undefined` when it makes none. Mirrors postgres.js 3.4.x parseOptions:
 * `sslmode` is copied over `ssl`, `sslrootcert=system` forces verify-full, and
 * `disable` / `false` mean no TLS.
 */
function explicitSslFromUrl(url: string): PostgresSsl | undefined {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return undefined;
  }
  if (params.get("sslrootcert") === "system") return "verify-full";
  const raw = params.get("sslmode") ?? params.get("ssl");
  if (raw === null || raw === "") return undefined;
  if (raw === "disable" || raw === "false") return false;
  return raw as PostgresSsl;
}

/**
 * The `ssl` option for a postgres.js client connecting to `url`. Every call
 * site passes it as `ssl: postgresTlsOption(<the same url>)`.
 *
 * An absent URL returns `false`: postgres.js then falls back to localhost, and
 * the db/index.ts pool built without DATABASE_URL is never queried.
 */
export function postgresTlsOption(url: string | undefined, env: Env = process.env): PostgresSsl {
  if (!url) return false;
  const local = isLoopbackDatabaseUrl(url);
  const explicit = explicitSslFromUrl(url);

  if (explicit !== undefined) {
    if (explicit === false && !local && isProductionRuntime(env)) {
      throw new Error(
        [
          `[db/tls] The database URL for ${describeTarget(url).label} asks for NO TLS`,
          "(sslmode=disable or ssl=false) on a non-local host in production. Refusing to",
          "send credentials and data in plaintext: remove the parameter (TLS is then required).",
        ].join(" "),
      );
    }
    return explicit;
  }

  return local ? false : "require";
}
