// DNI pepper fail-closed guard (deploy-readiness residual, 2026-07-04).
// ====================================================================
//
// getPepper() must REFUSE to hash DNIs in production when the pepper is unset
// or still the public committed dev default — hashing the 7-8 digit Argentine
// DNI space with a known pepper makes every stored hash rainbow-reversible.
//
// The guard fires on a REAL production DEPLOYMENT = NODE_ENV="production" AND a
// REMOTE database (any host: Vercel or self-hosted). `next start` for local QA
// runs in production mode against the LOCAL Supabase and must keep the dev-pepper
// fallback — otherwise the local production-mode server 500s at boot. These tests
// pin that contract: a remote-DB prod deploy fails closed; local prod-mode QA and
// test keep the dev-pepper fallback.

import { afterEach, describe, expect, it, vi } from "vitest";

import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

const DNI = "30123456";
const HEX_64 = /^[0-9a-f]{64}$/;
const REMOTE_DB = "postgres://user:pass@db.prod.example.com:5432/dim";
const LOCAL_DB = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

describe("dni-hash pepper fail-closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws on a remote-DB production deploy when DNI_HASH_PEPPER is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(() => hashDni(DNI)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("throws on a remote-DB production deploy when DNI_HASH_PEPPER is still the public dev default", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    expect(() => hashDni(DNI)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("fails closed on a self-hosted (non-Vercel) production deploy — keyed on the remote DB, not VERCEL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(() => hashDni(DNI)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("hashes on a production deploy when a non-default secret pepper is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "a-real-kms-managed-secret-v1");
    expect(hashDni(DNI)).toMatch(HEX_64);
  });

  it("does NOT throw in production MODE against a LOCAL db (next start QA) — keeps the dev fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("DATABASE_URL", LOCAL_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(hashDni(DNI)).toMatch(HEX_64);
  });

  it("keeps the dev-pepper fallback outside production (local/test unchanged)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(hashDni(DNI)).toMatch(HEX_64);
  });

  // ---------------------------------------------------------------------------
  // Second, independent trigger (audit 2026-08-12).
  //
  // Keying the guard ONLY on NODE_ENV left a residual: a real deployment that
  // never sets NODE_ENV, or whose DATABASE_URL happens to contain the substring
  // "localhost", fell back to the COMMITTED dev pepper in silence — and every
  // DNI hashed under a known pepper is rainbow-table reversible across a ~10^8
  // space. Running on a deploy platform is decisive on its own.
  // ---------------------------------------------------------------------------

  it("throws on Vercel even when NODE_ENV is NOT production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(() => hashDni(DNI)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("throws on Vercel even when DATABASE_URL contains the substring 'localhost'", () => {
    // The isLocalDb escape hatch exists for `next start` QA. There is no such
    // case on a deploy platform, so it must not apply there.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", LOCAL_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(() => hashDni(DNI)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("throws on Vercel when the pepper is explicitly set to the public dev default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    expect(() => hashDni(DNI)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("hashes on Vercel once a real secret pepper is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "a-real-secret-from-the-deploy-env");
    expect(hashDni(DNI)).toMatch(HEX_64);
  });
});

// ---------------------------------------------------------------------------
// Invariant #5 output contracts (mutation-survivor closure, 2026-07 audit).
//
// These assert LITERALS, never values derived from the module under test:
// a mutant that changes the slice bounds, swaps HMAC for a plain hash, drops
// the pepper, or hashes the pepper with the DNI as key must FAIL here. Before
// this block a raw-DNI leak in dniLast4 (e.g. returning the full DNI) shipped
// green through the whole suite.
// ---------------------------------------------------------------------------

describe("dniLast4 — display contract (no plaintext DNI, invariant #5)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns exactly the last 4 digits as a literal", () => {
    expect(dniLast4("30123456")).toBe("3456");
    expect(dniLast4("7654321")).toBe("4321"); // 7-digit DNI
    expect(dniLast4("99000111")).toBe("0111"); // preserves leading zero in the tail
  });

  it("never returns more than 4 characters for any realistic DNI (7-8 digits)", () => {
    for (const dni of ["1234567", "12345678", "7000001", "45999888", "30123456"]) {
      const out = dniLast4(dni);
      expect(out).toHaveLength(4);
      expect(dni.endsWith(out)).toBe(true);
      // The full DNI must never come back — that IS the plaintext leak.
      expect(out).not.toBe(dni);
    }
  });
});

describe("hashDni — pinned HMAC vector (mutation gate)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // HMAC-SHA256("30123456", "dim-test-pepper-v1") — computed independently with
  // node:crypto. A LITERAL, so any change to the algorithm, key/message order,
  // or pepper resolution fails this test loudly.
  const PINNED_VECTOR = "e78b8a5b794fa9033d0f5ffdb43d1e3d648ce0ab442f4fc92a74cd114c6f344a";

  it("matches the known vector under the fixed test pepper", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    expect(hashDni("30123456")).toBe(PINNED_VECTOR);
  });

  it("produces a DIFFERENT hash when the pepper differs (pepper actually participates)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DNI_HASH_PEPPER", "another-pepper");
    const other = hashDni("30123456");
    expect(other).toMatch(HEX_64);
    expect(other).not.toBe(PINNED_VECTOR);
    // Independently-computed literal for the alternate pepper.
    expect(other).toBe("b4b5282d64f8a97ab32d638ac284e7c412736aaf7e02890db3b92d37bccf9785");
  });
});
