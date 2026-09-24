// Boot-time environment validation (ops/perf hardening, 2026-07-04).
//
// Problem this fixes: required server env vars were checked LATE and
// INCONSISTENTLY — db/index.ts throws at import time if DATABASE_URL is
// missing, lib/utils/dni-hash.ts throws only the FIRST TIME hashDni() is
// actually called (and only in production), CRON_SECRET fails closed
// per-request inside authorizeCronRequest, and the Supabase client keys
// (lib/supabase/server.ts, client.ts, admin.ts) silently fall back to `""`
// with NO validation at all — an empty-string Supabase key doesn't throw at
// boot, it fails later with an opaque error the first time a request
// actually touches Supabase. None of these give an operator a single clear
// "here's exactly what's missing" signal before traffic starts flowing.
//
// This module defines ONE zod schema covering every var the app needs to
// function, and a pure `parseEnv()` that throws ONE Error listing every
// missing/invalid var by name if validation fails. `env` is a typed,
// validated snapshot of `process.env` — see instrumentation.ts for where
// this gets imported at boot (register() runs once per server instance,
// before any request is served).
//
// Prod-only requirements: CRON_SECRET, DNI_HASH_PEPPER, and
// NEXT_PUBLIC_SITE_URL already have INTENTIONAL dev/test fallbacks
// documented elsewhere in the codebase (lib/domain/cron-auth.ts,
// lib/utils/dni-hash.ts, app/layout.tsx) — this schema must not fight those
// by forcing them outside production, or a local/test setup without a full
// .env.local would fail to boot.
//
// Deliberately NOT covered here (kept as call-site guards instead):
// feature-specific secrets only needed when that feature is actually
// exercised — MIARG_OIDC_*, TATTOO_ACK_SECRET, MICROCHIP_FORCE_SECRET,
// APPLY_INTENT_SECRET, RESEND_API_KEY, MAGIC_LINK_TTL_SECONDS. Forcing
// these at boot would fail environments that don't use those features yet.

import { z } from "zod";

/** The public dev-only DNI pepper (see ../utils/dni-hash.ts) — never valid in production. */
const DEV_TEST_DNI_PEPPER = "dim-test-pepper-v1";

function isProduction(source: NodeJS.ProcessEnv): boolean {
  return source.NODE_ENV === "production";
}

// A REAL production deployment (Vercel or self-hosted) — NOT merely
// NODE_ENV=production. `next start` for local QA runs in production mode against
// the LOCAL Supabase and must NOT require the prod-only secrets (it relies on
// the documented dev fallbacks). A real deploy talks to a REMOTE database, so
// key the prod-only requirements on that — this keeps any real host fail-closed
// while unblocking local production-mode QA (the boot 500 this fixes).
function isRealProdDeploy(source: NodeJS.ProcessEnv): boolean {
  const dbUrl = source.DATABASE_URL ?? "";
  const isLocalDb = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  return isProduction(source) && !isLocalDb;
}

function buildSchema(source: NodeJS.ProcessEnv) {
  const prod = isRealProdDeploy(source);

  return z.object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    NEXT_PUBLIC_SUPABASE_URL: z
      .string()
      .min(1, "NEXT_PUBLIC_SUPABASE_URL is required")
      .url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),

    // Prod-only — dev/test rely on the documented fallbacks in
    // app/layout.tsx / lib/domain/cron-auth.ts / lib/utils/dni-hash.ts
    // (see header comment above).
    NEXT_PUBLIC_SITE_URL: prod
      ? z
          .string()
          .min(1, "NEXT_PUBLIC_SITE_URL is required in production")
          .url("NEXT_PUBLIC_SITE_URL must be a valid URL")
      : z.string().optional(),
    CRON_SECRET: prod
      ? z.string().min(1, "CRON_SECRET is required in production")
      : z.string().optional(),
    DNI_HASH_PEPPER: prod
      ? z
          .string()
          .min(1, "DNI_HASH_PEPPER is required in production")
          .refine(
            (v) => v !== DEV_TEST_DNI_PEPPER,
            "DNI_HASH_PEPPER must not be the public dev default in production",
          )
      : z.string().optional(),
  });
}

export type Env = z.infer<ReturnType<typeof buildSchema>>;

/**
 * Parses `source` (normally `process.env`) against the required-server-env
 * schema. Throws ONE Error listing every missing/invalid var (by name) if
 * validation fails — never returns a partially-valid result.
 *
 * Pure function — takes `source` as a parameter (rather than reading
 * `process.env` internally) so it can be unit-tested with explicit fixtures
 * instead of mutating the real process environment.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = buildSchema(source).safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(unknown)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing environment variables:\n${issues}\n\nSet these in your .env.local (dev) or the deployment platform's environment configuration (prod) before starting the app.`,
    );
  }
  return result.data;
}

// Skip eager validation under vitest: this module is wired ONLY into
// instrumentation.ts (never imported by application code that tests
// exercise), and __tests__/setup.ts intentionally does not set every var in
// this schema (e.g. NEXT_PUBLIC_SITE_URL) since most suites never need it.
// The dedicated unit test (__tests__/env.test.ts) validates `parseEnv()`
// directly against explicit fixtures instead of depending on the real
// process.env of whichever machine/CI runs the suite.
const isTestRuntime = process.env.VITEST === "true" || process.env.NODE_ENV === "test";

/** Typed, validated snapshot of `process.env` — computed once at import. */
export const env: Env = isTestRuntime ? (process.env as unknown as Env) : parseEnv();
