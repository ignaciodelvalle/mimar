// Unit tests for lib/infra/env.ts — boot-time required-server-env validation.
//
// Branches:
//   1. A complete, valid env fixture parses successfully and returns typed values.
//   2. A missing ALWAYS-required var (e.g. DATABASE_URL) throws, naming the var.
//   3. Multiple missing vars are all listed in the single thrown error.
//   4. Prod-only vars (CRON_SECRET, DNI_HASH_PEPPER, NEXT_PUBLIC_SITE_URL) are
//      NOT required outside production (dev/test fall back elsewhere).
//   5. Prod-only vars ARE required when NODE_ENV === "production", and the
//      DNI dev-default pepper is rejected in production.
//
// `parseEnv(source)` is a pure function (takes the env object as a
// parameter) specifically so these tests never touch the real
// process.env — see lib/infra/env.ts's header comment for why.

import { describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/infra/env";

const VALID_BASE = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

// A REAL production deployment talks to a REMOTE database. NODE_ENV=production
// against the LOCAL db (VALID_BASE) is `next start` QA, which must NOT require
// the prod-only secrets — the prod-only requirements key on the remote DB.
const REMOTE_DB = "postgresql://user:pass@db.prod.example.com:5432/dim";

describe("lib/env parseEnv", () => {
  it("parses a complete, valid dev env without throwing", () => {
    const env = parseEnv({ ...VALID_BASE, NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe(VALID_BASE.DATABASE_URL);
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe(VALID_BASE.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  });

  it("throws naming DATABASE_URL when it is missing", () => {
    const { DATABASE_URL: _omit, ...rest } = VALID_BASE;
    expect(() => parseEnv({ ...rest, NODE_ENV: "development" } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it("throws naming NEXT_PUBLIC_SUPABASE_ANON_KEY when it is missing", () => {
    const { NEXT_PUBLIC_SUPABASE_ANON_KEY: _omit, ...rest } = VALID_BASE;
    expect(() => parseEnv({ ...rest, NODE_ENV: "development" } as NodeJS.ProcessEnv)).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });

  it("lists every missing var in a single thrown error when several are absent", () => {
    let thrown: unknown;
    try {
      parseEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(message).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("does NOT require CRON_SECRET, DNI_HASH_PEPPER, or NEXT_PUBLIC_SITE_URL outside production", () => {
    expect(() =>
      parseEnv({ ...VALID_BASE, NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() => parseEnv({ ...VALID_BASE, NODE_ENV: "test" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("requires CRON_SECRET, DNI_HASH_PEPPER, and NEXT_PUBLIC_SITE_URL on a remote-DB production deploy", () => {
    const prodDeploy = { ...VALID_BASE, DATABASE_URL: REMOTE_DB, NODE_ENV: "production" };
    expect(() => parseEnv(prodDeploy as NodeJS.ProcessEnv)).toThrow(/CRON_SECRET/);
    expect(() => parseEnv(prodDeploy as NodeJS.ProcessEnv)).toThrow(/DNI_HASH_PEPPER/);
    expect(() => parseEnv(prodDeploy as NodeJS.ProcessEnv)).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it("does NOT require prod-only vars in production MODE against a LOCAL db (next start QA)", () => {
    // The boot-500 fix: `next start` runs NODE_ENV=production against the local
    // Supabase — prod-only secrets rely on the dev fallbacks, must not throw.
    expect(() =>
      parseEnv({ ...VALID_BASE, NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("parses successfully on a production deploy once all prod-only vars are set", () => {
    const env = parseEnv({
      ...VALID_BASE,
      DATABASE_URL: REMOTE_DB,
      NODE_ENV: "production",
      CRON_SECRET: "prod-cron-secret",
      DNI_HASH_PEPPER: "a-real-production-pepper-value",
      NEXT_PUBLIC_SITE_URL: "https://mimar.example.com",
    } as NodeJS.ProcessEnv);
    expect(env.CRON_SECRET).toBe("prod-cron-secret");
  });

  it("rejects the public dev-default DNI pepper on a production deploy", () => {
    expect(() =>
      parseEnv({
        ...VALID_BASE,
        DATABASE_URL: REMOTE_DB,
        NODE_ENV: "production",
        CRON_SECRET: "prod-cron-secret",
        DNI_HASH_PEPPER: "dim-test-pepper-v1",
        NEXT_PUBLIC_SITE_URL: "https://mimar.example.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DNI_HASH_PEPPER/);
  });

  it("rejects a malformed NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(() =>
      parseEnv({
        ...VALID_BASE,
        NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
