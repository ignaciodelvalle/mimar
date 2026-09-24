// Tag activation-code hashing (physical-tag-lifecycle D2).
//
// Mirrors dni-hash-pepper.test.ts: fail-closed prod gate, determinism, and —
// the design's load-bearing property — DOMAIN SEPARATION: the same input
// string hashed as a tag code and as a DNI must produce different digests
// even under the same pepper, because the tag path prepends
// "tag-activation-code:v1:" to the message.

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashDni } from "@/lib/utils/dni-hash";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";

const CODE = "WXYZ-6789";
const HEX_64 = /^[0-9a-f]{64}$/;
const REMOTE_DB = "postgres://user:pass@db.prod.example.com:5432/dim";
const LOCAL_DB = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

describe("hashTagActivationCode — determinism and normalization", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is deterministic: same code + pepper → same digest", () => {
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    const a = hashTagActivationCode(CODE);
    const b = hashTagActivationCode(CODE);
    expect(a).toMatch(HEX_64);
    expect(a).toBe(b);
  });

  it("normalizes trim + case so wrapper-typed input matches the issued code", () => {
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    expect(hashTagActivationCode("  wxyz-6789 ")).toBe(hashTagActivationCode("WXYZ-6789"));
  });

  it("matches an independently-computed HMAC over the domain-separated message", () => {
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    const expected = createHmac("sha256", "dim-test-pepper-v1")
      .update(`tag-activation-code:v1:${CODE}`)
      .digest("hex");
    expect(hashTagActivationCode(CODE)).toBe(expected);
  });

  it("pepper actually participates: different pepper → different digest", () => {
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    const a = hashTagActivationCode(CODE);
    vi.unstubAllEnvs();
    vi.stubEnv("DNI_HASH_PEPPER", "another-pepper");
    expect(hashTagActivationCode(CODE)).not.toBe(a);
  });
});

describe("hashTagActivationCode — domain separation from hashDni (D2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("same input, same pepper, DIFFERENT digest than hashDni", () => {
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    // Digits-only input so it is a plausible argument to BOTH helpers.
    const input = "30123456";
    expect(hashTagActivationCode(input)).not.toBe(hashDni(input));
  });
});

describe("hashTagActivationCode — pepper fail-closed prod gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws on a remote-DB production deploy when DNI_HASH_PEPPER is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(() => hashTagActivationCode(CODE)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("throws on a remote-DB production deploy when the pepper is still the public dev default", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "dim-test-pepper-v1");
    expect(() => hashTagActivationCode(CODE)).toThrow(/DNI_HASH_PEPPER/);
  });

  it("does NOT throw in production MODE against a LOCAL db (next start QA)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", LOCAL_DB);
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(hashTagActivationCode(CODE)).toMatch(HEX_64);
  });

  it("keeps the dev-pepper fallback outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DNI_HASH_PEPPER", "");
    expect(hashTagActivationCode(CODE)).toMatch(HEX_64);
  });
});
