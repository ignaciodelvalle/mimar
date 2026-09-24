// Pins e2e/_credentials.ts — which password an e2e login uses, and which
// logins may happen at all, on a local vs. a remote origin (C4b and its
// security review, 2026-09-23). Logic inside a Playwright spec is logic
// nobody can unit-test, so the decision lives in this pure module.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_LITERAL_PASSWORD,
  ROTATED_E2E_ACCOUNTS,
  isLocalOrigin,
  passwordForPage,
  passwordForSupabaseUrl,
  remoteLoginRefusal,
} from "@/e2e/_credentials";
import { E2E_ACCOUNTS } from "@/scripts/ops/_rotate-e2e-password";
import { ZERO_PET_OWNER_EMAIL } from "@/scripts/seed-reserved-accounts";

const STAGING = "https://dim-staging.vercel.app/iniciar-sesion";
const OWNER = "owner@dim.test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLocalOrigin", () => {
  it.each([
    "http://localhost:3333/iniciar-sesion",
    "http://127.0.0.1:54321",
    "http://[::1]:3000/",
    "http://LOCALHOST:3000",
  ])("local: %s", (url) => {
    expect(isLocalOrigin(url)).toBe(true);
  });

  it.each([
    STAGING,
    "https://localhost.example.com/",
    "https://127.0.0.1.attacker.example/",
    "https://example.com/?next=http://localhost",
    "not a url",
    "",
  ])("remote (or unparseable, fail closed): %s", (url) => {
    expect(isLocalOrigin(url)).toBe(false);
  });
});

describe("passwordForPage / passwordForSupabaseUrl", () => {
  it("local uses the literal, whatever the env says", () => {
    vi.stubEnv("E2E_STAGING_PASSWORD", "rotated-value");
    expect(passwordForPage("http://localhost:3333/iniciar-sesion", OWNER)).toBe(
      LOCAL_LITERAL_PASSWORD,
    );
    expect(passwordForSupabaseUrl("http://127.0.0.1:54321", OWNER)).toBe(LOCAL_LITERAL_PASSWORD);
  });

  it("remote uses E2E_STAGING_PASSWORD", () => {
    vi.stubEnv("E2E_STAGING_PASSWORD", "rotated-value");
    expect(passwordForPage(STAGING, OWNER)).toBe("rotated-value");
    expect(passwordForSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co", OWNER)).toBe(
      "rotated-value",
    );
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("remote throws when E2E_STAGING_PASSWORD is %s", (_label, value) => {
    vi.stubEnv("E2E_STAGING_PASSWORD", value);
    expect(() => passwordForPage(STAGING, OWNER)).toThrow(/E2E_STAGING_PASSWORD/);
  });

  it("remote refuses the published literal even when it is the env value", () => {
    vi.stubEnv("E2E_STAGING_PASSWORD", LOCAL_LITERAL_PASSWORD);
    expect(() => passwordForPage(STAGING, OWNER)).toThrow(/literal/);
  });

  it("a remote host that merely contains 'localhost' is remote", () => {
    vi.stubEnv("E2E_STAGING_PASSWORD", undefined);
    expect(() => passwordForPage("https://localhost.example.com/iniciar-sesion", OWNER)).toThrow();
  });

  it("local hands the literal to ANY account — the local DB is the suite's own", () => {
    expect(passwordForPage("http://localhost:3333/iniciar-sesion", "admin@dim.test")).toBe(
      LOCAL_LITERAL_PASSWORD,
    );
  });

  it.each(["admin@dim.test", "govt@dim.test", ZERO_PET_OWNER_EMAIL])(
    "remote refuses non-rotated %s BEFORE reading E2E_STAGING_PASSWORD",
    (email) => {
      vi.stubEnv("E2E_STAGING_PASSWORD", "rotated-value");
      expect(() => passwordForPage(STAGING, email)).toThrow(/not one of the rotated/);
      expect(() =>
        passwordForSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co", email),
      ).toThrow(/not one of the rotated/);
    },
  );

  it("the refusal never echoes the rotated password", () => {
    vi.stubEnv("E2E_STAGING_PASSWORD", "rotated-value");
    expect(() => passwordForPage(STAGING, "admin@dim.test")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("rotated-value") }),
    );
  });

  it("the error never echoes the literal", () => {
    vi.stubEnv("E2E_STAGING_PASSWORD", undefined);
    expect(() => passwordForPage(STAGING, OWNER)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(LOCAL_LITERAL_PASSWORD),
      }),
    );
  });
});

describe("remoteLoginRefusal — only rotated accounts sign in remotely", () => {
  it("allows every account locally", () => {
    expect(remoteLoginRefusal("http://localhost:3333/", "admin@dim.test")).toBeNull();
    expect(remoteLoginRefusal("http://localhost:3333/", "govt@dim.test")).toBeNull();
  });

  it.each([...ROTATED_E2E_ACCOUNTS])("allows rotated %s remotely", (email) => {
    expect(remoteLoginRefusal(STAGING, email)).toBeNull();
  });

  it.each(["admin@dim.test", "govt@dim.test", "govt-local@dim.test", "nacional@dim.test"])(
    "refuses non-rotated %s remotely",
    (email) => {
      expect(remoteLoginRefusal(STAGING, email)).toMatch(/not one of the rotated/);
    },
  );

  it("is case-insensitive on the email", () => {
    expect(remoteLoginRefusal(STAGING, "OWNER@dim.test")).toBeNull();
  });
});

describe("the rotated list and the rotation script agree", () => {
  it("names the same 8 accounts in both places", () => {
    expect([...ROTATED_E2E_ACCOUNTS].sort()).toEqual([...E2E_ACCOUNTS].sort());
    expect(ROTATED_E2E_ACCOUNTS).toHaveLength(8);
  });
});
