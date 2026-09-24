import { readFileSync } from "node:fs";

/**
 * Resolve the base URL the QA-night specs (race battery + synthetic monitor)
 * point at. Unlike the operator/crisis suites — which run against the local
 * :3000 QA server — these two suites are meant to be aimed at the DEPLOYED
 * staging origin, which changes on every deploy (the PO drops the current URL
 * into a scratchpad file and/or exports it).
 *
 * Resolution order (first non-empty wins):
 *   1. process.env.STAGING_URL         — explicit override (CI, ad-hoc runs).
 *   2. file at process.env.STAGING_URL_FILE — a text file whose first line is
 *      the current staging origin (the per-deploy scratchpad file).
 *
 * (A third step used to read a hard-coded file under one developer's local
 * temp directory. It pointed at a session that no longer exists and put a
 * personal machine path in public code; set STAGING_URL_FILE instead.)
 *
 * ─── WHY THERE IS NO LONGER A `localhost:3000` FALLBACK ────────────────────
 * There used to be a fourth step: `http://localhost:${QA_PORT ?? 3000}`. It
 * reads like a harmless convenience and it cost the project FIVE of the 21
 * failures in the first e2e run that ever reported a verdict (run
 * 30582117433). In GitHub Actions none of steps 1-3 resolve, QA_PORT is unset,
 * and the suite's own server is on :3333 — so both QA-night specs pinned
 * themselves with `test.use({ baseURL })` to a port nothing was listening on
 * and died with `net::ERR_CONNECTION_REFUSED at http://localhost:3000/login`
 * before asserting anything. The fallback did not point the specs at the
 * running app; it pointed them AWAY from it, and it overrode the one value
 * that was already correct.
 *
 * So: when no staging origin is configured, resolve to NOTHING and let the
 * spec inherit the Playwright config's own `baseURL` — :3333 under
 * playwright.config.ts, `QA_PORT` under playwright.local3000.config.ts. The
 * config already knows where the server is. Callers use the `baseURL` fixture
 * (which reflects file-level `test.use` overrides) when they need the value.
 *
 * The returned value never carries a trailing slash so callers can safely do
 * `base + "/login"`.
 */

function readFirstLine(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const first = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first ?? null;
  } catch {
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The explicitly-configured deployed staging origin, or `null` when none is
 * configured and the spec should therefore stay on the suite's own baseURL.
 *
 * A spec pins itself to a staging deploy like this, and ONLY like this:
 *
 *   const STAGING = resolveStagingUrl();
 *   if (STAGING) test.use({ baseURL: STAGING });
 *
 * Never `test.use({ baseURL: STAGING ?? something })` — inventing a fallback
 * origin is the bug documented at the top of this file.
 */
export function resolveStagingUrl(): string | null {
  const envUrl = process.env.STAGING_URL?.trim();
  if (envUrl) return stripTrailingSlash(envUrl);

  const fileFromEnv = process.env.STAGING_URL_FILE?.trim();
  if (fileFromEnv) {
    const fromFile = readFirstLine(fileFromEnv);
    if (fromFile) return stripTrailingSlash(fromFile);
  }

  return null;
}

/**
 * Staging origin for specs that are MEANINGLESS anywhere else — currently only
 * e2e/perf/staging-panorama-perf.spec.ts, which measures deployed latency and
 * is excluded from playwright.config.ts for exactly that reason. Such a spec
 * must fail loudly rather than silently measure a localhost build.
 */
export function requireStagingUrl(): string {
  const url = resolveStagingUrl();
  if (!url) {
    throw new Error(
      "No staging origin configured. Set STAGING_URL (or STAGING_URL_FILE) — " +
        "this spec only means anything against a deployed origin.",
    );
  }
  return url;
}

/**
 * True when the resolved origin is a remote staging deploy (not localhost).
 * Specs use this to relax timeouts (cold serverless starts) and to decide
 * whether to attempt data-mutating races (safe on a throwaway staging DB).
 */
export function isRemoteStaging(base: string): boolean {
  return !/localhost|127\.0\.0\.1/.test(base);
}
